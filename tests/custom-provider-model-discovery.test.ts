import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentCreationProviders } from '../src/agents/create';
import { checkCustomProviderCompletion, discoverCustomProviderModelIds, normalizeCustomProviderBaseURL } from '../src/auth/custom-provider-models';
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

  it('normalizes LM Studio root and native API URLs to its OpenAI-compatible runtime base', () => {
    expect(normalizeCustomProviderBaseURL('lmstudio', 'http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeCustomProviderBaseURL('LM_Studio', 'http://127.0.0.1:1234/api/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeCustomProviderBaseURL('gateway', 'http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
  });

  it('discovers OpenAI-compatible models with the saved optional key', async () => {
    const provider = {
      baseURL: 'http://localhost:1234/v1/',
      key: 'local-secret',
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'qwen/qwen3-8b' },
        { id: 'qwen/qwen3-8b' },
        { id: 'embedding-model', type: 'embedding' },
        { missing: true },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(discoverCustomProviderModelIds('gateway', provider)).resolves.toEqual(['qwen/qwen3-8b']);
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer local-secret' }),
    }));
  });

  it('uses LM Studio native metadata to exclude embedding models', async () => {
    const provider = { baseURL: 'http://localhost:1234/v1' };
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      return url.includes('/api/v1/models')
        ? new Response(JSON.stringify({ models: [
            { key: 'qwen/qwen3-8b', type: 'llm' },
            { key: 'text-embedding-nomic', type: 'embedding' },
          ] }), { status: 200 })
        : new Response(JSON.stringify({ data: [
            { id: 'qwen/qwen3-8b' },
            { id: 'text-embedding-nomic' },
          ] }), { status: 200 });
    });

    await expect(discoverCustomProviderModelIds('lmstudio', provider)).resolves.toEqual(['qwen/qwen3-8b']);
    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ href: 'http://localhost:1234/api/v1/models' }), expect.anything());
  });

  it('surfaces discovery failure without mutating a saved catalog', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));
    await expect(discoverCustomProviderModelIds('offline', { baseURL: 'http://localhost:9999/v1' })).rejects.toThrow('connection refused');
  });

  it.each([
    ['openai-completions', '/chat/completions', { choices: [] }],
    ['openai-responses', '/responses', { output: [] }],
    ['anthropic-messages', '/messages', { content: [] }],
  ] as const)('checks the %s protocol endpoint', async (api, suffix, responseBody) => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200 }));
    await expect(checkCustomProviderCompletion({ baseURL: 'http://localhost:1234/v1', key: 'secret', api }, 'model-id')).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(`http://localhost:1234/v1${suffix}`, expect.objectContaining({ method: 'POST' }));
  });

  it('merges discovered models into custom provider creation options', () => {
    const status: ProviderStatus = {
      credentialStore: '/redacted/path',
      providers: [],
      customProviders: [{ id: 'lmstudio', baseURL: 'http://localhost:1234/v1', hasApiKey: false, models: ['qwen/qwen3-8b', 'google/gemma-3'] }],
    };
    expect(agentCreationProviders(status)[0]).toEqual({
      id: 'lmstudio',
      name: 'lmstudio',
      models: ['lmstudio:qwen/qwen3-8b', 'lmstudio:google/gemma-3'],
      defaultModel: 'lmstudio:qwen/qwen3-8b',
      custom: true,
    });
  });
});
