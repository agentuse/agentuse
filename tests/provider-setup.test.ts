import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AnthropicAuth } from '../src/auth/anthropic';
import {
  clearProviderOAuthAttempts,
  completeProviderOAuth,
  providerSetupSnapshot,
  removeCustomProvider,
  removeProviderCredential,
  saveCustomProvider,
  saveProviderApiKey,
  startProviderOAuth,
} from '../src/auth/provider-setup';
import { AuthStorage } from '../src/auth/storage';

const ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_GO_API_KEY'];

describe('Dashboard provider setup service', () => {
  let tempDir = '';
  let originalAuthFile: string;
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-setup-'));
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    clearProviderOAuthAttempts();
  });

  afterEach(async () => {
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
    clearProviderOAuthAttempts();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stores an API key while returning only redacted provider status', async () => {
    const payload = await saveProviderApiKey('openai', 'super-secret-key');
    const openai = payload.status.providers.find((provider) => provider.id === 'openai');

    expect(openai?.configured).toBe(true);
    expect(openai?.sources).toEqual([{ priority: 3, kind: 'api_key', name: 'Stored API key', stored: true, active: true }]);
    expect(JSON.stringify(payload)).not.toContain('super-secret-key');
    expect((await AuthStorage.getApiKey('openai'))?.key).toBe('super-secret-key');

    const removed = await removeProviderCredential('openai', 'api_key');
    expect(removed.status.providers.find((provider) => provider.id === 'openai')?.configured).toBe(false);
  });

  it('validates and manages custom OpenAI-compatible providers', async () => {
    const payload = await saveCustomProvider({ name: 'Local_Models', baseURL: 'http://localhost:11434/v1/', key: 'local-secret' });
    expect(payload.status.customProviders).toEqual([{ id: 'local_models', baseURL: 'http://localhost:11434/v1', hasApiKey: true }]);
    expect(JSON.stringify(payload)).not.toContain('local-secret');

    await expect(saveCustomProvider({ name: 'openai', baseURL: 'http://localhost:11434/v1' })).rejects.toThrow('reserved');
    expect((await removeCustomProvider('local_models')).status.customProviders).toEqual([]);
  });

  it('returns the provider catalog and active environment sources without exposing values', async () => {
    process.env.OPENROUTER_API_KEY = 'environment-secret';
    const payload = await providerSetupSnapshot();
    expect(payload.catalog.map((provider) => provider.id)).toEqual(['anthropic', 'openai', 'openrouter', 'opencode-go']);
    expect(payload.status.providers.find((provider) => provider.id === 'openrouter')?.sources[0]?.name).toBe('OPENROUTER_API_KEY');
    expect(JSON.stringify(payload)).not.toContain('environment-secret');
  });

  it('keeps OAuth verifier state server-side', async () => {
    const authorize = spyOn(AnthropicAuth, 'authorize').mockResolvedValue({
      url: 'https://claude.ai/oauth/authorize?public=yes',
      verifier: 'private-verifier',
    });
    const started = await startProviderOAuth('anthropic', 'max');

    expect(started.authorizationUrl).toContain('claude.ai');
    expect(JSON.stringify(started)).not.toContain('private-verifier');
    expect(started.flowId.length).toBeGreaterThan(20);
    const exchange = spyOn(AnthropicAuth, 'exchange').mockResolvedValue({
      refresh: 'refresh-secret',
      access: 'access-secret',
      expires: Date.now() + 60_000,
    });
    const completed = await completeProviderOAuth(started.flowId, 'authorization-code');
    expect(completed.status.providers.find((provider) => provider.id === 'anthropic')?.configured).toBe(true);
    expect(JSON.stringify(completed)).not.toContain('access-secret');
    expect(exchange).toHaveBeenCalledWith('authorization-code', 'private-verifier');
    await expect(completeProviderOAuth(started.flowId, 'authorization-code')).rejects.toThrow('expired or was not found');
    exchange.mockRestore();
    authorize.mockRestore();
  });
});
