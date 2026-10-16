import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpToolError, type DaemonClient } from '../src/mcp-server/daemon';
import { createAgentUseMcpServer } from '../src/mcp-server/server';

// A fake daemon answering the same /api routes `agentuse serve` does, so the
// tools are tested against recorded payload shapes without a live server.
type Call = { method: 'GET' | 'POST'; path: string; query?: Record<string, string | undefined>; body?: unknown };

const row = (overrides: Record<string, unknown>) => ({
  sessionId: 's1',
  agent: { id: 'agents/digest', name: 'Digest', filePath: '/work/eng/agents/digest.agentuse', runPath: 'agents/digest.agentuse' },
  status: 'completed',
  trigger: 'scheduled',
  createdAt: Date.parse('2026-10-14T09:00:00Z'),
  updatedAt: Date.parse('2026-10-14T09:01:00Z'),
  project: 'eng',
  ...overrides,
});

function fakeDaemon(routes: Record<string, (call: Call) => unknown>): { daemon: DaemonClient; calls: Call[] } {
  const calls: Call[] = [];
  const answer = (call: Call) => {
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) throw new McpToolError('NOT_FOUND', `No route ${call.method} ${call.path}`);
    return handler(call);
  };
  return {
    calls,
    daemon: {
      get: async <T>(path: string, query?: Record<string, string | undefined>) => answer({ method: 'GET', path, ...(query && { query }) }) as T,
      post: async <T>(path: string, body: unknown) => answer({ method: 'POST', path, body }) as T,
    },
  };
}

const serverInfo = () => ({
  default: null,
  projects: [
    { id: 'eng', path: '/work/eng', agentCount: 2, about: { name: 'Eng tools', description: 'Team helpers' } },
    { id: 'home', path: '/work/home', agentCount: 0 },
  ],
});

let client: Client;

async function connect(daemon: DaemonClient): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createAgentUseMcpServer(daemon).connect(serverTransport);
  const connected = new Client({ name: 'test', version: '0.0.0' });
  await connected.connect(clientTransport);
  return connected;
}

const call = async (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text: string }> }>;

const savedServeUrl = process.env.AGENTUSE_SERVE_URL;
beforeEach(() => {
  // Links are built from this base so tests never read the real server registry.
  process.env.AGENTUSE_SERVE_URL = 'http://agentuse.test';
});
afterEach(async () => {
  await client?.close();
  if (savedServeUrl === undefined) delete process.env.AGENTUSE_SERVE_URL;
  else process.env.AGENTUSE_SERVE_URL = savedServeUrl;
});

describe('agentuse MCP server', () => {
  it('offers read tools, run_agent, and tools that only propose', async () => {
    client = await connect(fakeDaemon({}).daemon);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['draft_agent', 'get_agent', 'get_project', 'get_session', 'list_agents', 'list_problems', 'list_projects', 'list_sessions', 'propose_fix', 'read_project_file', 'run_agent', 'test_draft'],
    );
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    expect(readOnly.sort()).toEqual(['get_agent', 'get_project', 'get_session', 'list_agents', 'list_problems', 'list_projects', 'list_sessions', 'read_project_file']);
  });

  it('lists projects by name without their paths', async () => {
    client = await connect(fakeDaemon({ 'GET ': serverInfo }).daemon);
    const result = await call('list_projects');
    expect(result.structuredContent?.projects).toEqual([
      { id: 'eng', name: 'Eng tools', description: 'Team helpers', agent_count: 2 },
      { id: 'home', name: 'home', agent_count: 0 },
    ]);
    expect(JSON.stringify(result)).not.toContain('/work/');
  });

  it('filters agents to one project and marks paused schedules', async () => {
    client = await connect(fakeDaemon({
      'GET /agents': () => ({
        agents: [
          { projectId: 'eng', path: 'agents/digest.agentuse', runPath: 'agents/digest.agentuse', name: 'Digest', model: 'anthropic:x', schedule: '0 9 * * 1', scheduleHuman: 'Mondays 9:00', scheduleEnabled: false },
          { projectId: 'home', path: 'a.agentuse', runPath: 'a.agentuse', name: 'A', model: 'anthropic:x' },
        ],
      }),
    }).daemon);
    const result = await call('list_agents', { project: 'eng' });
    expect(result.structuredContent?.agents).toEqual([
      { project: 'eng', agent: 'agents/digest.agentuse', name: 'Digest', model: 'anthropic:x', schedule: 'Mondays 9:00', schedule_on: false },
    ]);
    expect(result.content[0]!.text).toContain('paused');
  });

  it('groups open failures by agent and cause, newest first, with links', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'GET /sessions': ({ query }) => ({
        sessions: query?.status === 'error'
          ? [
            row({ sessionId: 'e1', status: 'error', errorCause: 'mcp_auth', updatedAt: Date.parse('2026-10-14T09:00:00Z') }),
            row({ sessionId: 'e2', status: 'error', errorCause: 'mcp_auth', updatedAt: Date.parse('2026-10-15T09:00:00Z') }),
          ]
          : [row({ sessionId: 'i1', status: 'error', errorCode: 'INCOMPLETE', project: 'home', updatedAt: Date.parse('2026-10-13T09:00:00Z') })],
        counts: {},
      }),
    });
    client = await connect(daemon);
    const result = await call('list_problems');
    const problems = result.structuredContent?.problems as Array<Record<string, any>>;
    expect(problems.map((p) => [p.project, p.cause, p.count, p.latest.session_id])).toEqual([
      ['eng', 'mcp_auth', 2, 'e2'],
      ['home', 'INCOMPLETE', 1, 'i1'],
    ]);
    expect(problems[0]!.latest.url).toBe('http://agentuse.test/sessions/e2');
    const sessionQueries = calls.filter((c) => c.path === '/sessions').map((c) => c.query);
    expect(sessionQueries).toContainEqual(expect.objectContaining({ status: 'error', triage: 'undismissed', window: '30d' }));
    expect(sessionQueries).toContainEqual(expect.objectContaining({ status: 'incomplete', triage: 'undismissed', window: '30d' }));
  });

  it('trims long answers in list_sessions', async () => {
    client = await connect(fakeDaemon({
      'GET ': serverInfo,
      'GET /sessions': () => ({ sessions: [row({ finalResponse: 'x'.repeat(1_000) })], counts: { all: 1 } }),
    }).daemon);
    const result = await call('list_sessions');
    const [session] = result.structuredContent?.sessions as Array<Record<string, any>>;
    expect(session!.final_response.length).toBeLessThan(300);
    expect(session!.agent).toBe('agents/digest.agentuse');
    expect(JSON.stringify(result)).not.toContain('/work/');
  });

  it('filters runs to the exact agent the chat named', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'GET /sessions': () => ({
        sessions: [
          row({ sessionId: 'a' }),
          row({ sessionId: 'b', agent: { id: 'agents/digest-weekly', name: 'Weekly', runPath: 'agents/digest-weekly.agentuse' } }),
        ],
        counts: {},
      }),
    });
    client = await connect(daemon);
    const result = await call('list_sessions', { agent: 'agents/digest.agentuse' });
    expect((result.structuredContent?.sessions as Array<Record<string, any>>).map((s) => s.session_id)).toEqual(['a']);
    expect(calls.find((c) => c.path === '/sessions')?.query?.agent).toBe('agents/digest');
  });

  it('starts a detached run and returns its link', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'POST /run': () => ({ success: true, sessionId: 'run1', status: 'running' }),
    });
    client = await connect(daemon);
    const result = await call('run_agent', { project: 'eng', agent: 'agents/digest.agentuse' });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ project: 'eng', agent: 'agents/digest.agentuse', detach: true });
    expect(result.structuredContent).toMatchObject({ session_id: 'run1', url: 'http://agentuse.test/sessions/run1' });
  });

  it('saves a draft as a chat change set and returns an absolute review link', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'POST /projects/eng/changesets': () => ({
        success: true,
        changeset: {
          sessionId: 'CS1',
          status: 'proposed',
          projectRoot: '/work/eng',
          proposals: [{ index: 1, entry: 'agents/note.agentuse', files: [{ path: 'agents/note.agentuse', op: 'add', kind: 'agent', baseHash: null, hash: 'h', capabilityChanges: ['Runtime model added: x'] }] }],
        },
        reviewHref: '/projects/eng/changesets/CS1?token=t',
      }),
    });
    client = await connect(daemon);
    const files = [{ path: 'agents/note.agentuse', content: '---\nname: note\n---\nHi' }];
    const result = await call('draft_agent', { project: 'eng', goal: 'Daily note', summary: 'Writes a note.', entry: 'agents/note.agentuse', files, schedule: '0 8 * * 1-5' });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      source: 'chat', author: 'test (chat)', mode: 'create', instruction: 'Daily note', summary: 'Writes a note.', entry: 'agents/note.agentuse', files, schedule: '0 8 * * 1-5',
    });
    expect(result.structuredContent).toEqual({
      draft_id: 'CS1',
      status: 'proposed',
      review_url: 'http://agentuse.test/projects/eng/changesets/CS1?token=t',
      files: [{ path: 'agents/note.agentuse', op: 'add', capability_changes: ['Runtime model added: x'] }],
    });
    expect(JSON.stringify(result)).not.toContain('/work/');
  });

  it('proposes a fix as a revise change set aimed at the agent', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'POST /projects/eng/changesets': () => ({
        success: true,
        changeset: { sessionId: 'FX1', status: 'proposed', proposals: [{ index: 2, files: [] }] },
        reviewHref: '/projects/eng/changesets/FX1',
      }),
    });
    client = await connect(daemon);
    const files = [{ path: 'agents/digest.agentuse', content: 'x' }];
    const result = await call('propose_fix', {
      project: 'eng', agent: 'agents/digest.agentuse', problem: 'Login expired', summary: 'Uses the new token.', files, from_session: 'e2', fix_id: 'FX1',
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      mode: 'revise', target: 'agents/digest.agentuse', entry: 'agents/digest.agentuse', originSessionId: 'e2', changesetId: 'FX1',
    });
    expect(result.structuredContent).toMatchObject({ fix_id: 'FX1', review_url: 'http://agentuse.test/projects/eng/changesets/FX1' });
  });

  it('cannot turn a crafted project id into another daemon route', async () => {
    const reached: string[] = [];
    const raw: DaemonClient = {
      get: async <T>(path: string) => { reached.push(`GET ${path}`); return serverInfo() as T; },
      post: async <T>(path: string) => { reached.push(`POST ${path}`); return {} as T; },
    };
    // The project id is caller-controlled; a crafted one must not turn the
    // change set route into an apply route.
    client = await connect(raw);
    const result = await call('draft_agent', {
      project: 'eng/changesets/CS1/apply#', goal: 'x', summary: 'x', entry: 'a.agentuse', files: [{ path: 'a.agentuse', content: 'x' }],
    });
    // The id is encoded into one path segment, so the only route reached is
    // the change set create route, which then fails to find that project.
    expect(reached.filter((r) => r.startsWith('POST'))).toEqual(['POST /projects/eng%2Fchangesets%2FCS1%2Fapply%23/changesets']);
    expect(result.isError).toBe(true);
  });

  it('asks the daemon for only the project context parts the chat wants', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET /projects/eng/context': () => ({ success: true, project: 'eng', agents: [{ agent: 'a.agentuse' }], mcpServers: [], files: { entries: [], truncated: false } }),
    });
    client = await connect(daemon);
    const result = await call('get_project', { project: 'eng', include: ['agents', 'files'], path: 'reports' });
    expect(calls[0]!.query).toEqual({ include: 'agents,files', path: 'reports' });
    expect(result.structuredContent).toEqual({ project: 'eng', agents: [{ agent: 'a.agentuse' }], mcpServers: [], files: { entries: [], truncated: false } });
    expect(result.content[0]!.text).toBe('eng: 1 agents, 0 MCP servers');
  });

  it('reads a file and says when it was cut or redacted', async () => {
    client = await connect(fakeDaemon({
      'GET /projects/eng/files': ({ query }) => ({ success: true, path: query?.path, content: 'key = [REDACTED]', bytes: 16, truncated: true, redacted: true }),
    }).daemon);
    const result = await call('read_project_file', { project: 'eng', path: 'config.yaml' });
    expect(result.content[0]!.text).toBe('key = [REDACTED]\n\n[cut at 60 KB; secret-looking values redacted]');
    expect(result.structuredContent).toMatchObject({ path: 'config.yaml', truncated: true, redacted: true });
  });

  it('passes a refused read through as NOT_READABLE', async () => {
    client = await connect(fakeDaemon({
      'GET /projects/eng/files': () => { throw new McpToolError('NOT_READABLE', 'That file is not readable'); },
    }).daemon);
    const result = await call('read_project_file', { project: 'eng', path: '.env' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe('NOT_READABLE');
  });

  it('offers /automate and /triage with the installed authoring guide', async () => {
    client = await connect(fakeDaemon({}).daemon);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['automate', 'triage']);
    const automate = await client.getPrompt({ name: 'automate', arguments: { goal: 'Weekly digest' } });
    const automateText = (automate.messages[0]!.content as { text: string }).text;
    // One source: the prompt is the built-in automate skill, run in chat mode.
    expect(automateText).toContain('Use chat mode of the skill below');
    expect(automateText).toContain('# Automate with AgentUse');
    expect(automateText).toContain('`draft_agent`');
    expect(automateText).toContain("The user's goal: Weekly digest");
    expect(automateText).toContain('# AgentUse Creator');
    const audit = await client.getPrompt({ name: 'triage', arguments: { audit_only: 'yes' } });
    expect((audit.messages[0]!.content as { text: string }).text).toContain('Do not call propose_fix');
  });

  it('starts only the all-mocked practice run, never the live test run', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'POST /projects/eng/changesets/CS1/mock-test': () => ({ success: true, testRun: { sessionId: 'T1' } }),
    });
    client = await connect(daemon);
    const result = await call('test_draft', { project: 'eng', id: 'CS1' });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/projects/eng/changesets/CS1/mock-test']);
    expect(result.structuredContent).toMatchObject({ session_id: 'T1', mock: true, url: 'http://agentuse.test/sessions/T1' });
  });

  it('turns a daemon failure into a tool error with its code', async () => {
    client = await connect({
      get: async () => { throw new McpToolError('NO_SERVER', 'AgentUse is not running on this computer.'); },
      post: async () => { throw new Error('unused'); },
    });
    const result = await call('list_projects');
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toEqual({ code: 'NO_SERVER', message: 'AgentUse is not running on this computer.' });
  });
});
