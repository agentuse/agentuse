import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createProviderCommand } from '../src/cli/auth';
import { logger } from '../src/utils/logger';
import { AuthStorage } from '../src/auth/storage';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('createProviderCommand', () => {
  let errorSpy: ReturnType<typeof spyOn> | undefined;
  let exitSpy: ReturnType<typeof spyOn> | undefined;
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  let stdoutSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
    warnSpy?.mockRestore();
    stdoutSpy?.mockRestore();
  });

  it('rejects bedrock as a reserved custom provider name', async () => {
    const command = createProviderCommand();
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as any);

    await expect(
      command.parseAsync(['add', 'bedrock', '--url', 'http://localhost:11434/v1'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      "Cannot use reserved provider name 'bedrock'. Reserved: anthropic, openai, openrouter, opencode-go, bedrock, demo"
    );
  });

  it('rejects opencode-go as a reserved custom provider name', async () => {
    const command = createProviderCommand();
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit:1');
    }) as any);

    await expect(
      command.parseAsync(['add', 'opencode-go', '--url', 'https://opencode.ai/zen/go/v1'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      "Cannot use reserved provider name 'opencode-go'. Reserved: anthropic, openai, openrouter, opencode-go, bedrock, demo"
    );
  });

  it('lists OpenCode Go environment authentication', async () => {
    const command = createProviderCommand();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-command-test-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    const originalKey = process.env.OPENCODE_GO_API_KEY;
    const output: string[] = [];

    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    process.env.OPENCODE_GO_API_KEY = 'go-key';
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as any);

    try {
      await command.parseAsync(['list'], { from: 'user' });
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
      if (originalKey === undefined) {
        delete process.env.OPENCODE_GO_API_KEY;
      } else {
        process.env.OPENCODE_GO_API_KEY = originalKey;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(output.join('')).toContain('OpenCode Go');
    expect(output.join('')).toContain('OPENCODE_GO_API_KEY');
  });

  it('lists provider status as JSON without exposing credential values', async () => {
    const command = createProviderCommand();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-command-test-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    const envNames = [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'OPENCODE_GO_API_KEY',
    ];
    const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
    const output: string[] = [];

    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    for (const name of envNames) delete process.env[name];
    process.env.OPENROUTER_API_KEY = 'environment-secret';
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as any);

    try {
      await AuthStorage.setApiKey('openai', { type: 'api', key: 'stored-secret' });
      await AuthStorage.setCustomProvider('local', {
        baseURL: 'http://localhost:11434/v1',
        key: 'custom-secret',
      });
      await command.parseAsync(['list', '--json'], { from: 'user' });
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
      for (const [name, value] of originalEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const text = output.join('');
    const result = JSON.parse(text);
    expect(result.credentialStore).toBe(path.join(tempDir, 'auth.json'));
    expect(result.providers.find((provider: any) => provider.id === 'openai')).toEqual({
      id: 'openai',
      name: 'OpenAI',
      configured: true,
      sources: [{
        priority: 2,
        kind: 'api_key',
        name: 'Stored API key',
        stored: true,
        active: true,
      }],
    });
    expect(result.providers.find((provider: any) => provider.id === 'anthropic').configured).toBe(false);
    expect(result.providers.find((provider: any) => provider.id === 'openrouter').sources).toEqual([{
      priority: 3,
      kind: 'environment',
      name: 'OPENROUTER_API_KEY',
      stored: false,
      active: true,
    }]);
    expect(result.customProviders).toEqual([{
      id: 'local',
      baseURL: 'http://localhost:11434/v1',
      hasApiKey: true,
    }]);
    expect(text).not.toContain('stored-secret');
    expect(text).not.toContain('environment-secret');
    expect(text).not.toContain('custom-secret');
  });

  it('accepts opencode-go in logout command routing', async () => {
    const command = createProviderCommand();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-command-test-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await AuthStorage.setApiKey('openai', { type: 'api', key: 'openai-key' });
      await command.parseAsync(['logout', 'opencode-go'], { from: 'user' });
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(warnSpy).toHaveBeenCalledWith('No credentials found for opencode-go');
  });
});
