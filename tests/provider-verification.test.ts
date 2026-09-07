import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage } from '../src/auth/storage';
import { applyConnectionHealth } from '../src/auth/provider-verification';
import { providerAuthHealthSubject, resetProviderPluginCache, resolveProviderAuth } from '../src/plugin/provider-runtime';
import { readProviderHealth } from '../src/auth/provider-health';
import type { ProviderDefinition } from '../src/plugin/types';
import type { ProviderAuthStatus } from '../src/auth/provider-status';
import { providerHealthLabel, providerHealthCheckSummary } from '../src/cli/serve/web/components/provider-setup';

let root: string;
let dataDir: string | undefined;
let authFile: string;
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-verification-'));
  dataDir = process.env.AGENTUSE_DATA_DIR;
  process.env.AGENTUSE_DATA_DIR = root;
  authFile = (AuthStorage as any).AUTH_FILE;
  (AuthStorage as any).AUTH_FILE = join(root, 'auth.json');
  resetProviderPluginCache();
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
});
afterEach(async () => {
  fetchSpy.mockRestore();
  (AuthStorage as any).AUTH_FILE = authFile;
  if (dataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = dataDir;
  resetProviderPluginCache();
  await rm(root, { recursive: true, force: true });
});

const provider: ProviderDefinition = {
  id: 'test-subscription', name: 'Test subscription', models: [],
  transport: { kind: 'anthropic-messages', baseURL: 'https://example.invalid/v1' },
  auth: { methods: [{
    id: 'subscription', name: 'Subscription OAuth', type: 'oauth',
    login: async () => ({ type: 'oauth' }),
    refresh: async (_, context) => {
      const response = await context.fetch('https://example.invalid/oauth/token');
      if (!response.ok) throw new Error(`refresh failed (HTTP ${response.status})`);
      return { type: 'oauth', access: 'fresh', refresh: 'new-refresh', expires: Date.now() + 3600_000 };
    },
    resolve: ({ credential }) => credential ? { bearerToken: String(credential.access) } : undefined,
  }] },
};
function row(): ProviderAuthStatus {
  return { id: provider.id, name: provider.name, configured: true, sources: [{
    priority: 1, kind: 'oauth', name: 'Subscription OAuth', stored: true, active: true, authMethodId: 'subscription',
  }] };
}
const expired = { type: 'oauth', access: 'expired', refresh: 'rejected', expires: 0 };

describe('provider status verification', () => {
  it('turns a run refresh failure into cached Reconnect required and does not retry it', async () => {
    await AuthStorage.setPluginCredential(provider.id, 'subscription', expired);
    await expect(resolveProviderAuth(provider)).rejects.toThrow('HTTP 400');
    const status = await applyConnectionHealth(row(), [provider], { readiness: 'defer' });
    expect(status.configured).toBe(false);
    expect(status.health?.state).toBe('reconnect_required');
    expect(status.checkPending).toBeUndefined();
    expect(providerHealthLabel(status)).toBe('Sign-in required');
    await applyConnectionHealth(row(), [provider], { force: true });
    await expect(resolveProviderAuth(provider)).rejects.toThrow('Reconnect');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps an auth timeout retryable without removing the credential', async () => {
    await AuthStorage.setPluginCredential(provider.id, 'subscription', expired);
    fetchSpy.mockImplementation(async () => { throw new Error('timeout'); });
    const status = await applyConnectionHealth(row(), [provider], {});
    expect(status.configured).toBe(true);
    expect(status.health?.state).toBe('temporarily_unavailable');
    expect(await AuthStorage.getPluginCredential(provider.id, 'subscription')).toEqual(expired);
    await applyConnectionHealth(row(), [provider], {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await applyConnectionHealth(row(), [provider], { force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('verifies rotated credentials and forgets the prior credential failure', async () => {
    await AuthStorage.setPluginCredential(provider.id, 'subscription', expired);
    await applyConnectionHealth(row(), [provider], {});
    await AuthStorage.setPluginCredential(provider.id, 'subscription', { ...expired, refresh: 'replacement' });
    fetchSpy.mockImplementation(async () => Response.json({ access_token: 'fresh' }));
    const status = await applyConnectionHealth(row(), [provider], {});
    expect(status.health?.state).toBe('verified');
    expect(status.configured).toBe(true);
    expect((await readProviderHealth((await providerAuthHealthSubject(provider))!)).state).toBe('verified');
  });

  it('keeps unsupported verification configured instead of claiming connected', async () => {
    await AuthStorage.setPluginCredential(provider.id, 'subscription', { ...expired, expires: Date.now() + 3600_000 });
    const status = await applyConnectionHealth(row(), [provider], {});
    expect(status.health?.state).toBe('configured');
    expect(providerHealthLabel(status)).toBe('Not verified');
    expect(providerHealthCheckSummary(status)).toContain('Credentials found. This check could not verify');
    expect(providerHealthLabel({ ...status, health: { state: 'configured' } })).toBe('Not checked');
    const retried = await applyConnectionHealth(row(), [provider], { force: true });
    expect(providerHealthLabel(retried)).toBe('Not verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('verifies Claude OAuth through the authenticated catalog and preserves rejected credentials', async () => {
    const claude = { ...provider, id: 'anthropic', transport: { kind: 'anthropic-messages' as const, baseURL: 'https://api.anthropic.com/v1' } };
    const credential = { ...expired, expires: Date.now() + 3600_000 };
    await AuthStorage.setPluginCredential('anthropic', 'subscription', credential);
    fetchSpy.mockImplementation(async (_url, init) => {
      expect(String(_url)).toBe('https://api.anthropic.com/v1/models?limit=1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer expired');
      expect(init?.redirect).toBe('error');
      return Response.json({ data: [] });
    });
    const input = { ...row(), id: 'anthropic' };
    const status = await applyConnectionHealth(input, [claude], { force: true });
    expect(status.health?.state).toBe('verified');
    expect(providerHealthLabel(status)).toBe('Connected');
    fetchSpy.mockImplementation(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
    expect((await applyConnectionHealth(input, [claude], { force: true })).health?.state).toBe('reconnect_required');
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toEqual(credential);
  });

  it('does not send custom Anthropic transport credentials to the first-party catalog', async () => {
    await AuthStorage.setPluginCredential('anthropic', 'subscription', { ...expired, expires: Date.now() + 3600_000 });
    const status = await applyConnectionHealth({ ...row(), id: 'anthropic' }, [{ ...provider, id: 'anthropic' }], { force: true });
    expect(status.health?.state).toBe('configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function builtinRow(id: string, kind: 'oauth' | 'api_key'): ProviderAuthStatus {
  return { id, name: id, configured: true, sources: [{
    priority: 1, kind, name: kind, stored: true, active: true,
  }] };
}

describe('first-party lightweight verification', () => {
  it('verifies an unexpired ChatGPT token with account context and caches the check', async () => {
    await AuthStorage.setOAuth('openai', {
      type: 'codex-oauth', access: 'access', refresh: 'refresh',
      expires: Date.now() + 3600_000, accountId: 'account',
    });
    fetchSpy.mockImplementation(async () => Response.json({ models: [] }));
    const status = await applyConnectionHealth(builtinRow('openai', 'oauth'), [], {});
    expect(status.health?.state).toBe('verified');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/models?client_version=0.99.0',
      expect.objectContaining({ headers: { authorization: 'Bearer access', 'ChatGPT-Account-Id': 'account' }, redirect: 'error' }),
    );
    await applyConnectionHealth(builtinRow('openai', 'oauth'), [], {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await applyConnectionHealth(builtinRow('openai', 'oauth'), [], { force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('marks a rejected ChatGPT access token as requiring reconnect', async () => {
    await AuthStorage.setOAuth('openai', {
      type: 'codex-oauth', access: 'rejected-access', refresh: 'refresh', expires: Date.now() + 3600_000,
    });
    fetchSpy.mockImplementation(async () => Response.json({}, { status: 401 }));
    const status = await applyConnectionHealth(builtinRow('openai', 'oauth'), [], {});
    expect(status.health?.state).toBe('reconnect_required');
    expect(status.configured).toBe(false);
  });

  it('verifies OpenCode Go through usage rather than its public model catalog', async () => {
    await AuthStorage.setApiKey('opencode-go', { type: 'api', key: 'go-key' });
    fetchSpy.mockImplementation(async () => Response.json({ usage: {} }));
    const status = await applyConnectionHealth(builtinRow('opencode-go', 'api_key'), [], {});
    expect(status.health?.state).toBe('verified');
    expect(fetchSpy).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/usage',
      expect.objectContaining({ headers: { authorization: 'Bearer go-key' }, redirect: 'error' }));
  });

  it('keeps subscription or rate-limit failures retryable and rejects invalid Go keys', async () => {
    await AuthStorage.setApiKey('opencode-go', { type: 'api', key: 'go-key' });
    for (const code of [403, 429, 503]) {
      fetchSpy.mockImplementation(async () => Response.json({}, { status: code }));
      const status = await applyConnectionHealth(builtinRow('opencode-go', 'api_key'), [], { force: true });
      expect(status.health?.state).toBe('temporarily_unavailable');
      expect(status.configured).toBe(true);
    }
    fetchSpy.mockImplementation(async () => Response.json({}, { status: 401 }));
    const rejected = await applyConnectionHealth(builtinRow('opencode-go', 'api_key'), [], { force: true });
    expect(rejected.health?.state).toBe('reconnect_required');
  });

  it('does not send a custom Go endpoint key to the first-party service', async () => {
    const previous = process.env.OPENCODE_GO_BASE_URL;
    try {
      process.env.OPENCODE_GO_BASE_URL = 'https://custom.invalid/v1';
      await AuthStorage.setApiKey('opencode-go', { type: 'api', key: 'custom-key' });
      const status = await applyConnectionHealth(builtinRow('opencode-go', 'api_key'), [], {});
      expect(status.health?.state).toBe('configured');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_GO_BASE_URL;
      else process.env.OPENCODE_GO_BASE_URL = previous;
    }
  });
});
