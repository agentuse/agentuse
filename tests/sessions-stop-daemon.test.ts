/**
 * `agentuse sessions stop` against a registered serve daemon.
 *
 * The CLI must authenticate like every other daemon call (AGENTUSE_API_KEY as
 * a bearer token). When the daemon answers but refuses, the stop fails with
 * the daemon's reason and nothing is changed locally: a local stamp would not
 * abort the daemon's worker and would bypass its approval cascade. Only an
 * unreachable daemon falls back to handling the stop locally.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { createSessionsCommand } from '../src/cli/sessions';
import { registerServer, unregisterServer } from '../src/utils/server-registry';

const API_KEY = 'test-daemon-key';
const envKeys = ['XDG_DATA_HOME', 'AGENTUSE_DATA_DIR', 'AGENTUSE_API_KEY'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let dataHome = '';
let projectRoot = '';
let daemon: ReturnType<typeof Bun.serve> | undefined;
const seenAuthorization: Array<string | null> = [];

async function createRunningSession(): Promise<{ manager: SessionManager; sessionId: string }> {
  await initStorage(projectRoot);
  const manager = new SessionManager();
  const sessionId = await manager.createSession({
    agent: { id: 'agents/stop-target', name: 'stop-target', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  return { manager, sessionId };
}

async function runStop(sessionId: string): Promise<{ exitCode?: number; stderr: string }> {
  let stderr = '';
  const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit);
  try {
    await createSessionsCommand().parseAsync(['stop', sessionId, '--project', projectRoot], { from: 'user' });
    return { stderr };
  } catch (error) {
    const match = /^exit:(\d+)$/.exec((error as Error).message);
    if (!match) throw error;
    return { exitCode: Number(match[1]), stderr };
  } finally {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), 'agentuse-stop-daemon-data-'));
  projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-stop-daemon-project-'));
  await mkdir(join(projectRoot, '.agentuse'), { recursive: true });
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.AGENTUSE_DATA_DIR;
  process.env.AGENTUSE_API_KEY = API_KEY;

  // A keyed daemon that refuses the stop, as the real route does when the
  // request carries no matching credential.
  daemon = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      seenAuthorization.push(req.headers.get('authorization'));
      return Response.json(
        { error: { code: 'UNAUTHORIZED', message: 'Not authorized for this session' } },
        { status: 401 },
      );
    },
  });
  registerServer({
    port: daemon.port!,
    host: '127.0.0.1',
    projectRoot,
    startTime: Date.now(),
    agentCount: 0,
    scheduleCount: 0,
    version: 'test',
    projects: [{ id: 'project-1', root: projectRoot, agentCount: 0, scheduleCount: 0 }],
  });
});

afterEach(() => {
  seenAuthorization.length = 0;
});

afterAll(async () => {
  daemon?.stop(true);
  unregisterServer();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(projectRoot, { recursive: true, force: true });
  await rm(dataHome, { recursive: true, force: true });
});

describe('sessions stop via a registered daemon', () => {
  test('sends the API key and leaves the session alone when the daemon refuses', async () => {
    const { manager, sessionId } = await createRunningSession();

    const result = await runStop(sessionId);

    expect(seenAuthorization).toEqual([`Bearer ${API_KEY}`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('401');
    expect(result.stderr).toContain('Not authorized for this session');
    expect(result.stderr).toContain('AGENTUSE_API_KEY');
    const found = await manager.findSession(sessionId);
    expect(found?.session.status).toBe('running');
    expect(found?.session.error).toBeUndefined();
  });

  test('falls back to a local stop only when the daemon is unreachable', async () => {
    const { manager, sessionId } = await createRunningSession();
    daemon?.stop(true);

    const result = await runStop(sessionId);

    expect(result.exitCode).toBeUndefined();
    const found = await manager.findSession(sessionId);
    expect(found?.session.status).toBe('error');
    expect(found?.session.error?.code).toBe('USER_STOPPED');
  });
});
