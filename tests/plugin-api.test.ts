import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PluginHost, PluginManager } from '../src/plugin';
import {
  checkProviderReadiness,
  createCustomProviderModel,
  getInstalledPluginHost,
  getActiveProviderAdapter,
  getProviderPatch,
  getProviderPlugin,
  loadProviderPlugins,
  loadedPluginModel,
  loadedPluginProtocol,
  mergeProviderTransportHeaders,
  resetProviderPluginCache,
  resolveProviderAuth,
} from '../src/plugin/provider-runtime';
import { importExtensionModule, readPackageManifest } from '../src/plugin/loader';
import type { AgentCompleteEvent, ProviderDefinition, ProviderRequest } from '../src/plugin/types';
import type { AgentUseExtension } from 'agentuse/plugin-api';
import { resolveModelInfo } from '../src/utils/model-utils';
import { AuthStorage } from '../src/auth/storage';
import { spyOn } from 'bun:test';
import { getProviderReadiness, getProviderStatus } from '../src/auth/provider-status';
import { createModel } from '../src/models';
import { applyProviderSystemMessages } from '../src/plugin/provider-behavior';

const event: AgentCompleteEvent = {
  agent: { name: 'test-agent', model: 'demo:test' },
  result: { text: 'original', duration: 1, toolCalls: 0, hasTextOutput: true },
  isSubAgent: false,
  consoleOutput: '',
};

describe('AgentUse activation API', () => {
  it('merges Anthropic beta headers without losing SDK-provided features', () => {
    const headers = new Headers({ 'anthropic-beta': 'prompt-caching-2024-07-31,oauth-2025-04-20' });
    mergeProviderTransportHeaders(headers, {
      'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14',
      'x-plugin': 'enabled',
    });
    expect(headers.get('anthropic-beta')).toBe(
      'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14',
    );
    expect(headers.get('x-plugin')).toBe('enabled');
  });

  it('registers isolated event handlers and disposes the complete activation', async () => {
    const host = new PluginHost();
    const observed: string[] = [];
    const extension: AgentUseExtension = (agentuse) => {
      agentuse.on('agent:complete', (value: AgentCompleteEvent) => { value.result.text = 'mutated'; });
      agentuse.on('agent:complete', (value: AgentCompleteEvent) => {
        observed.push(value.result.text);
      });
    };
    const activation = await host.activate({ name: 'events', source: 'test', scope: 'local' }, extension);

    await host.emit('agent:complete', event);
    expect(observed).toEqual(['original']);
    expect(event.result.text).toBe('original');

    await activation.dispose();
    await host.emit('agent:complete', event);
    expect(observed).toHaveLength(1);
  });

  it('shares mutable tool input in order and stops dispatch after a block', async () => {
    const host = new PluginHost();
    const observed: unknown[] = [];
    await host.activate({ name: 'tool-policy', source: 'test', scope: 'local' }, (agentuse) => {
      agentuse.on('tool:call', (value) => {
        value.input.limit = 10;
      });
      agentuse.on('tool:call', (value) => {
        observed.push(value.input.limit);
        return { block: true, reason: 'policy', terminate: true };
      });
      agentuse.on('tool:call', () => {
        observed.push('unreachable');
      });
    });

    const call = { toolCallId: 'call-1', toolName: 'search', input: {} };
    await expect(host.dispatchToolCall(call)).resolves.toEqual({
      block: true,
      reason: 'policy',
      terminate: true,
    });
    expect(call.input).toEqual({ limit: 10 });
    expect(observed).toEqual([10]);
  });

  it('chains returned tool results and final text without mutating source events', async () => {
    const host = new PluginHost();
    await host.activate({ name: 'transforms', source: 'test', scope: 'local' }, (agentuse) => {
      agentuse.on('tool:result', (value) => ({ output: `${value.output}-one` }));
      agentuse.on('tool:result', (value) => ({ output: `${value.output}-two`, isError: false }));
      agentuse.on('agent:complete', (value) => ({ text: `${value.result.text}-one` }));
      agentuse.on('agent:complete', (value) => ({ text: `${value.result.text}-two` }));
    });

    const toolResult = {
      toolCallId: 'call-1',
      toolName: 'search',
      input: {},
      output: 'original',
      isError: true,
    };
    const transformedTool = await host.dispatchToolResult(toolResult);
    const transformedComplete = await host.dispatchAgentComplete(event);

    expect(transformedTool).toMatchObject({ output: 'original-one-two', isError: false });
    expect(toolResult).toMatchObject({ output: 'original', isError: true });
    expect(transformedComplete.result.text).toBe('original-one-two');
    expect(event.result.text).toBe('original');
  });

  it('isolates observational event snapshots between handlers', async () => {
    const host = new PluginHost();
    let observed = '';
    await host.activate({ name: 'observers', source: 'test', scope: 'local' }, (agentuse) => {
      agentuse.on('agent:start', (value) => {
        (value.agent as { name: string }).name = 'mutated';
      });
      agentuse.on('agent:start', (value) => {
        observed = value.agent.name;
      });
    });

    await host.emit('agent:start', {
      agent: { name: 'original', model: 'demo:test' },
      trigger: 'manual',
    });
    expect(observed).toBe('original');
  });

  it('exposes only capability methods and the host logger', async () => {
    const host = new PluginHost();
    let keys: string[] = [];
    await host.activate({ name: 'surface', source: 'test', scope: 'local' }, (agentuse) => {
      keys = Object.keys(agentuse).sort();
    });

    expect(keys).toEqual(['log', 'on', 'registerProvider', 'unregisterProvider']);
  });

  it('registers providers, patches, explicit overrides, and ownership', async () => {
    const host = new PluginHost();
    await host.activate({ name: 'provider-package', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider({
        id: 'local-models',
        name: 'Local Models',
        models: [],
        transport: { kind: 'custom', apiVersion: 1, async *stream() { yield { type: 'finish', reason: 'stop' }; } },
      });
      agentuse.registerProvider('openai', { baseURL: 'https://proxy.test/v1', headers: { 'X-Test': 'yes' } });
      agentuse.registerProvider('anthropic', {
        name: 'Subscription transport',
        transport: { kind: 'anthropic-messages' },
        when: () => true,
      });
      agentuse.registerProvider({
        id: 'anthropic', override: true, name: 'Replacement', models: [],
        transport: { kind: 'custom', apiVersion: 1, async *stream() { yield { type: 'finish', reason: 'stop' }; } },
      });
    });

    expect(host.getProviderOwner('local-models')?.name).toBe('provider-package');
    expect(host.getProvider('anthropic')?.override).toBe(true);
    expect(host.getProviderPatch('openai')).toEqual({
      baseURL: 'https://proxy.test/v1', headers: { 'X-Test': 'yes' },
    });
    expect(host.getProviderAdapterContributions('anthropic')).toHaveLength(1);
  });

  it('adapts the stable custom stream contract without exposing AI SDK types to plugins', async () => {
    let observed: ProviderRequest | undefined;
    let observedSessionId: string | undefined;
    const provider: ProviderDefinition = {
      id: 'native-stream',
      name: 'Native Stream',
      models: [],
      transport: {
        kind: 'custom',
        apiVersion: 1,
        async *stream(request, context) {
          observed = request;
          observedSessionId = context.sessionId;
          yield { type: 'warning', feature: 'temperature', message: 'Ignored' };
          yield { type: 'reasoning-delta', delta: 'Think' };
          yield { type: 'text-delta', delta: 'Hello' };
          yield { type: 'tool-call', id: 'call-1', name: 'done', input: { ok: true } };
          yield { type: 'response-metadata', id: 'response-1', modelId: 'remote-model', timestamp: 1_000 };
          yield {
            type: 'finish',
            reason: 'tool-calls',
            rawReason: 'toolUse',
            usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 },
          };
        },
      },
    };
    const model = createCustomProviderModel(provider, 'model', 'session-123');
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      temperature: 0.5,
      tools: [{ type: 'function', name: 'done', inputSchema: { type: 'object' } }],
    });

    expect(observed?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
    expect(observedSessionId).toBe('session-123');
    expect(observed?.tools[0]).toMatchObject({ type: 'function', name: 'done' });
    expect(result.content).toEqual([
      { type: 'reasoning', text: 'Think' },
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'done', input: '{"ok":true}' },
    ]);
    expect(result.finishReason).toEqual({ unified: 'tool-calls', raw: 'toolUse' });
    expect(result.usage.inputTokens).toEqual({ total: 10, noCache: 10, cacheRead: 2, cacheWrite: undefined });
    expect(result.response).toMatchObject({ id: 'response-1', modelId: 'remote-model' });
    expect(result.warnings).toEqual([{ type: 'unsupported', feature: 'temperature', details: 'Ignored' }]);

    const streamed = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    });
    const parts = [];
    for await (const part of streamed.stream) parts.push(part);
    expect(parts[0]).toEqual({
      type: 'stream-start',
      warnings: [{ type: 'unsupported', feature: 'temperature', details: 'Ignored' }],
    });
    expect(parts).toContainEqual({ type: 'reasoning-start', id: 'reasoning-0' });
    expect(parts).toContainEqual({ type: 'reasoning-end', id: 'reasoning-0' });
    expect(parts).toContainEqual({ type: 'text-start', id: 'text-0' });
    expect(parts).toContainEqual({ type: 'text-end', id: 'text-0' });
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish' }));
  });

  it('rejects a custom provider stream that omits its terminal finish event', async () => {
    const provider: ProviderDefinition = {
      id: 'unfinished-stream',
      name: 'Unfinished Stream',
      models: [],
      transport: {
        kind: 'custom',
        apiVersion: 1,
        async *stream() { yield { type: 'text-delta', delta: 'partial' }; },
      },
    };
    const model = createCustomProviderModel(provider, 'model');
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow('ended without a finish event');
  });

  it('rejects accidental built-in replacement and duplicate provider IDs', async () => {
    const host = new PluginHost();
    await expect(host.activate({ name: 'bad', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider({ id: 'openai', name: 'Oops', models: [], transport: { kind: 'openai-responses' } });
    })).rejects.toThrow('set override: true');

    await host.activate({ name: 'one', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider({ id: 'same', name: 'One', models: [], transport: { kind: 'openai-responses' } });
    });
    await expect(host.activate({ name: 'two', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider({ id: 'same', name: 'Two', models: [], transport: { kind: 'openai-responses' } });
    })).rejects.toThrow("already registered by one");

    await expect(host.activate({ name: 'legacy-custom', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider({
        id: 'legacy-custom', name: 'Legacy Custom', models: [],
        transport: { kind: 'custom', async createModel() {} },
      });
    })).rejects.toThrow('must define apiVersion: 1 and stream()');

    await expect(host.activate({ name: 'bad-extension', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider('not-built-in', {
        name: 'Invalid extension', transport: { kind: 'openai-responses' }, when: () => true,
      });
    })).rejects.toThrow('can only extend a built-in provider');
  });
});

describe('project-local activation scope', () => {
  let root: string | undefined;
  let oldDataDir: string | undefined;

  afterEach(async () => {
    resetProviderPluginCache();
    if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = oldDataDir;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('makes a loose activation-function provider available in its async run scope', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-activation-plugin-'));
    const plugins = path.join(root, 'plugins');
    const dataDir = path.join(root, 'data');
    const installed = path.join(dataDir, 'plugins');
    await fs.mkdir(plugins);
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(plugins, 'local.js'), `
      export default async function (agentuse) {
        agentuse.registerProvider({
          id: 'scoped-provider', name: 'Scoped Provider',
          models: [{ id: 'model', name: 'Model', input: ['text'], reasoning: false, contextWindow: 1000, maxOutputTokens: 100 }],
          transport: { kind: 'openai-chat-completions', baseURL: 'http://localhost:1234/v1' }
        });
      }
    `);
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();

    const manager = new PluginManager();
    await manager.loadPlugins([plugins]);
    expect((await getProviderPlugin('scoped-provider'))?.name).toBe('Scoped Provider');
    expect(resolveModelInfo('scoped-provider:model')).toMatchObject({
      name: 'Model', limit: { context: 1000, output: 100 },
    });
    expect(await getProviderPatch('scoped-provider')).toBeUndefined();
  });

  it('reports a failed readiness check as not configured and refuses to build the model', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-readiness-plugin-'));
    const plugins = path.join(root, 'plugins');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(plugins);
    await fs.mkdir(path.join(dataDir, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(plugins, 'local.js'), `
      export default function (agentuse) {
        agentuse.registerProvider({
          id: 'bridge', name: 'Bridge',
          models: [{ id: 'model', name: 'Model', input: ['text'], reasoning: false, contextWindow: 1000, maxOutputTokens: 100 }],
          transport: { kind: 'openai-chat-completions', baseURL: 'http://localhost:1234/v1' },
          check: (context) => context.env.BRIDGE_READY === '1'
            ? { ok: true, detail: 'bridge 1.0' }
            : { ok: false, message: 'Bridge CLI not found.', fix: 'npm install -g bridge' },
        });
      }
    `);
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    delete process.env.BRIDGE_READY;
    resetProviderPluginCache();
    const manager = new PluginManager();
    await manager.loadPlugins([plugins]);

    const missing = (await getProviderStatus({ provider: 'bridge' })).providers.find((provider) => provider.id === 'bridge');
    expect(missing).toMatchObject({
      configured: false,
      readiness: { ok: false, message: 'Bridge CLI not found.', fix: 'npm install -g bridge' },
      actionRequired: 'Bridge CLI not found. Fix: npm install -g bridge',
    });
    // try/catch rather than expect().rejects: the matcher's continuation
    // leaves the plugin activation scope that the follow-up status read needs.
    let failure: unknown;
    try {
      await createModel('bridge:model');
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe('Bridge CLI not found. Fix: npm install -g bridge');

    // Deferred snapshots use cached health and do not repeat a fresh check.
    const deferred = (await getProviderStatus({ readiness: 'defer' })).providers.find((provider) => provider.id === 'bridge');
    expect(deferred).toMatchObject({ configured: false, health: { state: 'temporarily_unavailable' } });
    expect(deferred?.checkPending).toBeUndefined();
    expect(deferred?.readiness?.ok).toBe(false);
    expect(await getProviderReadiness({ provider: 'bridge' })).toMatchObject([{
      id: 'bridge',
      configured: false,
      readiness: { ok: false, message: 'Bridge CLI not found.', fix: 'npm install -g bridge' },
      actionRequired: 'Bridge CLI not found. Fix: npm install -g bridge',
    }]);

    process.env.BRIDGE_READY = '1';
    try {
      const ready = (await getProviderStatus({ provider: 'bridge', force: true })).providers.find((provider) => provider.id === 'bridge');
      expect(ready).toMatchObject({ configured: true, readiness: { ok: true, detail: 'bridge 1.0' } });
      expect(ready?.actionRequired).toBeUndefined();
      expect(await getProviderReadiness({ provider: 'bridge' })).toMatchObject([{ id: 'bridge', configured: true, readiness: { ok: true, detail: 'bridge 1.0' } }]);
    } finally {
      delete process.env.BRIDGE_READY;
    }
  });

  it('activates a built-in provider adapter only when its credential predicate matches', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-extension-plugin-'));
    const plugins = path.join(root, 'plugins');
    const dataDir = path.join(root, 'data');
    const installed = path.join(dataDir, 'plugins');
    await fs.mkdir(plugins);
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(plugins, 'local.js'), `
      export default function (agentuse) {
        agentuse.registerProvider('anthropic', {
          name: 'Claude subscription',
          models: { inherit: 'anthropic', patch: { cost: { input: 0, output: 0 } } },
          transport: { kind: 'anthropic-messages', headers: { 'anthropic-beta': 'oauth' } },
          auth: { methods: [{
            id: 'subscription', type: 'oauth', name: 'Subscription OAuth',
            environment: ['TEST_CLAUDE_OAUTH'],
            async login() { return {}; },
            async refresh() { throw new Error('stored credential must not refresh'); },
            resolve({ credential }, context) {
              const token = context.env.TEST_CLAUDE_OAUTH ?? credential?.access;
              return token ? { bearerToken: token, source: 'test' } : undefined;
            }
          }] },
          async when(context) { return Boolean(await context.auth.resolve('subscription')); }
        });
      }
    `);
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    delete process.env.TEST_CLAUDE_OAUTH;
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    (AuthStorage as any).AUTH_FILE = path.join(root, 'auth.json');
    resetProviderPluginCache();

    try {
      const manager = new PluginManager();
      await manager.loadPlugins([plugins]);
      expect(await getActiveProviderAdapter('anthropic', 'claude-test')).toBeUndefined();

      process.env.TEST_CLAUDE_OAUTH = 'oauth-token';
      process.env.ANTHROPIC_API_KEY = 'api-key';
      await AuthStorage.setPluginCredential('anthropic', 'subscription', {
        type: 'oauth', access: 'expired', refresh: 'stale', expires: 0,
      });
      expect(await getActiveProviderAdapter('anthropic', 'claude-test')).toMatchObject({
        id: 'anthropic',
        name: 'Claude subscription',
        transport: { headers: { 'anthropic-beta': 'oauth' } },
      });
      expect(resolveModelInfo('anthropic:claude-sonnet-4-5')?.cost).toMatchObject({ input: 0, output: 0 });
      expect((await getProviderStatus()).providers.find((provider) => provider.id === 'anthropic')?.sources).toMatchObject([
        {
          priority: 1,
          kind: 'environment',
          name: 'TEST_CLAUDE_OAUTH',
          stored: false,
          active: true,
        },
        {
          priority: 1,
          kind: 'oauth',
          name: 'Subscription OAuth',
          stored: true,
          active: false,
          plugin: { name: 'local.js', authMethodId: 'subscription' },
        },
        {
          priority: 2,
          kind: 'environment',
          name: 'ANTHROPIC_API_KEY',
          stored: false,
          active: false,
        },
      ]);
      delete process.env.TEST_CLAUDE_OAUTH;
      await AuthStorage.removePluginCredential('anthropic', 'subscription');
      expect(await getActiveProviderAdapter('anthropic', 'claude-test')).toBeUndefined();
      expect(resolveModelInfo('anthropic:claude-sonnet-4-5')?.cost).toMatchObject({ input: 3, output: 15 });
    } finally {
      delete process.env.TEST_CLAUDE_OAUTH;
      if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
    }
  });

  it('keeps conditional adapter metadata isolated across concurrent project scopes', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-adapter-scope-'));
    const dataDir = path.join(root, 'data');
    const installed = path.join(dataDir, 'plugins');
    const pluginsA = path.join(root, 'plugins-a');
    const pluginsB = path.join(root, 'plugins-b');
    await Promise.all([fs.mkdir(installed, { recursive: true }), fs.mkdir(pluginsA), fs.mkdir(pluginsB)]);
    const extension = (name: string, output: number, transport: string) => `
      export default function (agentuse) {
        agentuse.registerProvider('anthropic', {
          name: ${JSON.stringify(name)},
          models: [{ id: 'claude-scope', name: ${JSON.stringify(name)}, input: ['text'], reasoning: false, contextWindow: 1000, maxOutputTokens: ${output} }],
          transport: { kind: ${JSON.stringify(transport)} },
          when() { return true; }
        });
      }
    `;
    await Promise.all([
      fs.writeFile(path.join(pluginsA, 'adapter.js'), extension('Project A', 111, 'anthropic-messages')),
      fs.writeFile(path.join(pluginsB, 'adapter.js'), extension('Project B', 222, 'openai-responses')),
    ]);
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();

    let ready = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => { release = resolve; });
    const run = async (plugins: string) => {
      const manager = new PluginManager();
      await manager.loadPlugins([plugins]);
      const selected = await getActiveProviderAdapter('anthropic', 'claude-scope');
      ready++;
      if (ready === 2) release();
      await rendezvous;
      return {
        name: selected?.name,
        output: resolveModelInfo('anthropic:claude-scope')?.limit.output,
        protocol: loadedPluginProtocol('anthropic'),
      };
    };

    await expect(Promise.all([run(pluginsA), run(pluginsB)])).resolves.toEqual([
      { name: 'Project A', output: 111, protocol: 'anthropic' },
      { name: 'Project B', output: 222, protocol: 'openai' },
    ]);
  });

  it('honors an explicit API-key suffix even when a provider adapter matches', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-adapter-explicit-env-'));
    const dataDir = path.join(root, 'data');
    const installed = path.join(dataDir, 'plugins');
    const plugins = path.join(root, 'plugins');
    await Promise.all([fs.mkdir(installed, { recursive: true }), fs.mkdir(plugins)]);
    await fs.writeFile(path.join(plugins, 'adapter.js'), `
      export default function (agentuse) {
        agentuse.registerProvider('anthropic', {
          name: 'Always-on adapter',
          models: { inherit: 'anthropic' },
          transport: { kind: 'anthropic-messages', baseURL: 'https://adapter.invalid' },
          when() { return true; }
        });
      }
    `);
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    const oldKey = process.env.ANTHROPIC_API_KEY_DEV;
    const oldBase = process.env.ANTHROPIC_BASE_URL_DEV;
    process.env.ANTHROPIC_API_KEY_DEV = 'explicit-key';
    process.env.ANTHROPIC_BASE_URL_DEV = 'https://explicit.example.com';
    resetProviderPluginCache();

    try {
      const manager = new PluginManager();
      await manager.loadPlugins([plugins]);
      expect(await getActiveProviderAdapter('anthropic', 'claude-3-haiku')).toMatchObject({
        name: 'Always-on adapter',
      });
      const model = await createModel('anthropic:claude-3-haiku:dev');
      expect((model as any).config.baseURL).toBe('https://explicit.example.com');
      expect(loadedPluginProtocol('anthropic')).toBeUndefined();
    } finally {
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY_DEV;
      else process.env.ANTHROPIC_API_KEY_DEV = oldKey;
      if (oldBase === undefined) delete process.env.ANTHROPIC_BASE_URL_DEV;
      else process.env.ANTHROPIC_BASE_URL_DEV = oldBase;
    }
  });

  it('atomically migrates legacy OAuth into the adapter credential slot', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-oauth-migration-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(root, 'auth.json');
    const credential = {
      type: 'oauth' as const,
      access: 'legacy-access',
      refresh: 'legacy-refresh',
      expires: Date.now() + 60_000,
    };
    const provider: ProviderDefinition = {
      id: 'anthropic',
      name: 'Claude subscription',
      models: [],
      transport: { kind: 'anthropic-messages' },
      auth: { methods: [{
        id: 'subscription',
        type: 'oauth',
        name: 'Subscription OAuth',
        async login() { return credential; },
        resolve({ credential: stored }) {
          const access = stored?.access;
          return typeof access === 'string' ? { bearerToken: access, source: 'stored OAuth' } : undefined;
        },
      }] },
    };

    try {
      await AuthStorage.setOAuth('anthropic', credential);
      await expect(resolveProviderAuth(provider, 'subscription')).resolves.toMatchObject({
        bearerToken: 'legacy-access',
      });
      expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toEqual(credential);
      expect(await AuthStorage.getOAuth('anthropic')).toBeUndefined();
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
    }
  });

  it('rejects package entries that escape the repository', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-package-path-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'escape', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['../outside.js'] },
    }));
    await expect(readPackageManifest(root)).rejects.toThrow('stay inside the package');
  });

  it('validates static provider metadata used by pre-install inspection', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-package-provider-metadata-'));
    await fs.writeFile(path.join(root, 'index.js'), 'export default function () {}');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'provider-preview', version: '1.0.0',
      agentuse: {
        apiVersion: 1,
        extensions: ['./index.js'],
        providers: [{ id: 'anthropic', auth: ['oauth'] }],
      },
    }));
    await expect(readPackageManifest(root)).resolves.toMatchObject({
      agentuse: { providers: [{ id: 'anthropic', auth: ['oauth'] }] },
    });

    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'provider-preview', version: '1.0.0',
      agentuse: { apiVersion: 1, extensions: ['./index.js'], providers: [{ id: 'anthropic', auth: ['token'] }] },
    }));
    await expect(readPackageManifest(root)).rejects.toThrow('only oauth or api_key');
  });

  it('emits lifecycle events to installed activation packages', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-installed-event-'));
    const dataDir = path.join(root, 'data');
    const home = path.join(dataDir, 'plugins');
    const pkg = path.join(root, 'package');
    const loose = path.join(root, 'loose');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(pkg);
    await fs.mkdir(loose);
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'installed-events', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(pkg, 'index.js'), `export default function (agentuse) {
      agentuse.on('agent:complete', () => { globalThis.__agentuseInstalledEventCount = (globalThis.__agentuseInstalledEventCount || 0) + 1; });
    }`);
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify([{
      name: 'installed-events', version: '1.0.0', source: 'test', directory: pkg, scope: 'global',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]));
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();
    (globalThis as any).__agentuseInstalledEventCount = 0;

    const manager = new PluginManager();
    await manager.loadPlugins([loose]);
    await manager.emitAgentComplete(event);
    expect((globalThis as any).__agentuseInstalledEventCount).toBe(1);
    delete (globalThis as any).__agentuseInstalledEventCount;
  });

  it('exposes installed package providers to synchronous metadata lookups', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-installed-scope-'));
    const dataDir = path.join(root, 'data');
    const home = path.join(dataDir, 'plugins');
    const pkg = path.join(root, 'package');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(pkg);
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'installed-provider', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(pkg, 'index.js'), `export default function (agentuse) {
      agentuse.registerProvider({
        id: 'installed-scope',
        name: 'Installed Scope',
        transport: { kind: 'anthropic-messages', baseURL: 'https://installed.example' },
        models: [{ id: 'm1', name: 'M1', input: ['text'], reasoning: false, contextWindow: 4096, maxOutputTokens: 512 }],
      });
    }`);
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify([{
      name: 'installed-provider', version: '1.0.0', source: 'test', directory: pkg, scope: 'global',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]));
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();

    // Library path: no PluginManager, only loadProviderPlugins().
    const providers = await loadProviderPlugins();
    expect(providers.map((provider) => provider.id)).toEqual(['installed-scope']);
    expect(loadedPluginProtocol('installed-scope')).toBe('anthropic');
    expect(loadedPluginModel('installed-scope', 'm1')?.contextWindow).toBe(4096);
    expect(resolveModelInfo('installed-scope:m1')?.limit.output).toBe(512);

    // Runner path: PluginManager scope created first, installed host resolved later.
    const manager = new PluginManager();
    await manager.loadPlugins([path.join(root, 'no-local-plugins')]);
    await manager.emit('agent:start', { agent: { name: 'a', model: 'installed-scope:m1' }, trigger: 'manual' });
    expect(loadedPluginProtocol('installed-scope')).toBe('anthropic');
    expect(loadedPluginModel('installed-scope', 'm1')?.id).toBe('m1');
  });

  it('does not duplicate portable prompt contributions when system messages are re-applied', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-portable-prompt-'));
    const plugins = path.join(root, 'plugins');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(plugins);
    await fs.mkdir(path.join(dataDir, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(plugins, 'prompt.js'), `export default function (agentuse) {
      agentuse.registerProvider({
        id: 'portable-prompt',
        name: 'Portable Prompt',
        transport: { kind: 'openai-chat-completions', baseURL: 'https://portable.example' },
        models: [{ id: 'm', name: 'M', input: ['text'], reasoning: false, contextWindow: 10, maxOutputTokens: 10 }],
        prompts: { system: () => [
          { id: 'hint', content: 'PORTABLE', portable: true },
          { id: 'local', content: 'NOT PORTABLE' },
        ] },
      });
    }`);
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();

    const manager = new PluginManager();
    await manager.loadPlugins([plugins]);
    const once = await applyProviderSystemMessages([{ role: 'system', content: 'base' }], 'portable-prompt:m');
    const twice = await applyProviderSystemMessages(once, 'portable-prompt:m');
    expect(twice.map((message) => message.content)).toEqual(['PORTABLE', 'NOT PORTABLE', 'base']);
    // Crossing to another provider keeps only the portable contribution.
    const elsewhere = await applyProviderSystemMessages(twice, 'openai:gpt-5');
    expect(elsewhere.map((message) => message.content)).toEqual(['PORTABLE', 'base']);
  });

  it('runs the legacy credential upgrade once per process, not on every host lookup', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-migration-once-'));
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'plugins'), { recursive: true });
    oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();
    const getOAuth = spyOn(AuthStorage, 'getOAuth');
    try {
      await getInstalledPluginHost();
      const afterFirst = getOAuth.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await getInstalledPluginHost();
      await loadProviderPlugins();
      expect(getOAuth.mock.calls.length).toBe(afterFirst);
      resetProviderPluginCache();
      await getInstalledPluginHost();
      expect(getOAuth.mock.calls.length).toBe(afterFirst * 2);
    } finally {
      getOAuth.mockRestore();
    }
  });

  it('reuses a recent readiness result only when the caller allows it', async () => {
    let checks = 0;
    const provider: ProviderDefinition = {
      id: 'readiness-cache',
      name: 'Readiness Cache',
      models: [],
      transport: { kind: 'openai-responses', baseURL: 'https://readiness.example' },
      check() { checks++; return { ok: true, detail: `check ${checks}` }; },
    };
    resetProviderPluginCache();
    expect((await checkProviderReadiness(provider, { maxAgeMs: 30_000 })).detail).toBe('check 1');
    expect((await checkProviderReadiness(provider, { maxAgeMs: 30_000 })).detail).toBe('check 1');
    // Status and verification callers always run a fresh check.
    expect((await checkProviderReadiness(provider)).detail).toBe('check 2');
    resetProviderPluginCache();
    expect((await checkProviderReadiness(provider, { maxAgeMs: 30_000 })).detail).toBe('check 3');
  });

  it('compiles a TypeScript extension once per file version', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-ts-cache-'));
    const entry = path.join(root, 'plugin.ts');
    await fs.writeFile(entry, 'export default function activate(): string { return "one"; }\n');
    const first = await importExtensionModule(entry);
    const again = await importExtensionModule(entry);
    expect(again).toBe(first);
    await fs.writeFile(entry, 'export default function activate(): string { return "two"; }\n');
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(entry, later, later);
    const changed = await importExtensionModule(entry);
    expect(changed).not.toBe(first);
    expect((changed as () => string)()).toBe('two');
  });

  it('cancelling a custom provider stream aborts the plugin request', async () => {
    let seenSignal: AbortSignal | undefined;
    let finalized = false;
    let yielded = 0;
    const provider: ProviderDefinition = {
      id: 'cancel-stream',
      name: 'Cancel Stream',
      models: [],
      transport: {
        kind: 'custom',
        apiVersion: 1,
        async *stream(request) {
          seenSignal = request.signal;
          try {
            while (!request.signal.aborted) {
              yielded++;
              yield { type: 'text-delta', delta: 'x' };
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          } finally {
            finalized = true;
          }
        },
      },
    };
    const model = createCustomProviderModel(provider, 'model');
    const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] });
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual({ type: 'stream-start', warnings: [] });
    expect((await reader.read()).value).toEqual({ type: 'text-start', id: 'text-0' });
    await reader.cancel('user stopped');
    expect(seenSignal?.aborted).toBe(true);
    expect(finalized).toBe(true);
    const yieldedAtCancel = yielded;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(yielded).toBe(yieldedAtCancel);
  });
});
