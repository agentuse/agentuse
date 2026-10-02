/**
 * A user Stop that lands while a worker resume is still in preflight (after the
 * approval was applied, before runAgent) is the newer lifecycle decision. The
 * preflight failure that follows must not roll the approval back over it:
 * that used to reopen the gate and flip the stopped session back to
 * suspended, and the API reported a generic error instead of USER_STOPPED.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let enteredConnect!: () => void;
let failConnect!: (error: Error) => void;
const connectEntered = new Promise<void>((resolve) => { enteredConnect = resolve; });
const connectFailure = new Promise<never>((_resolve, reject) => { failConnect = reject; });

// Hold the resume after the approval transaction committed but before
// prepareAgentExecution/runAgent: the preflight window.
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
  root = await mkdtemp(join(tmpdir(), 'agentuse-worker-stop-race-'));
  process.env.XDG_DATA_HOME = root;
});

afterAll(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  await rm(root, { recursive: true, force: true });
  mock.restore();
});

async function createSuspendedGateSession(input: Record<string, unknown> = { prompt: 'Approve?' }) {
  const { initStorage } = await import('../src/storage');
  const { SessionManager } = await import('../src/session');
  await initStorage(root);
  const manager = new SessionManager();
  const agentId = 'agents/worker-stop-race';
  const agentPath = join(root, 'worker-stop-race.agentuse');
  await writeFile(agentPath, [
    '---',
    'name: worker-stop-race',
    'model: demo:test',
    '---',
    'Stop during resume preflight.',
    '',
  ].join('\n'));

  const sessionId = await manager.createSession({
    agent: { id: agentId, name: 'worker-stop-race', filePath: agentPath, isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root, cwd: root },
  });
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'Stop during resume preflight' } },
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
  const partId = await manager.addPart(sessionId, agentId, messageId, {
    type: 'tool',
    callID: 'approval-gate',
    tool: 'await_human',
    state: {
      status: 'pending',
      input,
      suspendedAt: Date.now(),
      resumePayload: { kind: 'await_human', resumeToken: 'resume-token' },
    },
  } as any);
  await manager.setSessionSuspended(sessionId, agentId);
  return { manager, agentId, sessionId, messageId, partId };
}

describe('worker resume preflight vs user Stop', () => {
  test('rollback leaves a session stopped after the decision was applied', async () => {
    const { applyResumeToolResult, restoreResumeToolResult } = await import('../src/runner/resume');
    const { manager, agentId, sessionId, messageId, partId } = await createSuspendedGateSession();

    const applied = await applyResumeToolResult({
      sessionManager: manager,
      sessionId,
      toolResult: { status: 'approve' },
      resumeToken: 'resume-token',
    });
    // A Stop from another process (no abort signal reaches this caller).
    await manager.stopSessionTree(sessionId, { code: 'USER_STOPPED', message: 'Session stopped by user' });
    await restoreResumeToolResult({ sessionManager: manager, rollback: applied.rollback });

    const final = await manager.findSession(sessionId);
    const finalPart = await manager.getPart(sessionId, agentId, messageId, partId);
    expect(final?.session.status).toBe('error');
    expect(final?.session.error?.code).toBe('USER_STOPPED');
    expect(finalPart?.type === 'tool' ? finalPart.state.status : undefined).toBe('completed');
  });

  test('rollback after a Stop revokes the lease the decision granted', async () => {
    const { applyResumeToolResult, restoreResumeToolResult } = await import('../src/runner/resume');
    const { LeaseStore } = await import('../src/runner/approval-lease');
    const { manager, agentId, sessionId } = await createSuspendedGateSession({
      prompt: 'Approve?',
      changes: [{ label: 'Post', content: 'echo publish' }],
    });

    const applied = await applyResumeToolResult({
      sessionManager: manager,
      sessionId,
      toolResult: { status: 'approve' },
      resumeToken: 'resume-token',
    });
    const sessionDir = await manager.getSessionDirectory(sessionId, agentId);
    expect(new LeaseStore(sessionDir).read()).toBeDefined();

    await manager.stopSessionTree(sessionId, { code: 'USER_STOPPED', message: 'Session stopped by user' });
    await restoreResumeToolResult({ sessionManager: manager, rollback: applied.rollback });

    // No segment ran to consume the lease, so a later continuation of the
    // stopped session must not inherit it.
    expect(new LeaseStore(sessionDir).read()).toBeUndefined();
    expect((await manager.findSession(sessionId))?.session.status).toBe('error');
  });

  test('a Stop during preflight stays durable and is reported as USER_STOPPED', async () => {
    const { createWorkerContext } = await import('../src/worker/context');
    const { executeAgent } = await import('../src/worker/run');
    const { stopSession } = await import('../src/worker/sessions');
    const { manager, agentId, sessionId, messageId, partId } = await createSuspendedGateSession();

    const ctx = createWorkerContext();
    const runPromise = executeAgent(ctx, {
      id: 'resume-request',
      type: 'resume',
      projectRoot: root,
      sessionId,
      toolResult: { status: 'approve' },
      resumeToken: 'resume-token',
    });
    await connectEntered;

    const stopResponse = await stopSession(ctx, {
      id: 'stop-request',
      type: 'stop-session',
      projectRoot: root,
      sessionId,
      reason: 'Session stopped by user',
      stopCause: 'user_stopped',
    });
    expect(stopResponse.success).toBe(true);

    // The setup failure surfaces after the Stop was recorded.
    failConnect(new Error('MCP setup failed after the stop'));
    const runResponse = await runPromise;

    const final = await manager.findSession(sessionId);
    const finalPart = await manager.getPart(sessionId, agentId, messageId, partId);
    expect(runResponse.success).toBe(false);
    expect((runResponse as { error?: { code?: string } }).error?.code).toBe('USER_STOPPED');
    expect(final?.session.status).toBe('error');
    expect(final?.session.error?.code).toBe('USER_STOPPED');
    expect(finalPart?.type === 'tool' ? finalPart.state.status : undefined).not.toBe('pending');
  });
});
