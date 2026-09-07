import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CodexAuth } from '../src/auth/codex';
import {
  clearProviderOAuthAttempts,
  checkCustomProvider,
  completeProviderPluginOAuth,
  cancelProviderOAuth,
  completeProviderOAuth,
  configureCustomProvider,
  installProviderPluginFromRegistry,
  installUnreviewedProviderPlugin,
  providerSetupSnapshot,
  removeCustomProvider,
  removeProviderCredential,
  saveCustomProvider,
  saveProviderApiKey,
  startProviderPluginOAuth,
  startUnreviewedProviderPluginOAuth,
  startProviderOAuth,
} from '../src/auth/provider-setup';
import { AuthStorage } from '../src/auth/storage';
import { defaultProviderSetupSelection, friendlyProviderPluginError, hasConfiguredProvider, missingProviderMethods, providerSetupOptions, validateProviderPluginSource } from '../src/cli/serve/web/components/provider-setup';
import { resetProviderPluginCache } from '../src/plugin/provider-runtime';
import * as installer from '../src/plugin/provider-installer';

const ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_GO_API_KEY'];

describe('Dashboard provider setup service', () => {
  let tempDir = '';
  let originalAuthFile: string;
  let originalDataDir: string | undefined;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-setup-'));
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    originalDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = tempDir;
    resetProviderPluginCache();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    clearProviderOAuthAttempts();
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [] }));
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = originalDataDir;
    resetProviderPluginCache();
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
    clearProviderOAuthAttempts();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function addClaudePluginFixture(): Promise<void> {
    const home = path.join(tempDir, 'plugins');
    const directory = path.join(home, 'agentuse-claude-code-provider-fixture');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: 'agentuse-claude-code-provider',
      version: '0.1.0',
      type: 'module',
      agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(directory, 'index.js'), `
      export default function (agentuse) {
        agentuse.registerProvider('anthropic', {
          name: 'Claude Code Subscription',
          models: { inherit: 'anthropic' },
          transport: { kind: 'anthropic-messages', headers: { 'anthropic-beta': 'oauth-2025-04-20' } },
          auth: { methods: [{
            id: 'subscription', type: 'oauth', name: 'Claude subscription OAuth',
            environment: ['CLAUDE_CODE_OAUTH_TOKEN'],
            async login(interaction) {
              await interaction.openBrowser({ url: 'https://claude.ai/oauth/authorize?fixture=yes' });
              const code = await interaction.prompt({ message: 'Authorization code', secret: true });
              if (code !== 'valid-code') throw new Error('Invalid authorization code');
              return { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: Date.now() + 3600000 };
            },
            resolve({ credential }, context) {
              const token = context.env.CLAUDE_CODE_OAUTH_TOKEN || credential?.access;
              return token ? { bearerToken: token, source: 'OAuth' } : undefined;
            }
          }] },
          async when(context) { return Boolean(await context.auth.resolve('subscription')); }
        });
      }
    `);
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify([{
      name: 'agentuse-claude-code-provider',
      version: '0.1.0',
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
      directory,
      scope: 'global',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]));
    resetProviderPluginCache();
  }

  it('explains flexible GitHub source formats before attempting a fetch', () => {
    expect(validateProviderPluginSource('leonho/agentuse-pi-cli-provider@50533d8')).toBeNull();
    expect(validateProviderPluginSource('owner/repo')).toBeNull();
    expect(validateProviderPluginSource('owner/repo@main')).toContain('moving branch');
    expect(validateProviderPluginSource('owner/repo@v1.0.0')).toBeNull();
    expect(validateProviderPluginSource(`owner/repo@${'a'.repeat(40)}`)).toBeNull();
    expect(friendlyProviderPluginError('Could not fetch plugin https://github.com/owner/repo.git@50533d8 (fatal: Remote branch 50533d8 not found in upstream origin)'))
      .toContain('find that commit');
  });

  it('stores an API key while returning only redacted provider status', async () => {
    const payload = await saveProviderApiKey('openai', 'super-secret-key');
    const openai = payload.status.providers.find((provider) => provider.id === 'openai');

    expect(openai?.configured).toBe(true);
    expect(openai?.sources).toMatchObject([{ priority: 3, kind: 'api_key', name: 'Stored API key', stored: true, active: true, health: { state: 'verified' } }]);
    expect(JSON.stringify(payload)).not.toContain('super-secret-key');
    expect((await AuthStorage.getApiKey('openai'))?.key).toBe('super-secret-key');

    const removed = await removeProviderCredential('openai', 'api_key');
    expect(removed.status.providers.find((provider) => provider.id === 'openai')?.configured).toBe(false);
  });

  it('validates and manages custom OpenAI-compatible providers', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/models')
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const payload = await saveCustomProvider({ name: 'Local_Models', baseURL: 'http://localhost:11434/v1/', key: 'local-secret', models: ['qwen3'] });
    expect(payload.status.customProviders).toMatchObject([{ id: 'local_models', baseURL: 'http://localhost:11434/v1', hasApiKey: true, api: 'openai-completions', models: ['qwen3'] }]);
    expect(JSON.stringify(payload)).not.toContain('local-secret');

    await expect(saveCustomProvider({ name: 'openai', baseURL: 'http://localhost:11434/v1', models: ['qwen3'] })).rejects.toThrow('reserved');
    expect((await removeCustomProvider('local_models')).status.customProviders).toEqual([]);
  });

  it('preserves CLI compatibility overrides through the shared custom-provider service', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/models')
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const configured = await configureCustomProvider({
      name: 'compat_proxy',
      baseURL: 'http://localhost:8080/v1',
      api: 'openai-completions',
      models: ['local-model'],
      compatibility: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    });

    expect(configured.provider.compatibility).toEqual({ supportsDeveloperRole: false, maxTokensField: 'max_tokens' });
    expect((await AuthStorage.getCustomProvider('compat_proxy'))?.compatibility)
      .toEqual({ supportsDeveloperRole: false, maxTokensField: 'max_tokens' });
  });

  it('checks the runtime endpoint without saving provider configuration', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    await expect(checkCustomProvider({
      name: 'lmstudio',
      baseURL: 'http://127.0.0.1:1234',
    })).resolves.toEqual({
      name: 'lmstudio',
      baseURL: 'http://127.0.0.1:1234/v1',
      api: 'openai-completions',
      models: ['local-model'],
    });
    expect(await AuthStorage.getCustomProvider('lmstudio')).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/models', expect.anything());
  });

  it('uses a manual Anthropic model when the endpoint has no model discovery API', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/models')
      ? new Response('missing', { status: 404 })
      : new Response(JSON.stringify({ content: [] }), { status: 200 }));
    await expect(checkCustomProvider({
      name: 'claude-gateway',
      baseURL: 'http://localhost:8080/v1',
      api: 'anthropic-messages',
      models: ['claude-compatible'],
    })).resolves.toMatchObject({ api: 'anthropic-messages', models: ['claude-compatible'] });
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8080/v1/messages', expect.objectContaining({ method: 'POST' }));
  });

  it('automatically detects an OpenAI Responses endpoint', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'response-model' }] }), { status: 200 });
      if (url.endsWith('/responses')) return new Response(JSON.stringify({ output: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: 'not supported' } }), { status: 404 });
    });
    await expect(checkCustomProvider({
      name: 'response-gateway',
      baseURL: 'http://localhost:8080/v1',
      api: 'auto',
    })).resolves.toMatchObject({ api: 'openai-responses', models: ['response-model'] });
  });

  it('treats a saved keyless custom endpoint as ready for agent creation', () => {
    expect(hasConfiguredProvider({
      credentialStore: '/redacted/path',
      providers: [{ id: 'openai', name: 'OpenAI', configured: false, sources: [] }],
      customProviders: [{ id: 'ollama', baseURL: 'http://localhost:11434/v1', hasApiKey: false }],
    })).toBe(true);
  });

  it('returns the provider catalog and active environment sources without exposing values', async () => {
    process.env.OPENROUTER_API_KEY = 'environment-secret';
    const payload = await providerSetupSnapshot();
    expect(payload.catalog.map((provider) => provider.id)).toEqual(['anthropic', 'openai', 'openrouter', 'opencode-go']);
    expect(payload.pluginRegistry.filter((entry) => entry.id !== 'pi-cli')).toEqual([{
      id: 'claude-code-subscription',
      packageName: 'agentuse-claude-code-provider',
      version: '0.1.0',
      name: 'Claude Code Subscription',
      description: 'Use Anthropic models through an eligible Claude Pro or Max subscription.',
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
      commit: 'b3240daac509f0512321cb4677b2e9ee39651a8d',
      repository: 'https://github.com/cb7337/agentuse-claude-code-provider',
      publisher: 'cb7337',
      provenance: 'community',
      provider: 'anthropic',
      authMethods: ['oauth'],
      authMethodId: 'subscription',
      apiVersion: 1,
    }]);
    expect(payload.status.providers.find((provider) => provider.id === 'openrouter')?.sources[0]?.name).toBe('OPENROUTER_API_KEY');
    expect(JSON.stringify(payload)).not.toContain('environment-secret');
    expect(providerSetupOptions({ success: true, ...payload })).toContainEqual({
      value: 'plugin:claude-code-subscription',
      label: 'Claude Code Subscription',
      group: 'Community plugins',
      meta: 'cb7337 · v0.1.0',
      badge: 'Community',
    });
    expect(providerSetupOptions({ success: true, ...payload }, false, 'provider', 'openai').map((item) => item.value))
      .toEqual(['openai']);
    expect(providerSetupOptions({ success: true, ...payload }, false, 'plugins').map((item) => item.value))
      .toEqual(['plugin:pi-cli', 'plugin:claude-code-subscription', 'plugin:advanced']);
    expect(providerSetupOptions({ success: true, ...payload }, true).map((item) => [item.value, item.group]))
      .toEqual([
        ['anthropic', 'Built in'],
        ['openai', 'Built in'],
        ['openrouter', 'Built in'],
        ['opencode-go', 'Built in'],
        ['custom', 'Built in'],
        ['plugin:claude-code-subscription', 'Community plugins'],
        ['plugin:advanced', 'Advanced'],
      ]);

    const withInstalledPlugin = {
      success: true as const,
      ...payload,
      installedPlugins: [{
        packageName: 'agentuse-claude-code-provider',
        name: 'Claude Code Subscription',
        version: '0.1.0',
        source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
        publisher: 'cb7337',
        provenance: 'community' as const,
        providers: [{ id: 'anthropic', authMethods: ['oauth' as const] }],
      }],
    };
    expect(providerSetupOptions(withInstalledPlugin, false, 'provider', 'anthropic').map((item) => item.value))
      .toEqual(['anthropic', 'plugin:claude-code-subscription']);
    expect(providerSetupOptions(withInstalledPlugin, false, 'plugins').map((item) => item.value))
      .toEqual(['plugin:pi-cli', 'plugin:advanced']);
  });

  it('offers only missing supported connection methods without blocking plugin installation', async () => {
    const payload = { success: true as const, ...await providerSetupSnapshot() };
    payload.status.providers = [
      { id: 'openrouter', name: 'OpenRouter', configured: true, sources: [{ kind: 'api_key', name: 'Stored API key', stored: true, active: true, priority: 3 }] },
      { id: 'opencode-go', name: 'OpenCode Go', configured: true, sources: [{ kind: 'environment', name: 'OPENCODE_GO_API_KEY', stored: false, active: true, priority: 2 }] },
      { id: 'openai', name: 'OpenAI', configured: true, sources: [{ kind: 'oauth', name: 'ChatGPT', stored: true, active: true, priority: 1 }] },
    ];
    let missing = missingProviderMethods(payload);
    expect(providerSetupOptions(missing, false, 'provider', 'openrouter')).toEqual([]);
    expect(providerSetupOptions(missing, false, 'provider', 'opencode-go')).toEqual([]);
    expect(missing.catalog.find((p) => p.id === 'openai')?.authMethods).toEqual(['api_key']);
    payload.status.providers.find((p) => p.id === 'openai')!.sources.push({ kind: 'api_key', name: 'Stored API key', stored: true, active: false, priority: 3 });
    missing = missingProviderMethods(payload);
    expect(providerSetupOptions(missing, false, 'provider', 'openai')).toEqual([]);
    expect(providerSetupOptions(missing, false, 'provider', 'anthropic').map((p) => p.value)).toContain('plugin:claude-code-subscription');
    const plugin = payload.pluginRegistry.find((entry) => entry.id === 'claude-code-subscription')!;
    payload.status.providers.push({ id: plugin.provider, name: plugin.name, configured: true, sources: [{ kind: 'oauth', name: 'Subscription', stored: true, active: true, priority: 1, plugin: { name: plugin.packageName, authMethodId: plugin.authMethodId } }] });
    expect(providerSetupOptions(missingProviderMethods(payload), false, 'provider', plugin.provider).map((p) => p.value)).not.toContain(`plugin:${plugin.id}`);
    // Add connection still exposes installation independently of method maintenance.
    expect(providerSetupOptions(payload, true).map((p) => p.value)).toContain(`plugin:${plugin.id}`);
    payload.status.providers.find((p) => p.id === 'openrouter')!.sources = [];
    expect(missingProviderMethods(payload).catalog.find((p) => p.id === 'openrouter')?.authMethods).toEqual(['api_key']);
  });

  it('keeps built-in OpenAI OAuth verifier state server-side', async () => {
    const authorize = spyOn(CodexAuth, 'authorize').mockResolvedValue({
      url: 'https://auth.openai.com/oauth/authorize?public=yes',
      pkce: { verifier: 'private-verifier', challenge: 'public-challenge' },
    });
    const started = await startProviderOAuth('openai');

    expect(started.authorizationUrl).toContain('openai.com');
    expect(JSON.stringify(started)).not.toContain('private-verifier');
    expect(started.flowId.length).toBeGreaterThan(20);
    const exchange = spyOn(CodexAuth, 'exchange').mockResolvedValue({
      refresh: 'refresh-secret',
      access: 'access-secret',
      expires: Date.now() + 60_000,
      accountId: 'account-1',
    });
    const completed = await completeProviderOAuth(started.flowId, 'authorization-code');
    expect(completed.status.providers.find((provider) => provider.id === 'openai')?.configured).toBe(true);
    expect(await AuthStorage.getOAuth('openai')).toMatchObject({
      type: 'codex-oauth',
      access: 'access-secret',
      refresh: 'refresh-secret',
    });
    expect(JSON.stringify(completed)).not.toContain('access-secret');
    expect(exchange).toHaveBeenCalledWith('authorization-code', {
      verifier: 'private-verifier',
      challenge: 'public-challenge',
    });
    await expect(completeProviderOAuth(started.flowId, 'authorization-code')).rejects.toThrow('expired or was not found');
    exchange.mockRestore();
    authorize.mockRestore();
  });

  it('names the missing subscription plugin when only a migrated credential exists', async () => {
    await AuthStorage.setPluginCredential('anthropic', 'subscription', {
      type: 'oauth', access: 'saved-access', refresh: 'saved-refresh', expires: Date.now() + 3600_000,
    });
    const { createModel } = await import('../src/models');
    await expect(createModel('anthropic:claude-sonnet-5'))
      .rejects.toThrow('agentuse plugins install cb7337/agentuse-claude-code-provider@v0.1.0');
  });

  it('cancels a pending plugin OAuth flow so it cannot be completed later', async () => {
    await addClaudePluginFixture();
    const started = await startProviderPluginOAuth('claude-code-subscription');
    if (started.connected) throw new Error('Expected an OAuth flow');

    expect(cancelProviderOAuth(started.flowId)).toEqual({ cancelled: true });
    expect(cancelProviderOAuth(started.flowId)).toEqual({ cancelled: false });
    await expect(completeProviderPluginOAuth(started.flowId, 'valid-code'))
      .rejects.toThrow('expired or was not found');
  });

  it('refuses an unreviewed plugin install without the inspected commit', async () => {
    await expect(installUnreviewedProviderPlugin('owner/some-plugin', undefined))
      .rejects.toThrow('confirm the commit before installing');
    await expect(startUnreviewedProviderPluginOAuth('owner/some-plugin@v1.0.0', undefined))
      .rejects.toThrow('confirm the commit before installing');
    await expect(startUnreviewedProviderPluginOAuth('owner/some-plugin@v1.0.0', 'main'))
      .rejects.toThrow('confirm the commit before installing');
  });

  it('lists Pi CLI for installation without offering browser OAuth', async () => {
    const payload = { success: true as const, ...await providerSetupSnapshot() };
    expect(payload.pluginRegistry.find((entry) => entry.id === 'pi-cli')).toMatchObject({
      packageName: 'agentuse-pi-cli-provider', version: '0.3.0', provider: 'pi',
      commit: '50533d8b3227687346f2887010ea858580e80d22', authMethods: [], publisher: 'leonho',
    });
    expect(providerSetupOptions(payload, false, 'plugins').map((entry) => entry.value)).toContain('plugin:pi-cli');
    expect(providerSetupOptions(payload).map((entry) => entry.value)).not.toContain('plugin:pi-cli');
    await expect(startProviderPluginOAuth('pi-cli')).rejects.toThrow('manages authentication externally');
  });

  it('completes installation for a CLI provider without OAuth and safely retries an existing installation', async () => {
    await addClaudePluginFixture();
    const directory = path.join(tempDir, 'plugins', 'agentuse-claude-code-provider-fixture');
    await fs.writeFile(path.join(directory, 'index.js'), `export default function (agentuse) {
      agentuse.registerProvider('anthropic', { name: 'CLI provider', models: { inherit: 'anthropic' }, transport: { kind: 'anthropic-messages' }, async when() { return true; } });
    }`);
    resetProviderPluginCache();
    const commit = 'a'.repeat(40);
    const inspection = spyOn(installer, 'inspectPluginSource').mockResolvedValue({
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0', repository: 'https://github.com/cb7337/agentuse-claude-code-provider',
      publisher: 'cb7337', ref: 'v0.1.0', commit, name: 'agentuse-claude-code-provider', version: '0.1.0', apiVersion: 1, providers: [],
    });
    const install = spyOn(installer, 'installPlugin');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await installUnreviewedProviderPlugin('cb7337/agentuse-claude-code-provider@v0.1.0', commit);
        expect(result.installedPlugins[0]?.providers).toEqual([{ id: 'anthropic', authMethods: [] }]);
      }
      expect(install).not.toHaveBeenCalled();
      await expect(installUnreviewedProviderPlugin('cb7337/agentuse-claude-code-provider@v0.1.0', 'b'.repeat(40))).rejects.toThrow('changed since it was inspected');
    } finally {
      inspection.mockRestore();
      install.mockRestore();
    }
  });

  it('rejects new Anthropic OAuth through the removed built-in flow', async () => {
    await expect(startProviderOAuth('anthropic')).rejects.toThrow('does not support OAuth setup');
  });

  it('installs the shortlisted plugin and adopts existing Anthropic OAuth without login', async () => {
    await addClaudePluginFixture();
    await AuthStorage.setOAuth('anthropic', {
      type: 'oauth', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 3600_000,
    });

    const started = await startProviderPluginOAuth('claude-code-subscription');

    expect(started.connected).toBe(true);
    expect(await AuthStorage.getOAuth('anthropic')).toBeUndefined();
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toMatchObject({
      access: 'legacy-access', refresh: 'legacy-refresh',
    });
    if (started.connected) {
      expect(started.snapshot.status.providers.find((provider) => provider.id === 'anthropic')?.configured).toBe(true);
    }
  });

  it('does not report the subscription as connected when only an API key exists', async () => {
    await addClaudePluginFixture();
    process.env.ANTHROPIC_API_KEY = 'api-key-only';

    const started = await startProviderPluginOAuth('claude-code-subscription');

    expect(started.connected).toBe(false);
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toBeUndefined();
  });

  it('runs new Claude subscription login through the shortlisted plugin', async () => {
    await addClaudePluginFixture();
    const started = await startProviderPluginOAuth('claude-code-subscription');
    expect(started.connected).toBe(false);
    if (started.connected) throw new Error('Expected an OAuth flow');
    expect(started.authorizationUrl).toContain('claude.ai/oauth/authorize');

    const completed = await completeProviderPluginOAuth(started.flowId, 'valid-code');

    expect(completed.status.providers.find((provider) => provider.id === 'anthropic')?.configured).toBe(true);
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toMatchObject({
      access: 'new-access', refresh: 'new-refresh',
    });
  });

  it('removes OAuth credentials owned by an installed provider plugin', async () => {
    await addClaudePluginFixture();
    await AuthStorage.setPluginCredential('anthropic', 'subscription', {
      type: 'oauth', access: 'plugin-access', refresh: 'plugin-refresh', expires: Date.now() + 3600_000,
    });

    const beforeRemoval = await providerSetupSnapshot();
    expect(beforeRemoval.status.providers.find((provider) => provider.id === 'anthropic')?.sources[0]?.plugin)
      .toEqual({ name: 'agentuse-claude-code-provider', authMethodId: 'subscription' });

    const removed = await removeProviderCredential(
      'anthropic',
      'oauth',
      'agentuse-claude-code-provider',
      'subscription',
    );

    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toBeUndefined();
    expect(removed.status.providers.find((provider) => provider.id === 'anthropic')?.configured).toBe(false);
  });

  it('detects a migrated credential when the shortlisted package needs reinstalling', async () => {
    await AuthStorage.setPluginCredential('anthropic', 'subscription', {
      type: 'oauth', access: 'saved-access', refresh: 'saved-refresh', expires: Date.now() + 3600_000,
    });

    const payload = await providerSetupSnapshot();

    expect(payload.status.providers.find((provider) => provider.id === 'anthropic')).toMatchObject({
      configured: false,
      actionRequired: 'Claude subscription OAuth is present but its provider plugin is not installed. Run: agentuse plugins install cb7337/agentuse-claude-code-provider@v0.1.0',
    });
    expect(defaultProviderSetupSelection({ success: true, ...payload })).toBe('plugin:claude-code-subscription');
  });

  it('refuses installation outside the release-owned shortlist', async () => {
    await expect(installProviderPluginFromRegistry('owner/unreviewed-plugin'))
      .rejects.toThrow('is not shortlisted');
  });
});
