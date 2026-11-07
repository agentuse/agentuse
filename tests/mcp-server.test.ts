import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpToolError, type DaemonClient } from '../src/mcp-server/daemon';
import { createAgentUseMcpServer } from '../src/mcp-server/server';
import { AUTHORING_RULES_URI, getWorkflowResult, getWorkflowTool, promptsList } from '../src/mcp-server/workflow-text';

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
      ['apply_draft', 'draft_agent', 'get_agent', 'get_project', 'get_run_step', 'get_session', 'get_workflow', 'list_agents', 'list_problems', 'list_projects', 'list_sessions', 'propose_fix', 'read_project_file', 'run_agent', 'test_draft'],
    );
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    expect(readOnly.sort()).toEqual(['get_agent', 'get_project', 'get_run_step', 'get_session', 'get_workflow', 'list_agents', 'list_problems', 'list_projects', 'list_sessions', 'read_project_file']);
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

  it('asks the daemon for one project, so its page and counts are that project alone', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'GET /sessions': () => ({ sessions: [row({ sessionId: 'h1', project: 'home' })], counts: { all: 1 } }),
    });
    client = await connect(daemon);
    const result = await call('list_sessions', { project: 'home', limit: 5 });
    expect(calls.find((c) => c.path === '/sessions')?.query).toMatchObject({ project: 'home', limit: '5' });
    expect((result.structuredContent?.sessions as Array<Record<string, any>>).map((s) => s.session_id)).toEqual(['h1']);
    await call('list_problems', { project: 'home' });
    expect(calls.filter((c) => c.path === '/sessions').slice(1).map((c) => c.query?.project)).toEqual(['home', 'home']);
  });

  // A long run shaped like the one Cloud could not send: big outputs, debug noise, a nested failure, a gate.
  const longRun = () => ({
    session: {
      sessionId: 'r1', project: 'eng', status: 'waiting', summary: 'Approve the reply',
      logs: [
        { id: 'l1', type: 'log', level: 'debug', title: 'debug noise' },
        { id: 'l2', type: 'tool', tool: 'code_exec', callId: 'c1', status: 'error', title: 'code_exec error', details: { input: '{"code":"…"}', errorMessage: 'Code Mode failed: bad input' } },
        { id: 'l3', type: 'tool', tool: 'search', callId: 'c1:n', parentCallId: 'c1', status: 'error', title: 'search error', details: { input: 'i'.repeat(5_000), errorMessage: 'too_big' } },
        ...Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, type: 'tool', tool: 'bash', callId: `b${i}`, status: 'completed', title: `bash ${i}`, details: { input: '{"command":"ls"}', output: 'o'.repeat(30_000) } })),
        { id: 'l4', type: 'text', status: 'completed', title: 'Assistant response', message: 'Here is the draft.' },
        { id: 'l5', type: 'tool', tool: 'await_human', callId: 'g1', status: 'pending', title: 'Pending for approval', details: { prompt: 'Send this reply?' } },
      ],
    },
  });

  it('get_session lists every step with status, input and error, but no outputs', async () => {
    client = await connect(fakeDaemon({ 'GET ': serverInfo, 'GET /sessions/r1': longRun }).daemon);
    const result = await call('get_session', { session_id: 'r1' });
    const s = result.structuredContent!;
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
    expect(s.logs).toBeUndefined();
    expect(s.final_response).toBe('Here is the draft.');
    expect(s.step_count).toBe(65);
    const steps = s.steps as Array<Record<string, any>>;
    expect(steps.map((step) => step.step)).not.toContain(1);
    expect(steps).toHaveLength(64);
    expect(steps[0]).toMatchObject({ step: 2, tool: 'code_exec', status: 'failed', error: 'Code Mode failed: bad input' });
    expect(steps[1]).toMatchObject({ step: 3, status: 'failed', inside: 2 });
    expect(steps[1]!.input).toContain('[cut: 2,000 of 5,000 characters shown]');
    expect(steps[2]).toMatchObject({ step: 4, status: 'ok', output_chars: 30_000 });
    expect(steps[2]!.output).toBeUndefined();
    expect(steps.at(-1)).toMatchObject({ step: 65, tool: 'await_human', status: 'waiting', message: 'Send this reply?' });
    expect(result.content[0]!.text).toContain('3 (inside 2) failed search: search error | error: too_big');
  });

  it('get_run_step returns outputs by step number and lists the ones that did not fit', async () => {
    client = await connect(fakeDaemon({ 'GET ': serverInfo, 'GET /sessions/r1': longRun }).daemon);
    const result = await call('get_run_step', { session_id: 'r1', steps: [3, '4-20', 999] });
    const s = result.structuredContent!;
    const sent = s.steps as Array<Record<string, any>>;
    expect(sent[0]).toMatchObject({ step: 3, inside: 2, error: 'too_big' });
    expect(sent[0]!.input).toHaveLength(5_000);
    expect(sent[1]).toMatchObject({ step: 4, output: 'o'.repeat(30_000) });
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(300_000);
    expect(sent.map((step) => step.step)).toEqual([3, ...Array.from({ length: sent.length - 1 }, (_, i) => 4 + i)]);
    expect(s.not_sent).toEqual(Array.from({ length: 17 - (sent.length - 1) }, (_, i) => 4 + (sent.length - 1) + i));
    expect(s.missing).toEqual([999]);
    expect(result.content[0]!.text).toContain('Ask again for these.');
  });

  it('get_session keeps a very long run under its budget, keeping the failures', async () => {
    const logs = Array.from({ length: 400 }, (_, i) => ({
      id: `t${i}`, type: 'tool', tool: 'bash', callId: `b${i}`, status: i === 200 ? 'error' : 'completed', title: `bash ${i}`,
      details: { input: 'i'.repeat(2_000), ...(i === 200 && { errorMessage: 'exit 1' }) },
    }));
    client = await connect(fakeDaemon({ 'GET ': serverInfo, 'GET /sessions/r2': () => ({ session: { sessionId: 'r2', project: 'eng', status: 'error', logs } }) }).daemon);
    const result = await call('get_session', { session_id: 'r2' });
    const steps = result.structuredContent!.steps as Array<Record<string, any>>;
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(250_000);
    expect(result.structuredContent!.omitted_steps).toBe(400 - steps.length);
    expect(steps.find((step) => step.step === 201)).toMatchObject({ status: 'failed', error: 'exit 1' });
    expect(steps.at(-1)!.step).toBe(400);
  });

  it('get_run_step refuses a range wider than one call should read', async () => {
    client = await connect(fakeDaemon({ 'GET ': serverInfo, 'GET /sessions/r1': longRun }).daemon);
    const result = await call('get_run_step', { session_id: 'r1', steps: ['1-100000'] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe('TOO_MANY_STEPS');
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

  it('runs an agent by the name a person would use, or by what list_agents prints', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'GET /agents': () => ({ agents: [
        { projectId: 'eng', runPath: 'agents/digest.agentuse', name: 'Digest', model: 'anthropic:x' },
        { projectId: 'home', runPath: 'digest.agentuse', name: 'digest', model: 'anthropic:x' },
      ] }),
      'POST /run': () => ({ success: true, sessionId: 'run1', status: 'running' }),
    });
    client = await connect(daemon);
    for (const agent of ['digest', 'Digest', 'agents/digest', 'eng/agents/digest.agentuse']) {
      await call('run_agent', { project: 'eng', agent });
      expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toMatchObject({ agent: 'agents/digest.agentuse' });
    }
  });

  it('hands out links through the option a Cloud request sets', async () => {
    const { daemon } = fakeDaemon({
      'GET ': serverInfo,
      'POST /run': () => ({ success: true, sessionId: 'run1', status: 'running' }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createAgentUseMcpServer(daemon, { link: (url) => `cloud:${new URL(url).pathname}` }).connect(serverTransport);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const result = await call('run_agent', { project: 'eng', agent: 'agents/digest.agentuse' });
    expect(result.structuredContent).toMatchObject({ url: 'cloud:/sessions/run1' });
  });

  it('saves a draft as a chat change set and returns an absolute review link', async () => {
    const { daemon, calls } = fakeDaemon({
      'GET ': serverInfo,
      'POST /projects/eng/changesets': () => ({
        success: true,
        changeset: {
          sessionId: 'CS1',
          status: 'proposed',
          mode: 'create',
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
      project: 'eng',
      kind: 'draft',
      name: 'note',
      can_turn_on_by_yes: true,
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

  it('offers /agentuse, /automate and /triage with the installed authoring guide', async () => {
    client = await connect(fakeDaemon({}).daemon);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['agentuse', 'automate', 'triage']);
    const ask = await client.getPrompt({ name: 'agentuse', arguments: { request: 'list my projects' } });
    const askText = (ask.messages[0]!.content as { text: string }).text;
    expect(askText).toContain('call list_projects first');
    expect(askText).toContain("The user's request: list my projects");
    const automate = await client.getPrompt({ name: 'automate', arguments: { goal: 'Weekly digest' } });
    const automateText = (automate.messages[0]!.content as { text: string }).text;
    expect(automateText).toContain('Call draft_agent');
    expect(automateText).toContain('Never write the agent file anywhere yourself');
    expect(automateText).toContain("The user's goal: Weekly digest");
    expect(automateText).toContain('# AgentUse Creator');
    expect(automateText).toContain('Do not run any `agentuse` command');
    expect(automateText).not.toContain('agentuse skills get');
    const audit = await client.getPrompt({ name: 'triage', arguments: { audit_only: 'yes' } });
    expect((audit.messages[0]!.content as { text: string }).text).toContain('Do not call propose_fix');
  });

  it('serves the same workflows as a tool for apps that do not show prompts', async () => {
    client = await connect(fakeDaemon({}).daemon);
    const automate = await call('get_workflow', { workflow: 'automate', goal: 'Weekly digest' });
    const automateText = (automate.content as Array<{ text: string }>)[0]!.text;
    expect(automateText).toContain('Call draft_agent');
    expect(automateText).toContain("The user's goal: Weekly digest");
    expect(automateText).toContain('# AgentUse Creator');
    const triage = await call('get_workflow', { workflow: 'triage', agent: 'digest' });
    expect((triage.content as Array<{ text: string }>)[0]!.text).toContain('Look only at this agent: digest');
    expect(client.getInstructions()).toContain('call get_workflow first');
  });

  it('lists the prompts, get_workflow and the authoring rules exactly as the cloud copy builds them', async () => {
    client = await connect(fakeDaemon({}).daemon);
    expect((await client.listPrompts()).prompts).toEqual(promptsList());
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'get_workflow')!;
    const { $schema: _schema, ...inputSchema } = listed.inputSchema as Record<string, unknown>;
    expect({ name: listed.name, title: listed.title, description: listed.description, inputSchema, annotations: listed.annotations }).toEqual(getWorkflowTool());
    const rules = await client.readResource({ uri: AUTHORING_RULES_URI });
    const text = (rules.contents[0] as { text: string }).text;
    expect(text).toContain('# AgentUse Creator');
    const workflow = await call('get_workflow', { workflow: 'automate' });
    expect(workflow.content[0]!.text).toBe(getWorkflowResult({ workflow: 'automate' }, text).content[0].text);
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

  it('turns on only through the low-risk apply route, and passes NEEDS_TAP back', async () => {
    let refuse = false;
    const { daemon, calls } = fakeDaemon({
      'POST /projects/eng/changesets/CS1/apply-from-chat': () => {
        if (refuse) throw new McpToolError('NEEDS_TAP', 'This one needs a tap on the review page because it uses MCP services.');
        return { success: true, changeset: { status: 'applied', mode: 'create' } };
      },
    });
    client = await connect(daemon);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'apply_draft')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const applied = await call('apply_draft', { project: 'eng', id: 'CS1' });
    expect(applied.structuredContent).toEqual({ id: 'CS1', status: 'applied' });
    expect(calls.map((c) => c.path)).toEqual(['/projects/eng/changesets/CS1/apply-from-chat']);
    refuse = true;
    const refused = await call('apply_draft', { project: 'eng', id: 'CS1' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.error.code).toBe('NEEDS_TAP');
  });

  it('shows the Turn on card under drafts and fixes', async () => {
    client = await connect(fakeDaemon({}).daemon);
    const { tools } = await client.listTools();
    for (const name of ['draft_agent', 'propose_fix']) {
      const meta = tools.find((tool) => tool.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toBe('ui://agentuse/draft-card');
    }
    const card = await client.readResource({ uri: 'ui://agentuse/draft-card' });
    const content = card.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content.text).toContain('apply_draft');
    expect(content.text).not.toContain('__require');
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
