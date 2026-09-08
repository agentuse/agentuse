import { afterEach, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { DoomLoopDetector } from '../src/tools';
import type { PreparedAgentExecution } from '../src/runner/types';
import type { PluginManager } from '../src/plugin';

mock.module('../src/runner/announce', () => ({
  announceSessionStarted: async () => {},
  announceSessionFinished: async () => {},
}));
const { runAgent } = await import('../src/runner/run');
let root: string | undefined;
const originalXdg = process.env.XDG_DATA_HOME;
afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  if (root) await rm(root, { recursive: true, force: true });
});

it('marks a direct continuation running before resume hooks execute', async () => {
  root = await mkdtemp(join(tmpdir(), 'runner-continuation-'));
  process.env.XDG_DATA_HOME = root;
  await initStorage(root);
  const manager = new SessionManager();
  const agentId = 'agents/manager';
  const sessionId = await manager.createSession({
    agent: { id: agentId, name: 'Manager', isSubAgent: false },
    model: 'demo:default', version: 'test', config: {},
    project: { root, cwd: root },
  });
  await manager.setSessionError(sessionId, agentId, {
    code: 'EXECUTION_ERROR', message: 'Tool result is missing',
  });
  const preparation: PreparedAgentExecution = {
    tools: {}, systemMessages: [], userMessage: 'Continue.', maxSteps: 1,
    subAgentNames: new Set(), sessionID: sessionId, agentId,
    doomLoopDetector: new DoomLoopDetector({ threshold: 3, action: 'error' }),
    cleanup: async () => {}, releaseStoreLock: async () => {}, learningsApplied: 0,
  };
  let observed: Awaited<ReturnType<SessionManager['findSession']>>;
  const plugins = {
    emit: async (event: string) => {
      if (event === 'agent:resume') {
        observed = await manager.findSession(sessionId);
        // Stop before model execution; this test exercises the entry lifecycle.
        throw new Error('test stop after resume hook');
      }
    },
  } as unknown as PluginManager;
  await expect(runAgent(
    { name: 'Manager', instructions: 'Continue.', config: { model: 'demo:default' } },
    [], false, undefined, Date.now(), false, undefined, undefined, manager,
    { projectRoot: root, stateRoot: root, cwd: root }, undefined,
    preparation, true, plugins, false, sessionId,
  )).rejects.toThrow('test stop after resume hook');
  expect(observed!.session.status).toBe('running');
  expect(observed!.session.error).toBeUndefined();
  expect(observed!.session.owner?.pid).toBe(process.pid);
  expect(observed!.session.errorHistory?.at(-1)?.code).toBe('EXECUTION_ERROR');
});
