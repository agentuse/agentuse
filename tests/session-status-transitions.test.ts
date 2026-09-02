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
