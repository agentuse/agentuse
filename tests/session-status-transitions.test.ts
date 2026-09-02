import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'agentuse-status-transition-'));
  process.env.XDG_DATA_HOME = root;
  await initStorage(root);
  const manager = new SessionManager();
  const agentId = 'agents/manager';
  const sessionId = await manager.createSession({
    agent: { id: agentId, name: 'Manager', isSubAgent: false },
    model: 'openai:test',
    version: 'test',
    config: {},
    project: { root, cwd: root },
  });
  return { manager, agentId, sessionId };
}

describe('session status transitions', () => {
  it('promotes one durable preparing session into the running execution', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-status-transition-'));
    process.env.XDG_DATA_HOME = root;
    await initStorage(root);
    const manager = new SessionManager();
    const agentId = 'internal-agent-revision';
    const sessionId = '01PREPARINGSESSION000000000';
    const base = {
      agent: { id: agentId, name: 'Revise report', isSubAgent: false },
      model: 'openai:test',
      version: 'test',
      config: { timeout: 480, maxSteps: 20 },
      project: { root, cwd: root },
    };

    await manager.createSession({ ...base, id: sessionId, initialStatus: 'preparing' });
    const prepared = await manager.findSession(sessionId);
    expect(prepared?.session.status).toBe('preparing');
    expect(prepared?.session.owner).toBeUndefined();
    const createdAt = prepared?.session.time.created;

    await manager.createSession({ ...base, id: sessionId, promotePrepared: true });
    const running = await manager.findSession(sessionId);
    expect(running?.session.status).toBe('running');
    expect(running?.session.time.created).toBe(createdAt);
    expect(running?.session.owner?.pid).toBe(process.pid);
    expect((running?.session as Record<string, unknown>).initialStatus).toBeUndefined();
  });

  it('will not start a prepared session after it has been stopped', async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-status-transition-'));
    process.env.XDG_DATA_HOME = root;
    await initStorage(root);
    const manager = new SessionManager();
    const agentId = 'internal-agent-revision';
    const sessionId = '01STOPPEDPREPARING00000000';
    const base = {
      agent: { id: agentId, name: 'Revise report', isSubAgent: false },
      model: 'openai:test',
      version: 'test',
      config: {},
      project: { root, cwd: root },
    };

    await manager.createSession({ ...base, id: sessionId, initialStatus: 'preparing' });
    await manager.stopSessionTree(sessionId);
    expect((await manager.findSession(sessionId))?.session.error?.code).toBe('USER_STOPPED');

    await expect(manager.createSession({ ...base, id: sessionId, promotePrepared: true })).rejects.toThrow('SESSION_NOT_PREPARING');
    expect((await manager.findSession(sessionId))?.session.status).toBe('error');
  });

  it('clears an incomplete verdict atomically when a retry starts', async () => {
    const { manager, agentId, sessionId } = await setup();
    await manager.setSessionError(sessionId, agentId, { code: 'INCOMPLETE', message: 'MCP unavailable' });

    await manager.setSessionRunning(sessionId, agentId);

    const found = await manager.findSession(sessionId);
    expect(found?.session.status).toBe('running');
    expect(found?.session.error).toBeUndefined();
  });

  it('does not retain an earlier failure after a retry completes or re-suspends', async () => {
    const { manager, agentId, sessionId } = await setup();
    await manager.setSessionError(sessionId, agentId, { code: 'INCOMPLETE', message: 'first attempt' });
    await manager.setSessionCompleted(sessionId, agentId);
    expect((await manager.findSession(sessionId))?.session.error).toBeUndefined();

    await manager.setSessionError(sessionId, agentId, { code: 'EXECUTION_ERROR', message: 'second attempt' });
    await manager.setSessionSuspended(sessionId, agentId);
    expect((await manager.findSession(sessionId))?.session.error).toBeUndefined();
  });
});
