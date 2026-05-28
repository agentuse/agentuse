import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CodexAuth } from '../src/auth/codex';
import { AuthStorage } from '../src/auth/storage';
import type { CodexOAuthTokens } from '../src/auth/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CodexAuth.access refresh buffer', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let originalAuthFile: string;
  let tempDir: string;

  beforeEach(async () => {
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-codex-auth-test-'));
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent refreshes and reuses the first refreshed token', async () => {
    const existing: CodexOAuthTokens = {
      type: 'codex-oauth',
      refresh: 'old-refresh',
      access: 'stale-access',
      expires: Date.now() + 60 * 1000,
      accountId: 'acct-old',
    };

    await AuthStorage.setOAuth('openai', existing);
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await sleep(20);
      return new Response(
        JSON.stringify({
          id_token: 'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LWZyZXNoIn0.signature',
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => CodexAuth.access()));
    const saved = await AuthStorage.getOAuth('openai');

    expect(results).toEqual(Array(5).fill({
      token: 'fresh-access',
      accountId: 'acct-fresh',
    }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(saved).toEqual(expect.objectContaining({
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      accountId: 'acct-fresh',
    }));
  });
});
