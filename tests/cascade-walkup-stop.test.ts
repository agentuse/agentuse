/**
 * A user Stop on a cascade parent that lands after the walk-up completed its
 * sub-agent bookmark, but before the parent's resumed run started, must stay
 * terminal. The walk-up's setup-failure rollback used to mark the parent
 * suspended again unconditionally, after the rollback itself had correctly
 * left the stopped session alone.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let enteredConnect!: () => void;
let failConnect!: (error: Error) => void;
const connectEntered = new Promise<void>((resolve) => { enteredConnect = resolve; });
const connectFailure = new Promise<never>((_resolve, reject) => { failConnect = reject; });

// Hold the parent's resumed run in setup, after its bookmark was completed.
mock.module('../src/mcp', () => ({
  connectMCP: async () => {
    enteredConnect();
    return await connectFailure;
  },
  getMCPTools: async () => ({}),
}));

const originalXdg = process.env.XDG_DATA_HOME;
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-cascade-walkup-stop-'));
  process.env.XDG_DATA_HOME = root;
});

afterAll(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  await rm(root, { recursive: true, force: true });
  mock.restore();
});

describe('cascade walk-up vs user Stop', () => {
  test('a parent stopped during its resume setup stays stopped', async () => {
    const { initStorage } = await import('../src/storage');
    const { SessionManager } = await import('../src/session');
    const { createWorkerContext } = await import('../src/worker/context');
    const { walkUpCascadeChain } = await import('../src/worker/cascade');

    await initStorage(root);
    const manager = new SessionManager();
    const agentId = 'agents/manager';
    const agentPath = join(root, 'manager.agentuse');
    await writeFile(agentPath, '---\nname: manager\nmodel: demo:test\n---\nDelegate the work.\n');
    const parentId = await manager.createSession({
      agent: { id: agentId, name: 'manager', filePath: agentPath, isSubAgent: false },
      model: 'demo:test',
      version: 'test',
      config: {},
      project: { root, cwd: root },
    });
    const messageId = await manager.createMessage(parentId, agentId, {
      user: { prompt: { task: 'delegate' } },
      assistant: {
        system: ['system'],
        modelID: 'test',
        providerID: 'demo',
        mode: 'build',
        path: { cwd: root, root },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    const childId = 'child-session';
    const partId = await manager.addPart(parentId, agentId, messageId, {
      type: 'tool',
      callID: 'delegate-call',
      tool: 'subagent__worker',
      state: {
        status: 'pending',
        input: { task: 'do the work' },
        suspendedAt: Date.now(),
        resumePayload: { kind: 'subagent_wait', childSessionID: childId },
      },
    } as any);
    await manager.setSessionSuspended(parentId, agentId);

    const walk = walkUpCascadeChain({
      ctx: createWorkerContext(),
      sessionManager: manager,
      ancestors: [{ sessionId: parentId, agentId, agentName: 'manager' }],
      childSessionId: childId,
      childAgentName: 'worker',
      childResult: { text: 'work done' },
      projectRoot: root,
      abortController: new AbortController(),
      startTime: Date.now(),
    });
    const walkSettled = walk.then(() => undefined, (error: unknown) => error);
    await connectEntered;

    await manager.stopSessionTree(parentId, { code: 'USER_STOPPED', message: 'Session stopped by user' });
    failConnect(new Error('MCP setup failed after the stop'));
    expect(await walkSettled).toBeInstanceOf(Error);

    const final = await manager.findSession(parentId);
    const bookmark = await manager.getPart(parentId, agentId, messageId, partId);
    expect(final?.session.status).toBe('error');
    expect(final?.session.error?.code).toBe('USER_STOPPED');
    expect(bookmark?.type === 'tool' ? bookmark.state.status : undefined).toBe('completed');
  });
});
