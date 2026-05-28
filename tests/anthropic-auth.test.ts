import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AnthropicAuth } from '../src/auth/anthropic';
import { AuthStorage } from '../src/auth/storage';
import type { OAuthTokens } from '../src/auth/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AnthropicAuth.access refresh buffer', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let savedClaudeCodeOauthToken: string | undefined;
  let originalAuthFile: string;
  let tempDir: string;

  beforeEach(async () => {
    savedClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-anthropic-auth-test-'));
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    if (savedClaudeCodeOauthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedClaudeCodeOauthToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('refreshes the token when expiry is within the 5-minute buffer', async () => {
    const existing: OAuthTokens = {
      type: 'oauth',
      refresh: 'old-refresh',
      access: 'stale-access',
      expires: Date.now() + 60 * 1000, // 1 minute from now, inside buffer
    };

    await AuthStorage.setOAuth('anthropic', existing);
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const token = await AnthropicAuth.access();
    const saved = await AuthStorage.getOAuth('anthropic');

    expect(token).toBe('fresh-access');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(saved).toEqual(expect.objectContaining({
      access: 'fresh-access',
      refresh: 'fresh-refresh',
    }));
  });

  it('returns the cached access token when expiry is comfortably beyond the buffer', async () => {
    const existing: OAuthTokens = {
      type: 'oauth',
      refresh: 'old-refresh',
      access: 'still-good',
      expires: Date.now() + 60 * 60 * 1000, // 1 hour out
    };

    await AuthStorage.setOAuth('anthropic', existing);
    fetchSpy = spyOn(globalThis, 'fetch');

    const token = await AnthropicAuth.access();

    expect(token).toBe('still-good');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serializes concurrent refreshes and reuses the first refreshed token', async () => {
    const existing: OAuthTokens = {
      type: 'oauth',
      refresh: 'old-refresh',
      access: 'stale-access',
      expires: Date.now() + 60 * 1000,
    };

    await AuthStorage.setOAuth('anthropic', existing);
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await sleep(20);
      return new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const tokens = await Promise.all(Array.from({ length: 5 }, () => AnthropicAuth.access()));
    const saved = await AuthStorage.getOAuth('anthropic');

    expect(tokens).toEqual(Array(5).fill('fresh-access'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(saved).toEqual(expect.objectContaining({
      access: 'fresh-access',
      refresh: 'fresh-refresh',
    }));
  });
});
