/**
 * A Stop on a cascade root stamps every descendant, so it must serialize with
 * each descendant's resume claim, not only the root's. Otherwise a sub-agent's
 * approval rollback that already passed its terminal-status check can land its
 * setSessionSuspended after the Stop, leaving that child parked on a pending
 * gate under a stopped root.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalXdg = process.env.XDG_DATA_HOME;
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-stop-tree-rollback-'));
  process.env.XDG_DATA_HOME = root;
});

afterAll(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  await rm(root, { recursive: true, force: true });
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

async function createParkedCascade() {
  const { initStorage } = await import('../src/storage');
  const { SessionManager } = await import('../src/session');
  await initStorage(root);
  const managerPath = join(root, 'manager.agentuse');
  const workerPath = join(root, 'worker.agentuse');
  await writeFile(managerPath, '---\nname: manager\nmodel: demo:test\n---\nDelegate.\n');
  await writeFile(workerPath, '---\nname: worker\nmodel: demo:test\n---\nAsk first.\n');

  const rootManager = new SessionManager();
  const rootAgentId = 'agents/manager';
  const rootId = await rootManager.createSession({
    agent: { id: rootAgentId, name: 'manager', filePath: managerPath, isSubAgent: false },
    model: 'demo:test', version: 'test', config: {},
    project: { root, cwd: root },
  });
  const rootMessage = await rootManager.createMessage(rootId, rootAgentId, {
    user: { prompt: { task: 'delegate' } }, assistant: assistant(),
  });

  const childManager = new SessionManager();
  childManager.setParentPath(rootManager.getFullPath()!);
  const childAgentId = 'agents/worker';
  const childId = await childManager.createSession({
    agent: { id: childAgentId, name: 'worker', filePath: workerPath, isSubAgent: true },
    parentSessionID: rootId,
    model: 'demo:test', version: 'test', config: {},
    project: { root, cwd: root },
  });
  const childMessage = await childManager.createMessage(childId, childAgentId, {
    user: { prompt: { task: 'ask' } }, assistant: assistant(),
  });
  const gatePartId = await childManager.addPart(childId, childAgentId, childMessage, {
    type: 'tool', callID: 'child-gate', tool: 'await_human',
    state: {
      status: 'pending', input: { prompt: 'Approve?' }, suspendedAt: Date.now(),
      resumePayload: { kind: 'await_human', resumeToken: 'child-token' },
    },
  } as any);
  await childManager.setSessionSuspended(childId, childAgentId);

  await rootManager.addPart(rootId, rootAgentId, rootMessage, {
    type: 'tool', callID: 'delegate-call', tool: 'subagent__worker',
    state: {
      status: 'pending', input: { task: 'ask' }, suspendedAt: Date.now(),
      resumePayload: { kind: 'subagent_wait', childSessionID: childId },
    },
  } as any);
  await rootManager.setSessionSuspended(rootId, rootAgentId);

  return { rootManager, rootId, childManager, childId, childAgentId, childMessage, gatePartId };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never held');
}

async function expectStopWinsOverChildRollback(stop: (rootId: string) => Promise<unknown>) {
  const { applyResumeToolResult, restoreResumeToolResult } = await import('../src/runner/resume');
  const { SessionManager } = await import('../src/session');
  const cascade = await createParkedCascade();
  const { childManager, childId, childAgentId, childMessage, gatePartId, rootId } = cascade;

  // The child's approval is applied, then its resume preflight fails and rolls back.
  const applied = await applyResumeToolResult({
    sessionManager: childManager,
    sessionId: childId,
    toolResult: { status: 'approve' },
    resumeToken: 'child-token',
  });

  // Hold the rollback after its terminal-status check, while it owns the child's claim.
  let enteredRestore!: () => void;
  let releaseRestore!: () => void;
  const restoreEntered = new Promise<void>((resolve) => { enteredRestore = resolve; });
  const restoreReleased = new Promise<void>((resolve) => { releaseRestore = resolve; });
  const originalUpdatePart = childManager.updatePart.bind(childManager);
  childManager.updatePart = (async (...args: Parameters<typeof originalUpdatePart>) => {
    if ((args[4] as { state?: { status?: string } }).state?.status === 'pending') {
      enteredRestore();
      await restoreReleased;
    }
    return originalUpdatePart(...args);
  }) as typeof childManager.updatePart;

  const rollback = restoreResumeToolResult({ sessionManager: childManager, rollback: applied.rollback });
  await restoreEntered;

  const stopping = stop(rootId);
  const observer = new SessionManager();
  await waitFor(async () => (await observer.findSession(rootId))?.session.status === 'error');
  // Give an unserialized Stop every chance to stamp the child before the rollback resumes.
  await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 200))]);

  releaseRestore();
  await rollback;
  await stopping;

  const child = await observer.findSession(childId);
  const gate = await observer.getPart(childId, childAgentId, childMessage, gatePartId);
  expect((await observer.findSession(rootId))?.session.status).toBe('error');
  expect(child?.session.status).toBe('error');
  expect(child?.session.error?.code).toBe('USER_STOPPED');
  expect(gate?.type === 'tool' ? gate.state.status : undefined).not.toBe('pending');
}

describe('Stop on a cascade root vs a descendant approval rollback', () => {
  test('stopSessionTree (CLI local stop) leaves the child stopped', async () => {
    const { SessionManager } = await import('../src/session');
    await expectStopWinsOverChildRollback((rootId) =>
      new SessionManager().stopSessionTree(rootId, { message: 'Session stopped by user', dismissEnded: true })
    );
  });

  test('worker stopSession leaves the child stopped', async () => {
    const { createWorkerContext } = await import('../src/worker/context');
    const { stopSession } = await import('../src/worker/sessions');
    await expectStopWinsOverChildRollback(async (rootId) => {
      const response = await stopSession(createWorkerContext(), {
        id: 'stop-request',
        type: 'stop-session',
        projectRoot: root,
        sessionId: rootId,
        reason: 'Session stopped by user',
        stopCause: 'user_stopped',
      });
      expect(response.success).toBe(true);
    });
  });
});
