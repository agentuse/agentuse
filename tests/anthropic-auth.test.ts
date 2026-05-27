import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { AnthropicAuth } from '../src/auth/anthropic';
import { AuthStorage } from '../src/auth/storage';
import type { OAuthTokens } from '../src/auth/types';

describe('AnthropicAuth.access refresh buffer', () => {
  let getSpy: ReturnType<typeof spyOn> | undefined;
  let setSpy: ReturnType<typeof spyOn> | undefined;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let savedClaudeCodeOauthToken: string | undefined;

  beforeEach(() => {
    savedClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    getSpy?.mockRestore();
    setSpy?.mockRestore();
    fetchSpy?.mockRestore();
    if (savedClaudeCodeOauthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedClaudeCodeOauthToken;
    }
  });

  it('refreshes the token when expiry is within the 5-minute buffer', async () => {
    const existing: OAuthTokens = {
      type: 'oauth',
      refresh: 'old-refresh',
      access: 'stale-access',
      expires: Date.now() + 60 * 1000, // 1 minute from now — inside buffer
    };

    getSpy = spyOn(AuthStorage, 'getOAuth').mockResolvedValue(existing);
    setSpy = spyOn(AuthStorage, 'setOAuth').mockResolvedValue(undefined);
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

    expect(token).toBe('fresh-access');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith('anthropic', expect.objectContaining({
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

    getSpy = spyOn(AuthStorage, 'getOAuth').mockResolvedValue(existing);
    fetchSpy = spyOn(globalThis, 'fetch');

    const token = await AnthropicAuth.access();

    expect(token).toBe('still-good');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
