import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, type ServerResponse } from 'http';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(JSON.stringify(message) + '\n');
}

/** Resolve on the first stdout line whose parsed JSON satisfies `match`. */
function waitForMessage(
  child: ChildProcessWithoutNullStreams,
  match: (message: any) => boolean,
  timeoutMs = 5_000
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error('timed out waiting for worker message'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (match(message)) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(message);
            return;
          }
        } catch {
          // Not a JSON line we care about.
        }
      }
    };
    child.stdout.on('data', onData);
  });
}

/**
 * An Anthropic-shaped endpoint that holds every request open until asked to
 * fail them. Lets a test park a real run in flight with no API key and no
 * network, which is the only way to exercise "worker must not die mid-run".
 */
async function startStalledApi(): Promise<{ url: string; failPending: () => void; close: () => Promise<void> }> {
  const pending: ServerResponse[] = [];
  const server = createServer((_req, res) => {
    pending.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    failPending: () => {
      // 400 is non-retryable, so the run settles instead of backing off.
      for (const res of pending.splice(0)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stalled test api' } }));
      }
    },
    close: () => new Promise<void>((resolve) => {
      for (const res of pending.splice(0)) res.destroy();
      // close() alone never settles while a keep-alive socket is open.
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error('worker did not become ready'));
    }, 5_000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // Keep waiting for the JSON ready line.
        }
      }
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`worker exited before ready: ${code ?? signal}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('worker did not exit after stdin closed'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe('internal worker lifecycle', () => {
  it('creates and fails a durable preparing session over worker IPC', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const sandbox = await mkdtemp(join(tmpdir(), 'agentuse-preparing-session-'));
    const projectRoot = join(sandbox, 'project');
    const dataHome = join(sandbox, 'xdg-data');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(dataHome, { recursive: true });
    process.env.XDG_DATA_HOME = dataHome;
    await initStorage(projectRoot);
    const sessionId = '01WORKERPREPARING000000000';
    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XDG_DATA_HOME: dataHome, HOME: sandbox },
    });

    try {
      await waitForReady(child);
      send(child, {
        id: 'prepare-1',
        type: 'create-preparing-session',
        projectRoot,
        sessionId,
        agentId: 'Revise report',
        agentName: 'Revise report',
        model: 'openai:test',
        trigger: 'manual',
        preparerOwner: { pid: process.pid },
      });
      expect(await waitForMessage(child, (message) => message.id === 'prepare-1')).toMatchObject({
        success: true,
        sessionId,
      });

      const manager = new SessionManager();
      expect((await manager.findSession(sessionId))?.session.status).toBe('preparing');

      send(child, {
        id: 'prepare-detail-1',
        type: 'approval-info',
        projectRoot,
        sessionId,
        skipTokenCheck: true,
      });
      expect(await waitForMessage(child, (message) => message.id === 'prepare-detail-1')).toMatchObject({
        success: true,
        approval: {
          sessionId,
          sessionStatus: 'preparing',
          logs: [],
        },
      });

      send(child, {
        id: 'prepare-fail-1',
        type: 'fail-preparing-session',
        projectRoot,
        sessionId,
        errorCode: 'REVISION_FAILED',
        errorMessage: 'Could not sanitize the project',
      });
      expect(await waitForMessage(child, (message) => message.id === 'prepare-fail-1')).toMatchObject({
        success: true,
        sessionId,
      });
      const failed = await manager.findSession(sessionId);
      expect(failed?.session.status).toBe('error');
      expect(failed?.session.error).toMatchObject({
        code: 'REVISION_FAILED',
        message: 'Could not sanitize the project',
      });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('promotes the same preparing session when worker execution starts', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const sandbox = await mkdtemp(join(tmpdir(), 'agentuse-promote-session-'));
    const projectRoot = join(sandbox, 'project');
    const dataHome = join(sandbox, 'xdg-data');
    const agentPath = join(projectRoot, 'revision.agentuse');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(dataHome, { recursive: true });
    await writeFile(agentPath, ['---', 'name: Revision', 'model: demo:hello', '---', '', 'Say hello.'].join('\n'));
    process.env.XDG_DATA_HOME = dataHome;
    await initStorage(projectRoot);
    const sessionId = '01WORKERPROMOTION000000000';
    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XDG_DATA_HOME: dataHome, HOME: sandbox },
    });

    try {
      await waitForReady(child);
      send(child, {
        id: 'prepare-promote-1',
        type: 'create-preparing-session',
        projectRoot,
        sessionId,
        agentId: 'revision',
        agentName: 'Revision',
        model: 'demo:hello',
        trigger: 'manual',
        preparerOwner: { pid: process.pid },
      });
      expect(await waitForMessage(child, (message) => message.id === 'prepare-promote-1')).toMatchObject({ success: true });
      const manager = new SessionManager();
      const createdAt = (await manager.findSession(sessionId))?.session.time.created;

      send(child, {
        id: 'execute-promote-1',
        type: 'execute',
        agentPath,
        projectRoot,
        newSessionId: sessionId,
        preparedSession: true,
        timeout: 30,
      });
      expect(await waitForMessage(child, (message) => message.id === 'execute-promote-1', 10_000)).toMatchObject({
        success: true,
        result: { sessionId },
      });

      const completed = await manager.findSession(sessionId);
      expect(completed?.session.status).toBe('completed');
      expect(completed?.session.time.created).toBe(createdAt);
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('exits when parent IPC stdin closes', async () => {
    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    try {
      await waitForReady(child);
      const exited = waitForExit(child);
      child.stdin.end();
      expect(await exited).toMatchObject({ code: 0, signal: null });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('acknowledges release and exits at once when it has no run to protect', async () => {
    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    try {
      await waitForReady(child);
      const exited = waitForExit(child);
      send(child, { id: 'rel-1', type: 'release' });
      const ack = await waitForMessage(child, (m) => m.id === 'rel-1');
      expect(ack).toMatchObject({ success: true, inFlightRuns: 0 });
      expect(await exited).toMatchObject({ code: 0 });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('drains a stop-session request before acknowledging release or exiting', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const sandbox = await mkdtemp(join(tmpdir(), 'agentuse-release-stop-'));
    const projectRoot = join(sandbox, 'project');
    const dataHome = join(sandbox, 'xdg-data');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(dataHome, { recursive: true });
    process.env.XDG_DATA_HOME = dataHome;
    await initStorage(projectRoot);

    const sessionManager = new SessionManager();
    const agentId = 'agents/release-stop';
    const sessionId = await sessionManager.createSession({
      agent: { id: agentId, name: 'release-stop', isSubAgent: false },
      model: 'demo:test',
      version: 'test',
      config: {},
      project: { root: projectRoot, cwd: projectRoot },
    });

    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XDG_DATA_HOME: dataHome, HOME: sandbox },
    });

    try {
      await waitForReady(child);
      const stopped = waitForMessage(child, (message) => message.id === 'stop-before-release');
      const released = waitForMessage(child, (message) => message.id === 'release-after-stop');
      const exited = waitForExit(child);

      // One pipe batch reproduces the lifecycle race: the worker starts the
      // async stop, then consumes release before that storage write resolves.
      child.stdin.write(
        `${JSON.stringify({ id: 'stop-before-release', type: 'stop-session', projectRoot, sessionId })}\n` +
        `${JSON.stringify({ id: 'release-after-stop', type: 'release' })}\n`
      );

      expect(await stopped).toMatchObject({
        success: true,
        stopped: [expect.objectContaining({ sessionId, stopped: true })],
      });
      expect(await released).toMatchObject({
        success: true,
        inFlightRuns: 0,
        inFlightOperations: 0,
      });
      expect(await exited).toMatchObject({ code: 0 });

      const persisted = await sessionManager.findSession(sessionId);
      expect(persisted?.session.status).toBe('error');
      expect(persisted?.session.error?.code).toBe('USER_STOPPED');
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not abandon a run in flight when serve goes away', async () => {
    const api = await startStalledApi();
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-release-'));
    const agentPath = join(projectRoot, 'stalled.agentuse');
    await writeFile(
      agentPath,
      ['---', 'name: Stalled', 'model: "anthropic:claude-haiku-4-5"', 'maxSteps: 2', '---', '', 'Say hi.'].join('\n')
    );
    const dataHome = join(projectRoot, 'xdg-data');
    const configHome = join(projectRoot, 'xdg-config');
    await mkdir(dataHome, { recursive: true });
    await mkdir(configHome, { recursive: true });

    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Isolated so the run cannot pick up real credentials or real storage.
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: configHome,
        HOME: projectRoot,
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_BASE_URL: api.url,
      },
    });

    try {
      await waitForReady(child);
      send(child, { id: 'run-1', type: 'execute', agentPath, projectRoot, timeout: 120, maxSteps: 2 });
      // Give the request time to reach the model call and park there.
      await sleep(3_000);
      expect(child.exitCode).toBeNull();

      // The signals a supervisor tree-kill delivers straight to the worker.
      // Before the release mechanism these each killed the run instantly.
      child.kill('SIGTERM');
      await sleep(1_500);
      expect(child.exitCode).toBeNull();

      // Released, then the parent's pipe goes away: still must not quit.
      send(child, { id: 'rel-2', type: 'release' });
      const ack = await waitForMessage(child, (m) => m.id === 'rel-2');
      expect(ack).toMatchObject({ success: true, inFlightRuns: 1 });
      child.stdin.end();
      await sleep(1_500);
      expect(child.exitCode).toBeNull();

      // Once the run actually lands, a released worker leaves on its own
      // rather than lingering as a stray process.
      const exited = waitForExit(child, 20_000);
      api.failPending();
      expect(await exited).toMatchObject({ code: 0 });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      await api.close();
    }
  }, 45_000);

  it('leaves anyway when a released run never lands', async () => {
    // Release clears the reparenting watchdog, so this backstop is the only
    // thing standing between a wedged run and a worker that never exits.
    const api = await startStalledApi();
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-backstop-'));
    const agentPath = join(projectRoot, 'stalled.agentuse');
    await writeFile(
      agentPath,
      ['---', 'name: Stalled', 'model: "anthropic:claude-haiku-4-5"', 'maxSteps: 2', '---', '', 'Say hi.'].join('\n')
    );
    const dataHome = join(projectRoot, 'xdg-data');
    await mkdir(dataHome, { recursive: true });

    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        HOME: projectRoot,
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_BASE_URL: api.url,
        AGENTUSE_RELEASE_BACKSTOP_SECONDS: '5',
      },
    });

    try {
      await waitForReady(child);
      // A 600s run timeout the test will never reach, against an API that never
      // answers: only the backstop can end this process.
      send(child, { id: 'run-2', type: 'execute', agentPath, projectRoot, timeout: 600, maxSteps: 2 });
      await sleep(3_000);
      expect(child.exitCode).toBeNull();

      const exited = waitForExit(child, 25_000);
      send(child, { id: 'rel-3', type: 'release' });
      await waitForMessage(child, (m) => m.id === 'rel-3');
      expect(await exited).toMatchObject({ code: 0 });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      await api.close();
    }
  }, 45_000);
});
