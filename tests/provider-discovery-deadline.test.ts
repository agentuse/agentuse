import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PluginHost } from '../src/plugin';
import { enterPluginHost } from '../src/plugin/context';
import {
  discoverProviderModels,
  getActiveProviderAdapter,
  loadProviderPlugins,
  resetProviderPluginCache,
} from '../src/plugin/provider-runtime';
import type { ProviderDefinition } from '../src/plugin/types';

const DISCOVERY_DEADLINE_MS = 20_000;
const never = () => new Promise<never>(() => {});
const model = { id: 'm', name: 'M', input: ['text' as const], reasoning: false, contextWindow: 10, maxOutputTokens: 10 };

let root: string;
let oldDataDir: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-discovery-deadline-'));
  await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
  oldDataDir = process.env.AGENTUSE_DATA_DIR;
  process.env.AGENTUSE_DATA_DIR = root;
  resetProviderPluginCache();
});

afterEach(async () => {
  jest.useRealTimers();
  resetProviderPluginCache();
  if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = oldDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe('provider plugin discovery deadline', () => {
  it('aborts a hung live models() call and does not cache it for the TTL', async () => {
    jest.useFakeTimers();
    let calls = 0;
    let observed: AbortSignal | undefined;
    const provider: ProviderDefinition = {
      id: 'hung-models',
      name: 'Hung Models',
      transport: { kind: 'openai-chat-completions', baseURL: 'https://hung.example' },
      models({ signal }) {
        calls++;
        observed = signal;
        return never();
      },
    };
    const first = discoverProviderModels(provider).then(() => undefined, (error: Error) => error);
    await Promise.resolve();
    jest.advanceTimersByTime(DISCOVERY_DEADLINE_MS);
    expect((await first)?.message).toContain('model discovery timed out');
    expect(observed?.aborted).toBe(true);

    void discoverProviderModels(provider).catch(() => {});
    await Promise.resolve();
    expect(calls).toBe(2);
    jest.advanceTimersByTime(DISCOVERY_DEADLINE_MS);
  });

  it('skips a provider whose discovery hangs instead of hanging every model creation', async () => {
    let entered!: () => void;
    const discoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    const host = new PluginHost();
    await host.activate({ name: 'providers', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider({
        id: 'hung-provider', name: 'Hung', transport: { kind: 'openai-chat-completions', baseURL: 'https://hung.example' },
        models() { entered(); return never(); },
      });
      agentuse.registerProvider({
        id: 'ok-provider', name: 'OK', transport: { kind: 'openai-chat-completions', baseURL: 'https://ok.example' }, models: [model],
      });
    });
    enterPluginHost(host);
    jest.useFakeTimers();
    const pending = loadProviderPlugins();
    await discoveryEntered;
    jest.advanceTimersByTime(DISCOVERY_DEADLINE_MS);
    expect((await pending).map((provider) => provider.id)).toEqual(['ok-provider']);
  });

  it('treats a hung adapter when() as not selected and falls back to the next candidate', async () => {
    let whenSignal: AbortSignal | undefined;
    let entered!: () => void;
    const whenEntered = new Promise<void>((resolve) => { entered = resolve; });
    const host = new PluginHost();
    await host.activate({ name: 'adapters', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider('anthropic', {
        name: 'Hung adapter', priority: 10, models: [model],
        transport: { kind: 'anthropic-messages', baseURL: 'https://hung.example' },
        when(context: { signal: AbortSignal }) {
          whenSignal = context.signal;
          entered();
          return never();
        },
      });
      agentuse.registerProvider('anthropic', {
        name: 'Fallback adapter', priority: 0, models: [model],
        transport: { kind: 'anthropic-messages', baseURL: 'https://fallback.example' },
        when: () => true,
      });
    });
    enterPluginHost(host);
    jest.useFakeTimers();
    const selected = getActiveProviderAdapter('anthropic', 'm');
    await whenEntered;
    jest.advanceTimersByTime(DISCOVERY_DEADLINE_MS);
    expect((await selected)?.name).toBe('Fallback adapter');
    expect(whenSignal?.aborted).toBe(true);
  });

  it('still stops at a caller abort while an adapter when() is pending', async () => {
    const host = new PluginHost();
    let entered!: () => void;
    const whenEntered = new Promise<void>((resolve) => { entered = resolve; });
    await host.activate({ name: 'adapters', source: 'test', scope: 'local' }, (agentuse: any) => {
      agentuse.registerProvider('anthropic', {
        name: 'Hung adapter', models: [model],
        transport: { kind: 'anthropic-messages', baseURL: 'https://hung.example' },
        when() { entered(); return never(); },
      });
    });
    enterPluginHost(host);
    const controller = new AbortController();
    const selected = getActiveProviderAdapter('anthropic', 'm', controller.signal);
    await whenEntered;
    const reason = new Error('run cancelled');
    controller.abort(reason);
    await expect(selected).rejects.toBe(reason);
  });
});
