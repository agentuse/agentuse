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
  it('offers only the read tools and run_agent', async () => {
    client = await connect(fakeDaemon({}).daemon);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['get_agent', 'get_session', 'list_agents', 'list_problems', 'list_projects', 'list_sessions', 'run_agent'],
    );
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    expect(readOnly).not.toContain('run_agent');
    expect(readOnly).toHaveLength(6);
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
