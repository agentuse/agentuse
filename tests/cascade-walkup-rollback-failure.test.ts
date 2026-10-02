/**
 * When a cascade walk-up's resume setup fails for a parent and the bookmark
 * rollback itself also fails, the parent must not be left `running` with this
 * live worker as its owner: orphan reconcile skips a live owner, so the run
 * would sit "running" until the worker dies. It is settled as failed instead,
 * with its bookmark still resolved and no approval lease left behind.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fail the parent's resumed run in setup, after its bookmark was completed.
mock.module('../src/mcp', () => ({
  connectMCP: async () => {
    throw new Error('MCP setup failed');
  },
  getMCPTools: async () => ({}),
}));

const originalXdg = process.env.XDG_DATA_HOME;
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-cascade-walkup-rollback-'));
  process.env.XDG_DATA_HOME = root;
});

afterAll(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  await rm(root, { recursive: true, force: true });
  mock.restore();
});

describe('cascade walk-up with a failed bookmark rollback', () => {
  test('settles the parent as failed instead of leaving it running', async () => {
    const { initStorage } = await import('../src/storage');
    const { SessionManager } = await import('../src/session');
    const { LeaseStore } = await import('../src/runner/approval-lease');
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
    // A grant left over from an earlier approval of the parent's own gate.
    const sessionDir = await manager.getSessionDirectory(parentId, agentId);
    expect(new LeaseStore(sessionDir).grant({ version: 1, grantedAt: Date.now(), entries: [{ content: 'echo publish' }] })).toBe(true);

    // The rollback's write back to the pending bookmark fails.
    const originalUpdatePart = manager.updatePart.bind(manager);
    manager.updatePart = (async (...args: Parameters<typeof originalUpdatePart>) => {
      if ((args[4] as { state?: { status?: string } }).state?.status === 'pending') {
        throw new Error('disk full');
      }
      return originalUpdatePart(...args);
    }) as typeof manager.updatePart;

    const walkError = await walkUpCascadeChain({
      ctx: createWorkerContext(),
      sessionManager: manager,
      ancestors: [{ sessionId: parentId, agentId, agentName: 'manager' }],
      childSessionId: childId,
      childAgentName: 'worker',
      childResult: { text: 'work done' },
      projectRoot: root,
      abortController: new AbortController(),
      startTime: Date.now(),
    }).then(() => undefined, (error: unknown) => error);

    // The setup failure still propagates, not the rollback's.
    expect(walkError).toBeInstanceOf(Error);
    expect((walkError as Error).message).toContain('MCP setup failed');

    const final = await new SessionManager().findSession(parentId);
    const bookmark = await manager.getPart(parentId, agentId, messageId, partId);
    expect(final?.session.status).toBe('error');
    expect(final?.session.error?.code).toBe('CASCADE_ROLLBACK_FAILED');
    expect(final?.session.error?.message).toContain('disk full');
    expect(bookmark?.type === 'tool' ? bookmark.state.status : undefined).toBe('completed');
    expect(new LeaseStore(sessionDir).read()).toBeUndefined();
  });
});
