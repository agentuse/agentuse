import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentCreationProviders, discoverCustomProviderModels } from '../src/agents/create';
import { AuthStorage } from '../src/auth/storage';
import type { ProviderStatus } from '../src/auth/provider-status';

describe('custom provider model discovery', () => {
  let tempDir = '';
  let originalAuthFile = '';
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-custom-models-'));
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('discovers OpenAI-compatible models with the saved optional key', async () => {
    await AuthStorage.setCustomProvider('gateway', {
      baseURL: 'http://localhost:1234/v1/',
      key: 'local-secret',
    });
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'qwen/qwen3-8b' },
        { id: 'qwen/qwen3-8b' },
        { id: 'embedding-model', type: 'embedding' },
        { missing: true },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(discoverCustomProviderModels()).resolves.toEqual({
      gateway: [
        'gateway:qwen/qwen3-8b',
      ],
    });
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer local-secret' }),
    }));
  });

  it('uses LM Studio native metadata to exclude embedding models', async () => {
    await AuthStorage.setCustomProvider('lmstudio', { baseURL: 'http://localhost:1234/v1' });
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      models: [
        { key: 'qwen/qwen3-8b', type: 'llm' },
        { key: 'text-embedding-nomic', type: 'embedding' },
      ],
    }), { status: 200 }));

    await expect(discoverCustomProviderModels()).resolves.toEqual({
      lmstudio: ['lmstudio:qwen/qwen3-8b'],
    });
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:1234/api/v1/models', expect.anything());
  });

  it('keeps custom providers usable when discovery fails', async () => {
    await AuthStorage.setCustomProvider('offline', { baseURL: 'http://localhost:9999/v1' });
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

    const models = await discoverCustomProviderModels();
    expect(models).toEqual({ offline: [] });

    const status: ProviderStatus = {
      credentialStore: '/redacted/path',
      providers: [],
      customProviders: [{ id: 'offline', baseURL: 'http://localhost:9999/v1', hasApiKey: false }],
    };
    expect(agentCreationProviders(status, undefined, models)).toEqual([{
      id: 'offline',
      name: 'offline',
      models: [],
      custom: true,
    }]);
  });

  it('merges discovered models into custom provider creation options', () => {
    const status: ProviderStatus = {
      credentialStore: '/redacted/path',
      providers: [],
      customProviders: [{ id: 'lmstudio', baseURL: 'http://localhost:1234/v1', hasApiKey: false }],
    };
    expect(agentCreationProviders(status, undefined, {
      lmstudio: ['lmstudio:qwen/qwen3-8b', 'lmstudio:google/gemma-3'],
    })[0]).toEqual({
      id: 'lmstudio',
      name: 'lmstudio',
      models: ['lmstudio:qwen/qwen3-8b', 'lmstudio:google/gemma-3'],
      defaultModel: 'lmstudio:qwen/qwen3-8b',
      custom: true,
    });
  });
});
