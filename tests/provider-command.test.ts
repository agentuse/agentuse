import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createProviderCommand } from '../src/cli/auth';
import { logger } from '../src/utils/logger';
import { AuthStorage } from '../src/auth/storage';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resetProviderPluginCache } from '../src/plugin/provider-runtime';

describe('createProviderCommand', () => {
  let errorSpy: ReturnType<typeof spyOn> | undefined;
  let exitSpy: ReturnType<typeof spyOn> | undefined;
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  let stdoutSpy: ReturnType<typeof spyOn> | undefined;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
    warnSpy?.mockRestore();
    stdoutSpy?.mockRestore();
    fetchSpy?.mockRestore();
  });

  it('keeps custom compatibility flags in an advanced add-command help section', () => {
    const command = createProviderCommand();
    const addCommand = command.commands.find(candidate => candidate.name() === 'add');
    expect(addCommand).toBeDefined();

    const output: string[] = [];
    addCommand!.configureOutput({ writeOut: text => output.push(text) });
    addCommand!.outputHelp();
    const help = output.join('');

    expect(help).toContain('Usage: provider add [options] <name>');
    expect(help).toContain('Advanced compatibility overrides (custom endpoints only):');
    expect(help).toContain('--no-reasoning-effort');
    expect(help).toContain('Use these only when an endpoint reports a protocol compatibility error.');
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

  it('saves repeatable manual model IDs when a reachable endpoint returns no models', async () => {
    const command = createProviderCommand();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-command-test-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).endsWith('/models')
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as any);

    try {
      await command.parseAsync([
        'add', 'Local_Gateway', '--url', 'http://localhost:9999/v1',
        '--model', 'qwen3', '--model', 'google/gemma-3',
      ], { from: 'user' });
      expect(await AuthStorage.getCustomProvider('local_gateway')).toMatchObject({
        api: 'openai-completions',
        models: ['qwen3', 'google/gemma-3'],
      });
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
    // The community shortlist is advertised, never auto-installed.
    expect(output.join('')).toContain('Community provider plugins:');
    expect(output.join('')).toContain('Install: agentuse plugins install cb7337/agentuse-claude-code-provider@v0.1.0');
    expect(output.join('')).toContain('[2]');
  });

  it('lists provider status as JSON without exposing credential values', async () => {
    const command = createProviderCommand();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-command-test-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    const originalDataDir = process.env.AGENTUSE_DATA_DIR;
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
    const pluginHome = path.join(tempDir, 'plugins');
    const pluginDirectory = path.join(pluginHome, 'claude-code-provider');
    process.env.AGENTUSE_DATA_DIR = tempDir;
    await fs.mkdir(pluginDirectory, { recursive: true });
    await fs.writeFile(path.join(pluginDirectory, 'package.json'), JSON.stringify({
      name: 'agentuse-claude-code-provider', version: '0.1.0', type: 'module',
      agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), `export default function (agentuse) {
      agentuse.registerProvider('anthropic', {
        name: 'Claude Code Subscription', models: { inherit: 'anthropic' }, transport: { kind: 'anthropic-messages' },
        auth: { methods: [{ id: 'subscription', type: 'oauth', name: 'Claude subscription OAuth', environment: ['CLAUDE_CODE_OAUTH_TOKEN'], async login() { throw new Error('unused'); }, resolve({ credential }) { return credential?.access ? { bearerToken: credential.access, source: 'OAuth' } : undefined; } }] },
        async when(context) { return Boolean(await context.auth.resolve('subscription')); }
      });
    }`);
    await fs.writeFile(path.join(pluginHome, 'registry.json'), JSON.stringify([{
      name: 'agentuse-claude-code-provider', version: '0.1.0',
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0', directory: pluginDirectory, scope: 'global',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]));
    resetProviderPluginCache();
    for (const name of envNames) delete process.env[name];
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-oauth-secret';
    process.env.OPENAI_API_KEY = 'environment-secret';
    process.env.OPENROUTER_API_KEY = 'openrouter-environment-secret';
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as any);

    try {
      await AuthStorage.setOAuth('anthropic', {
        type: 'oauth',
        refresh: 'stored-refresh-secret',
        access: 'stored-oauth-secret',
        expires: Date.now() + 60 * 60 * 1000,
      });
      await AuthStorage.setApiKey('openai', { type: 'api', key: 'stored-secret' });
      await AuthStorage.setCustomProvider('local', {
        baseURL: 'http://localhost:11434/v1',
        key: 'custom-secret',
      });
      await command.parseAsync(['list', '--json'], { from: 'user' });
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
      if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = originalDataDir;
      resetProviderPluginCache();
      for (const [name, value] of originalEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const text = output.join('');
    const result = JSON.parse(text);
    expect(result.credentialStore).toBe(path.join(tempDir, 'auth.json'));
    expect(result.providers.find((provider: any) => provider.id === 'openai')).toMatchObject({
      id: 'openai',
      name: 'OpenAI',
      configured: true,
      sources: [
        {
          priority: 2,
          kind: 'environment',
          name: 'OPENAI_API_KEY',
          stored: false,
          active: true,
        },
        {
          priority: 3,
          kind: 'api_key',
          name: 'Stored API key',
          stored: true,
          active: false,
        },
      ],
    });
    expect(result.providers.find((provider: any) => provider.id === 'anthropic')).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic',
      configured: true,
      sources: [
        {
          priority: 1,
          kind: 'environment',
          name: 'CLAUDE_CODE_OAUTH_TOKEN',
          stored: false,
          active: true,
        },
        {
          priority: 1,
          kind: 'oauth',
          name: 'Claude subscription OAuth',
          stored: true,
          active: false,
          plugin: { name: 'agentuse-claude-code-provider', authMethodId: 'subscription' },
        },
      ],
    });
    expect(result.providers.find((provider: any) => provider.id === 'openrouter').sources).toMatchObject([{
      priority: 2,
      kind: 'environment',
      name: 'OPENROUTER_API_KEY',
      stored: false,
      active: true,
    }]);
    expect(result.customProviders).toMatchObject([{
      id: 'local',
      baseURL: 'http://localhost:11434/v1',
      hasApiKey: true,
      api: 'openai-completions',
      models: [],
    }]);
    expect(text).not.toContain('stored-secret');
    expect(text).not.toContain('environment-oauth-secret');
    expect(text).not.toContain('stored-refresh-secret');
    expect(text).not.toContain('stored-oauth-secret');
    expect(text).not.toContain('environment-secret');
    expect(text).not.toContain('openrouter-environment-secret');
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
