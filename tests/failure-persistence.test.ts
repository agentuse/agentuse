import { stopSession } from '../src/worker/sessions';
import { createWorkerContext } from '../src/worker/context';
import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { classifyFailure, runDeadline } from '../src/runner/failure';
import { sessionErrorFields } from '../src/worker/helpers';

it('preserves cause through session storage, durable list index, and API projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-failure-'));
  const originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  try {
    await initStorage(root);
    const manager = new SessionManager();
    const agentId = 'agents/failure';
    const id = await manager.createSession({
      agent: { id: agentId, name: 'Failure fixture', isSubAgent: false },
      model: 'demo:test', version: 'test', config: {}, project: { root, cwd: root },
    });
    const failure = classifyFailure(runDeadline(300));
    await manager.setSessionError(id, agentId, failure);
    const found = await manager.findSession(id);
    expect(found?.session.error).toMatchObject(failure);
    const indexed = (await manager.listSessionSummaries()).find(row => row.sessionId === id);
    expect(indexed?.error?.cause).toBe('run_deadline');
    expect(sessionErrorFields(indexed!)).toMatchObject({ errorCode: 'TIMEOUT', errorCause: 'run_deadline' });

    await manager.updateSession(id, agentId, { status: 'running' });
    await manager.stopSessionTree(id);
    expect((await manager.findSession(id))?.session.error).toMatchObject({ code: 'USER_STOPPED', cause: 'user_stopped' });
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves attached-client disconnect through the worker and durable session tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-disconnect-'));
  const originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  try {
    await initStorage(root);
    const manager = new SessionManager();
    const agentId = 'agents/disconnect';
    const id = await manager.createSession({ agent: { id: agentId, name: agentId, isSubAgent: false },
      model: 'demo:test', version: 'test', config: {}, project: { root, cwd: root } });
    const ctx = createWorkerContext();
    const controller = new AbortController();
    ctx.activeExecutionControllers.set(id, controller);
    await stopSession(ctx, { id: 'stop', type: 'stop-session', projectRoot: root, sessionId: id,
      stopCause: 'client_disconnect', reason: 'client-disconnect' });
    expect(classifyFailure(new DOMException('aborted', 'AbortError'), controller.signal).cause).toBe('client_disconnect');
    const session = (await manager.findSession(id))!.session;
    expect(session.error).toMatchObject({ code: 'CLIENT_DISCONNECT', cause: 'client_disconnect' });
    expect(session.dismissedAt).toBeUndefined();
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    await rm(root, { recursive: true, force: true });
  }
});
