import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PluginHost, PluginManager } from '../src/plugin';
import { createCustomProviderModel, getActiveProviderAdapter, getProviderPatch, getProviderPlugin, resetProviderPluginCache } from '../src/plugin/provider-runtime';
import { readPackageManifest } from '../src/plugin/loader';
import type { AgentCompleteEvent, ProviderDefinition, ProviderRequest } from '../src/plugin/types';
import type { AgentUsePlugin } from 'agentuse/plugin-api';
import { resolveModelInfo } from '../src/utils/model-utils';
import { AuthStorage } from '../src/auth/storage';
import { getProviderStatus } from '../src/auth/provider-status';

const event: AgentCompleteEvent = {
  agent: { name: 'test-agent', model: 'demo:test' },
  result: { text: 'original', duration: 1, toolCalls: 0, hasTextOutput: true },
  isSubAgent: false,
  consoleOutput: '',
};

describe('AgentUse activation API', () => {
  it('registers isolated event handlers and disposes the complete activation', async () => {
    const host = new PluginHost();
    const observed: string[] = [];
    const plugin: AgentUsePlugin = (agentuse) => {
      agentuse.on('agent:complete', (value: AgentCompleteEvent) => { value.result.text = 'mutated'; });
      agentuse.on('agent:complete', (value: AgentCompleteEvent) => {
        observed.push(value.result.text);
      });
    };
    const activation = await host.activate({ name: 'events', source: 'test', scope: 'local' }, plugin);

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
    expect(host.getProviderAdapters('anthropic')).toHaveLength(1);
  });

  it('adapts the stable custom stream contract without exposing AI SDK types to plugins', async () => {
    let observed: ProviderRequest | undefined;
    const provider: ProviderDefinition = {
      id: 'native-stream',
      name: 'Native Stream',
      models: [],
      transport: {
        kind: 'custom',
        apiVersion: 1,
        async *stream(request) {
          observed = request;
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
    const model = createCustomProviderModel(provider, 'model');
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      temperature: 0.5,
      tools: [{ type: 'function', name: 'done', inputSchema: { type: 'object' } }],
    });

    expect(observed?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
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
  let oldHome: string | undefined;

  afterEach(async () => {
    resetProviderPluginCache();
    if (oldHome === undefined) delete process.env.AGENTUSE_PLUGIN_HOME;
    else process.env.AGENTUSE_PLUGIN_HOME = oldHome;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('makes a loose activation-function provider available in its async run scope', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-activation-plugin-'));
    const plugins = path.join(root, 'plugins');
    const installed = path.join(root, 'installed');
    await fs.mkdir(plugins);
    await fs.mkdir(installed);
    await fs.writeFile(path.join(plugins, 'local.js'), `
      export default async function (agentuse) {
        agentuse.registerProvider({
          id: 'scoped-provider', name: 'Scoped Provider',
          models: [{ id: 'model', name: 'Model', input: ['text'], reasoning: false, contextWindow: 1000, maxOutputTokens: 100 }],
          transport: { kind: 'openai-chat-completions', baseURL: 'http://localhost:1234/v1' }
        });
      }
    `);
    oldHome = process.env.AGENTUSE_PLUGIN_HOME;
    process.env.AGENTUSE_PLUGIN_HOME = installed;
    resetProviderPluginCache();

    const manager = new PluginManager();
    await manager.loadPlugins([plugins]);
    expect((await getProviderPlugin('scoped-provider'))?.name).toBe('Scoped Provider');
    expect(resolveModelInfo('scoped-provider:model')).toMatchObject({
      name: 'Model', limit: { context: 1000, output: 100 },
    });
    expect(await getProviderPatch('scoped-provider')).toBeUndefined();
  });

  it('activates a built-in provider adapter only when its credential predicate matches', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-extension-plugin-'));
    const plugins = path.join(root, 'plugins');
    const installed = path.join(root, 'installed');
    await fs.mkdir(plugins);
    await fs.mkdir(installed);
    await fs.writeFile(path.join(plugins, 'local.js'), `
      export default function (agentuse) {
        agentuse.registerProvider('anthropic', {
          name: 'Claude subscription',
          transport: { kind: 'anthropic-messages', headers: { 'anthropic-beta': 'oauth' } },
          auth: { methods: [{
            id: 'subscription', type: 'oauth', name: 'Subscription OAuth',
            environment: ['TEST_CLAUDE_OAUTH'],
            async login() { return {}; },
            resolve({ credential }, context) {
              const token = context.env.TEST_CLAUDE_OAUTH ?? credential?.access;
              return token ? { bearerToken: token, source: 'test' } : undefined;
            }
          }] },
          async when(context) { return Boolean(await context.auth.resolve('subscription')); }
        });
      }
    `);
    oldHome = process.env.AGENTUSE_PLUGIN_HOME;
    process.env.AGENTUSE_PLUGIN_HOME = installed;
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
      expect(await getActiveProviderAdapter('anthropic', 'claude-test')).toMatchObject({
        id: 'anthropic',
        name: 'Claude subscription',
        transport: { headers: { 'anthropic-beta': 'oauth' } },
      });
      expect((await getProviderStatus()).providers.find((provider) => provider.id === 'anthropic')?.sources).toEqual([
        {
          priority: 1,
          kind: 'environment',
          name: 'TEST_CLAUDE_OAUTH',
          stored: false,
          active: true,
        },
        {
          priority: 2,
          kind: 'environment',
          name: 'ANTHROPIC_API_KEY',
          stored: false,
          active: false,
        },
      ]);
    } finally {
      delete process.env.TEST_CLAUDE_OAUTH;
      if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
    }
  });

  it('rejects package entries that escape the repository', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-package-path-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'escape', version: '1.0.0', agentuse: { apiVersion: 1, plugins: ['../outside.js'] },
    }));
    await expect(readPackageManifest(root)).rejects.toThrow('stay inside the package');
  });

  it('emits lifecycle events to installed activation packages', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-installed-event-'));
    const home = path.join(root, 'home');
    const pkg = path.join(root, 'package');
    const loose = path.join(root, 'loose');
    await fs.mkdir(home);
    await fs.mkdir(pkg);
    await fs.mkdir(loose);
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'installed-events', version: '1.0.0', agentuse: { apiVersion: 1, plugins: ['./index.js'] },
    }));
    await fs.writeFile(path.join(pkg, 'index.js'), `export default function (agentuse) {
      agentuse.on('agent:complete', () => { globalThis.__agentuseInstalledEventCount = (globalThis.__agentuseInstalledEventCount || 0) + 1; });
    }`);
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify([{
      name: 'installed-events', version: '1.0.0', source: 'test', directory: pkg, scope: 'global',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]));
    oldHome = process.env.AGENTUSE_PLUGIN_HOME;
    process.env.AGENTUSE_PLUGIN_HOME = home;
    resetProviderPluginCache();
    (globalThis as any).__agentuseInstalledEventCount = 0;

    const manager = new PluginManager();
    await manager.loadPlugins([loose]);
    await manager.emitAgentComplete(event);
    expect((globalThis as any).__agentuseInstalledEventCount).toBe(1);
    delete (globalThis as any).__agentuseInstalledEventCount;
  });
});
