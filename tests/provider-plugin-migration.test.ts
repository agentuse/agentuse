import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AuthStorage } from '../src/auth/storage';
import { installLegacyProviderPlugins } from '../src/plugin/provider-migration';

describe('legacy provider plugin installation', () => {
  let tempDir = '';
  let originalAuthFile: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-migration-'));
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    originalDataDir = process.env.AGENTUSE_DATA_DIR;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');
    process.env.AGENTUSE_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = originalDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('installs the pinned plugin automatically for a credential from removed core OAuth', async () => {
    await AuthStorage.setOAuth('anthropic', {
      type: 'oauth', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 60_000,
    });
    const sources: string[] = [];

    const installed = await installLegacyProviderPlugins(async (source) => {
      sources.push(source);
      return {
        name: 'agentuse-claude-code-provider',
        version: '0.1.0',
        source,
        directory: path.join(tempDir, 'plugin'),
        scope: 'global',
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    expect(installed).toEqual(['claude-code-subscription']);
    expect(sources).toEqual(['cb7337/agentuse-claude-code-provider@v0.1.0']);
    expect(await AuthStorage.getOAuth('anthropic')).toBeUndefined();
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toMatchObject({
      access: 'legacy-access',
      refresh: 'legacy-refresh',
    });
  });

  it('does not silently install anything for a newly configured user', async () => {
    let calls = 0;
    const installed = await installLegacyProviderPlugins(async () => {
      calls += 1;
      throw new Error('should not install');
    });

    expect(installed).toEqual([]);
    expect(calls).toBe(0);
  });

  it('migrates the credential without reinstalling a plugin that is already recorded', async () => {
    await AuthStorage.setOAuth('anthropic', {
      type: 'oauth', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 60_000,
    });
    const pluginHome = path.join(tempDir, 'plugins');
    await fs.mkdir(pluginHome, { recursive: true });
    await fs.writeFile(path.join(pluginHome, 'registry.json'), JSON.stringify([{
      name: 'agentuse-claude-code-provider',
      version: '0.1.0',
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
      directory: path.join(pluginHome, 'installed'),
      scope: 'global',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]));
    let calls = 0;

    const installed = await installLegacyProviderPlugins(async () => {
      calls += 1;
      throw new Error('should not reinstall');
    });

    expect(installed).toEqual([]);
    expect(calls).toBe(0);
    expect(await AuthStorage.getOAuth('anthropic')).toBeUndefined();
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toMatchObject({
      access: 'legacy-access',
      refresh: 'legacy-refresh',
    });
  });

  it('keeps an existing plugin credential and removes a duplicate legacy OAuth key', async () => {
    await AuthStorage.setPluginCredential('anthropic', 'subscription', {
      type: 'oauth', access: 'plugin-access', refresh: 'plugin-refresh', expires: Date.now() + 120_000,
    });
    await AuthStorage.setOAuth('anthropic', {
      type: 'oauth', access: 'legacy-access', refresh: 'legacy-refresh', expires: Date.now() + 60_000,
    });
    const pluginHome = path.join(tempDir, 'plugins');
    await fs.mkdir(pluginHome, { recursive: true });
    await fs.writeFile(path.join(pluginHome, 'registry.json'), JSON.stringify([{
      name: 'agentuse-claude-code-provider',
      version: '0.1.0',
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
      directory: path.join(pluginHome, 'installed'),
      scope: 'global',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]));

    await installLegacyProviderPlugins(async () => {
      throw new Error('should not reinstall');
    });

    expect(await AuthStorage.getOAuth('anthropic')).toBeUndefined();
    expect(await AuthStorage.getPluginCredential('anthropic', 'subscription')).toMatchObject({
      access: 'plugin-access',
      refresh: 'plugin-refresh',
    });
  });
});
