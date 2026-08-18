import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AnthropicAuth } from '../src/auth/anthropic';
import { AuthStorage } from '../src/auth/storage';
import type { OAuthTokens } from '../src/auth/types';
import { ANTHROPIC_IDENTITY_PROMPT, helperSystemPrompt } from '../src/utils/anthropic';

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

  // The failure this pair exists for: a blip on the token endpoint used to
  // surface as "No authentication found for Anthropic", which is both wrong and
  // unfixable by the operator it sends to `auth login`.
  it('retries a 5xx refresh once before giving up', async () => {
    await AuthStorage.setOAuth('anthropic', {
      type: 'oauth',
      refresh: 'old-refresh',
      access: 'stale-access',
      expires: Date.now() + 60 * 1000,
    });

    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return new Response('overloaded', { status: 529 });
      return new Response(
        JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    expect(await AnthropicAuth.access()).toBe('fresh-access');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('raises a refresh failure instead of reporting no credentials', async () => {
    await AuthStorage.setOAuth('anthropic', {
      type: 'oauth',
      refresh: 'old-refresh',
      access: 'stale-access',
      expires: Date.now() + 60 * 1000,
    });

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }));

    await expect(AnthropicAuth.access()).rejects.toThrow(/refresh failed \(HTTP 400\)/);
    // A 4xx that is not 429 is a real logout, so it must not be retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when nothing is stored at all', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');

    expect(await AnthropicAuth.access()).toBeUndefined();
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

describe("helperSystemPrompt", () => {
  const ROLE = "You extract learnings and reply with JSON only.";

  // The old shape was a ternary that picked the identity OR the role. On any
  // Anthropic-authed fleet that meant the role was never sent at all: the
  // extractor was told nothing about extracting, the judge nothing about
  // judging.
  it("keeps the role on an Anthropic model instead of dropping it for the identity", () => {
    const { instructions, extraSystem } = helperSystemPrompt("anthropic:claude-opus-5", ROLE);

    expect(instructions).toBe(ANTHROPIC_IDENTITY_PROMPT);
    expect(extraSystem).toBe(ROLE);
  });

  // Concatenation is what this exists to prevent: the API rejects an identity
  // block with anything appended, disguised as a 429 rate_limit_error.
  it("never concatenates the role onto the identity", () => {
    const { instructions } = helperSystemPrompt("anthropic:claude-sonnet-5", ROLE);

    expect(instructions).toBe(ANTHROPIC_IDENTITY_PROMPT);
    expect(instructions).not.toContain("extract");
  });

  it("gives a non-Anthropic provider the role as its whole system prompt", () => {
    const { instructions, extraSystem } = helperSystemPrompt("openai:gpt-5", ROLE);

    expect(instructions).toBe(ROLE);
    expect(extraSystem).toBeUndefined();
  });
});
