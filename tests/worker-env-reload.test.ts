import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { AgentWorker } from '../src/cli/serve.js';
import { FileWatcher } from '../src/watcher';
import { logger } from '../src/utils/logger.js';

type Internals = {
  pendingRequests: Map<string, { resolve: (value: unknown) => void }>;
};

function fakeSpawner() {
  const children: ChildProcess[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const fake = ((_cmd: string, _args: string[], options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (() => true) as ChildProcess['kill'];
    child.unref = (() => child) as ChildProcess['unref'];
    children.push(child);
    envs.push({ ...(options.env ?? {}) });
    queueMicrotask(() => child.stdout?.write('{"type":"ready"}\n'));
    return child;
  }) as unknown as typeof spawn;
  const cleanup = () => {
    for (const child of children) {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    }
  };
  return { fake, children, envs, cleanup };
}

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('worker env on project env changes', () => {
  const sentinel = 'AGENTUSE_TEST_DAEMON_ONLY_VALUE';
  afterEach(() => {
    delete process.env[sentinel];
  });

  it('spawns workers from the base env, not values loaded into the daemon later', async () => {
    const spawner = fakeSpawner();
    process.env[sentinel] = 'leaked';
    const worker = new AgentWorker({ AGENTUSE_PROJECT_ID: 'demo' }, spawner.fake, { BASE_ONLY: 'yes' });
    try {
      await worker.spawn();
      expect(spawner.envs[0].BASE_ONLY).toBe('yes');
      expect(spawner.envs[0].AGENTUSE_PROJECT_ID).toBe('demo');
      expect(spawner.envs[0][sentinel]).toBeUndefined();
    } finally {
      worker.shutdown();
      spawner.cleanup();
    }
  });

  it('replaces an idle worker when its project env changes', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
    const spawner = fakeSpawner();
    const worker = new AgentWorker({ AGENTUSE_PROJECT_ID: 'demo' }, spawner.fake, {});
    try {
      await worker.spawn();
      worker.markEnvStale();
      await waitFor(() => spawner.children.length === 2 && worker.isReady());
      expect(spawner.children).toHaveLength(2);
    } finally {
      infoSpy.mockRestore();
      worker.shutdown();
      spawner.cleanup();
    }
  });

  it('never releases a busy worker for an env change, and replaces it once idle', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
    const spawner = fakeSpawner();
    const worker = new AgentWorker({ AGENTUSE_PROJECT_ID: 'demo' }, spawner.fake, {});
    const internals = worker as unknown as Internals;
    try {
      await worker.spawn();
      internals.pendingRequests.set('req-50', { resolve: () => {} });
      worker.markEnvStale();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(spawner.children).toHaveLength(1);

      internals.pendingRequests.delete('req-50');
      expect(await worker.recycleIfDue(undefined)).toBe(true);
      expect(spawner.children).toHaveLength(2);
      // The fresh worker is current: no further recycle without a new change.
      expect(await worker.recycleIfDue(undefined)).toBe(false);
    } finally {
      infoSpy.mockRestore();
      worker.shutdown();
      spawner.cleanup();
    }
  });

  it('notifies about an env file change without loading it into the daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentuse-env-reload-'));
    const file = join(dir, '.env');
    writeFileSync(file, `${sentinel}=from-file\n`);
    const changed: string[] = [];
    const watcher = new FileWatcher({
      projectRoot: dir,
      envFile: file,
      onAgentAdded: async () => {},
      onAgentChanged: async () => {},
      onAgentRemoved: () => {},
      onEnvReloaded: (changedFile) => { changed.push(changedFile); },
    });
    try {
      (watcher as unknown as { reloadEnv: (file: string, cb: (f: string) => void) => void })
        .reloadEnv(file, (f) => changed.push(f));
      expect(changed).toEqual([file]);
      expect(process.env[sentinel]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
