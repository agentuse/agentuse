import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AuthStorage } from '../src/auth/storage';
import { CodexAuth } from '../src/auth/codex';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('auth storage integrity', () => {
  let tempDir = '';
  let authFile = '';
  let originalAuthFile: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-auth-integrity-'));
    authFile = path.join(tempDir, 'auth.json');
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    originalDataDir = process.env.AGENTUSE_DATA_DIR;
    (AuthStorage as any).AUTH_FILE = authFile;
    process.env.AGENTUSE_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = originalDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('a credential file that cannot be read safely', () => {
    const cases: Array<[string, string]> = [
      ['truncated JSON', JSON.stringify({ 'anthropic:oauth': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 }, 'custom:x': { type: 'custom', baseURL: 'http://x' } }).slice(0, -5)],
      ['an array root', '[]'],
      ['a null root', 'null'],
    ];

    for (const [label, content] of cases) {
      it(`rejects every mutation and leaves ${label} untouched`, async () => {
        await fs.writeFile(authFile, content);
        const mutations: Array<() => Promise<unknown>> = [
          () => AuthStorage.setApiKey('openai', { type: 'api', key: 'sk-test' }),
          () => AuthStorage.removeOAuth('anthropic'),
          () => AuthStorage.setPluginCredential('p', 'm', { token: 't' }),
          () => AuthStorage.migrateOAuthToPluginCredential('anthropic', 'subscription'),
          () => AuthStorage.updateOAuth('anthropic', async () => ({ value: 1, next: { type: 'oauth', access: 'n', refresh: 'n', expires: 2 } })),
          () => AuthStorage.updatePluginCredential('p', 'm', async () => ({ value: 1, next: { token: 'n' } })),
        ];

        for (const mutate of mutations) {
          await expect(mutate()).rejects.toThrow(authFile);
          expect(await fs.readFile(authFile, 'utf8')).toBe(content);
        }
      });
    }

    it('rejects a mutation when the file exists but cannot be read', async () => {
      if (process.getuid?.() === 0) return; // root ignores file modes
      await fs.writeFile(authFile, '{}', { mode: 0o000 });
      try {
        await expect(AuthStorage.setApiKey('openai', { type: 'api', key: 'sk-test' })).rejects.toThrow(authFile);
      } finally {
        await fs.chmod(authFile, 0o600);
      }
      expect(await fs.readFile(authFile, 'utf8')).toBe('{}');
    });

    it('keeps status reads working on a corrupt file', async () => {
      await fs.writeFile(authFile, '{"broken":');
      expect(await AuthStorage.getOAuth('anthropic')).toBeUndefined();
      expect(await AuthStorage.getCustomProviders()).toEqual({});
    });

    it('still treats a missing file as empty', async () => {
      await AuthStorage.setApiKey('openai', { type: 'api', key: 'sk-test' });
      expect(await AuthStorage.getApiKey('openai')).toEqual({ type: 'api', key: 'sk-test' });
    });
  });

  describe('the shared auth lock', () => {
    it('is not taken over from a live holder whose lock directory looks old', async () => {
      let releaseA!: () => void;
      const aMayFinish = new Promise<void>((resolve) => { releaseA = resolve; });
      let aEntered!: () => void;
      const aInside = new Promise<void>((resolve) => { aEntered = resolve; });
      let inside = 0;
      let maxInside = 0;
      const enter = () => { inside += 1; maxInside = Math.max(maxInside, inside); };
      const leave = () => { inside -= 1; };

      const a = AuthStorage.withAuthLock(async () => {
        enter();
        aEntered();
        await aMayFinish;
        leave();
      });
      await aInside;

      const lockDir = `${authFile}.lock`;
      const old = new Date(Date.now() - 6 * 60_000);
      await fs.utimes(lockDir, old, old);

      let bEntered = false;
      let lockExistedWhileBInside = false;
      let releaseB!: () => void;
      const bMayFinish = new Promise<void>((resolve) => { releaseB = resolve; });
      const b = AuthStorage.withAuthLock(async () => {
        enter();
        bEntered = true;
        await bMayFinish;
        lockExistedWhileBInside = await fs.stat(lockDir).then(() => true, () => false);
        leave();
      });

      await sleep(300);
      expect(bEntered).toBe(false);

      releaseA();
      await a;
      for (let i = 0; i < 100 && !bEntered; i++) await sleep(10);
      expect(bEntered).toBe(true);
      releaseB();
      await b;

      expect(maxInside).toBe(1);
      expect(lockExistedWhileBInside).toBe(true);
    });

    it('hands refresh callbacks a deadline that aborts', async () => {
      const storage = AuthStorage as unknown as { REFRESH_TIMEOUT_MS: number };
      const original = storage.REFRESH_TIMEOUT_MS;
      storage.REFRESH_TIMEOUT_MS = 50;
      try {
        const aborted = await AuthStorage.updatePluginCredential('p', 'm', async (_current, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return { value: signal.aborted };
        });
        expect(aborted).toBe(true);
      } finally {
        storage.REFRESH_TIMEOUT_MS = original;
      }
    });

    it('passes the deadline to the Codex token refresh request', async () => {
      await AuthStorage.setOAuth('openai', {
        type: 'codex-oauth', access: 'stale', refresh: 'r', expires: Date.now() - 1, accountId: 'acct',
      });
      let signal: AbortSignal | null | undefined;
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }), { status: 200 });
      }) as typeof fetch);
      try {
        expect(await CodexAuth.access()).toEqual({ token: 'fresh', accountId: 'acct' });
      } finally {
        fetchSpy.mockRestore();
      }
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });
});
