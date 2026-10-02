/**
 * A resume whose setup fails before its run starts rolls the decision back.
 * When that rollback fails too, the session must not be left `running` with
 * this live worker as owner (orphan reconcile skips live owners, so it would
 * read "running" until the worker died), and a half-applied rollback must not
 * leave a pending gate on a session that already failed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fail every resumed run in setup, after the decision was applied.
mock.module('../src/mcp', () => ({
  connectMCP: async () => {
    throw new Error('MCP setup failed');
  },
  getMCPTools: async () => ({}),
}));

const originalXdg = process.env.XDG_DATA_HOME;
let root = '';
const restorers: Array<() => void> = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-resume-rollback-settle-'));
  process.env.XDG_DATA_HOME = root;
});

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

afterAll(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  await rm(root, { recursive: true, force: true });
  mock.restore();
});

const assistant = () => ({
  system: ['system'],
  modelID: 'test',
  providerID: 'demo',
  mode: 'build',
  path: { cwd: root, root },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

async function createGateSession(
  manager: InstanceType<typeof import('../src/session').SessionManager>,
  name: string,
  extra: { parentSessionID?: string; isSubAgent?: boolean } = {}
) {
  const agentId = `agents/${name}`;
  const agentPath = join(root, `${name}.agentuse`);
  await writeFile(agentPath, `---\nname: ${name}\nmodel: demo:test\n---\nAsk first.\n`);
  const sessionId = await manager.createSession({
    agent: { id: agentId, name, filePath: agentPath, isSubAgent: extra.isSubAgent ?? false },
    ...(extra.parentSessionID && { parentSessionID: extra.parentSessionID }),
    model: 'demo:test', version: 'test', config: {},
    project: { root, cwd: root },
  });
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'ask' } }, assistant: assistant(),
  });
  const partId = await manager.addPart(sessionId, agentId, messageId, {
    type: 'tool', callID: `${name}-gate`, tool: 'await_human',
    state: {
      status: 'pending',
      input: { prompt: 'Approve?', changes: [{ label: 'Post', content: 'echo publish' }] },
      suspendedAt: Date.now(),
      resumePayload: { kind: 'await_human', resumeToken: `${name}-token` },
    },
  } as any);
  await manager.setSessionSuspended(sessionId, agentId);
  return { sessionId, agentId, messageId, partId };
}

describe('resume rollback that fails itself', () => {
  test('worker resume preflight: a half-applied rollback settles the session as failed', async () => {
    const { initStorage } = await import('../src/storage');
    const { SessionManager } = await import('../src/session');
    const { LeaseStore } = await import('../src/runner/approval-lease');
    const { createWorkerContext } = await import('../src/worker/context');
    const { executeAgent } = await import('../src/worker/run');
    await initStorage(root);
    const manager = new SessionManager();
    const gate = await createGateSession(manager, 'preflight');

    // The rollback reopens the gate part, then fails to re-park the session.
    const originalSuspend = SessionManager.prototype.setSessionSuspended;
    SessionManager.prototype.setSessionSuspended = async function () {
      throw new Error('disk full');
    };
    restorers.push(() => { SessionManager.prototype.setSessionSuspended = originalSuspend; });

    const response = await executeAgent(createWorkerContext(), {
      id: 'resume-request',
      type: 'resume',
      projectRoot: root,
      sessionId: gate.sessionId,
      toolResult: { status: 'approve' },
      resumeToken: 'preflight-token',
    });
    expect(response.success).toBe(false);
    expect((response as { error?: { message?: string } }).error?.message).toContain('MCP setup failed');

    const final = await new SessionManager().findSession(gate.sessionId);
    const part = await manager.getPart(gate.sessionId, gate.agentId, gate.messageId, gate.partId);
    expect(final?.session.status).toBe('error');
    expect(final?.session.error?.code).toBe('RESUME_ROLLBACK_FAILED');
    expect(final?.session.error?.message).toContain('disk full');
    expect(part?.type === 'tool' ? part.state.status : undefined).not.toBe('pending');
    const sessionDir = await manager.getSessionDirectory(gate.sessionId, gate.agentId);
    expect(new LeaseStore(sessionDir).read()).toBeUndefined();
  });

  test('cascade leaf: a failed rollback settles the leaf as failed', async () => {
    const { initStorage } = await import('../src/storage');
    const { SessionManager } = await import('../src/session');
    const { createWorkerContext } = await import('../src/worker/context');
    const { resumeApprovalCascade } = await import('../src/worker/cascade');
    await initStorage(root);

    const rootManager = new SessionManager();
    const rootAgentId = 'agents/manager';
    const rootPath = join(root, 'manager.agentuse');
    await writeFile(rootPath, '---\nname: manager\nmodel: demo:test\n---\nDelegate.\n');
    const rootId = await rootManager.createSession({
      agent: { id: rootAgentId, name: 'manager', filePath: rootPath, isSubAgent: false },
      model: 'demo:test', version: 'test', config: {},
      project: { root, cwd: root },
    });
    const rootMessage = await rootManager.createMessage(rootId, rootAgentId, {
      user: { prompt: { task: 'delegate' } }, assistant: assistant(),
    });
    const leafManager = new SessionManager();
    leafManager.setParentPath(rootManager.getFullPath()!);
    const leaf = await createGateSession(leafManager, 'leaf', { parentSessionID: rootId, isSubAgent: true });
    await rootManager.addPart(rootId, rootAgentId, rootMessage, {
      type: 'tool', callID: 'delegate-call', tool: 'subagent__leaf',
      state: {
        status: 'pending', input: { task: 'ask' }, suspendedAt: Date.now(),
        resumePayload: { kind: 'subagent_wait', childSessionID: leaf.sessionId },
      },
    } as any);
    await rootManager.setSessionSuspended(rootId, rootAgentId);

    // The rollback's write back to the pending gate fails.
    const manager = new SessionManager();
    const originalUpdatePart = manager.updatePart.bind(manager);
    manager.updatePart = (async (...args: Parameters<typeof originalUpdatePart>) => {
      if ((args[4] as { state?: { status?: string } }).state?.status === 'pending') {
        throw new Error('disk full');
      }
      return originalUpdatePart(...args);
    }) as typeof manager.updatePart;

    const cascadeError = await resumeApprovalCascade({
      ctx: createWorkerContext(),
      sessionManager: manager,
      rootSessionId: rootId,
      toolResult: { status: 'approve' },
      resumeToken: 'leaf-token',
      projectRoot: root,
      abortController: new AbortController(),
      startTime: Date.now(),
      reqId: 'resume-request',
    }).then(() => undefined, (error: unknown) => error);
    expect(cascadeError).toBeInstanceOf(Error);
    expect((cascadeError as Error).message).toContain('MCP setup failed');

    const final = await new SessionManager().findSession(leaf.sessionId);
    const part = await new SessionManager().getPart(leaf.sessionId, leaf.agentId, leaf.messageId, leaf.partId);
    expect(final?.session.status).toBe('error');
    expect(final?.session.error?.code).toBe('CASCADE_ROLLBACK_FAILED');
    expect(final?.session.error?.message).toContain('disk full');
    expect(part?.type === 'tool' ? part.state.status : undefined).toBe('completed');
  });
});
