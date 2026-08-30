import { describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { resetProviderPluginCache } from '../src/plugin/provider-runtime';
import { installPlugin, normalizeGitHubPluginSource, readProjectPluginRecords, removePlugin, resolvePluginSource, updatePlugins } from '../src/plugin/provider-installer';

describe('GitHub plugin sources', () => {
  it('accepts shorthand, HTTPS, and SSH GitHub repositories', () => {
    expect(normalizeGitHubPluginSource('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(normalizeGitHubPluginSource('github:owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(normalizeGitHubPluginSource('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    expect(normalizeGitHubPluginSource('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
    expect(normalizeGitHubPluginSource('ssh://git@github.com/owner/repo.git')).toBe('ssh://git@github.com/owner/repo.git');
    expect(resolvePluginSource('git:github.com/owner/repo@v1')).toEqual({
      url: 'https://github.com/owner/repo.git', ref: 'v1',
    });
    expect(resolvePluginSource('owner/repo@feature/provider-api')).toEqual({
      url: 'https://github.com/owner/repo.git', ref: 'feature/provider-api',
    });
  });

  it('rejects non-GitHub sources', () => {
    expect(() => normalizeGitHubPluginSource('https://example.com/owner/repo')).toThrow('GitHub');
    expect(() => normalizeGitHubPluginSource('https://token@github.com/owner/repo')).toThrow('GitHub');
    expect(() => normalizeGitHubPluginSource('https://github.com/owner/repo/tree/main')).toThrow('GitHub');
  });

  it('refuses to uninstall a path outside the managed plugin directory', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-plugin-path-test-'));
    const oldHome = process.env.AGENTUSE_PLUGIN_HOME;
    process.env.AGENTUSE_PLUGIN_HOME = home;
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify([{
      name: 'tampered', version: '1.0.0', source: 'owner/repo', directory: '/',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]));
    try {
      await expect(removePlugin('tampered')).rejects.toThrow('unmanaged plugin directory');
    } finally {
      if (oldHome === undefined) delete process.env.AGENTUSE_PLUGIN_HOME;
      else process.env.AGENTUSE_PLUGIN_HOME = oldHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('plugin lifecycle', () => {
  it('installs, updates, and uninstalls an independently versioned Git repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-plugin-lifecycle-test-'));
    const source = path.join(root, 'source');
    const home = path.join(root, 'home');
    const oldHome = process.env.AGENTUSE_PLUGIN_HOME;
    process.env.AGENTUSE_PLUGIN_HOME = home;
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'lifecycle-provider', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(source, 'index.js'), `export default function (agentuse) { agentuse.registerProvider({ id: 'lifecycle', name: 'Lifecycle', models: [], transport: { kind: 'custom', apiVersion: 1, async *stream() { yield { type: 'finish', reason: 'stop' }; } } }); }\n`);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'AgentUse Test');
    git('add', '.');
    git('commit', '-m', 'initial');
    try {
      const installed = await installPlugin(source);
      expect(installed.version).toBe('1.0.0');
      expect(await fs.stat(installed.directory)).toBeTruthy();

      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
        name: 'lifecycle-provider', version: '1.1.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
      }));
      git('add', '.');
      git('commit', '-m', 'update');
      const [updated] = await updatePlugins('lifecycle-provider');
      expect(updated?.version).toBe('1.1.0');

      await removePlugin('lifecycle-provider');
      await expect(fs.stat(installed.directory)).rejects.toThrow();
    } finally {
      if (oldHome === undefined) delete process.env.AGENTUSE_PLUGIN_HOME;
      else process.env.AGENTUSE_PLUGIN_HOME = oldHome;
      resetProviderPluginCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('installs and removes a project-scoped package independently from global packages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-project-plugin-test-'));
    const source = path.join(root, 'source');
    const projectRoot = path.join(root, 'project');
    await fs.mkdir(source);
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'project-events', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(source, 'index.js'), `export default function (agentuse) { agentuse.on('agent:complete', async () => { globalThis.__projectPackageEvent = true; }); }\n`);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'AgentUse Test');
    git('add', '.');
    git('commit', '-m', 'initial');
    try {
      const installed = await installPlugin(source, { local: true, projectRoot });
      expect(installed).toMatchObject({ name: 'project-events', scope: 'project', projectRoot });
      expect(await readProjectPluginRecords({ local: true, projectRoot })).toHaveLength(1);
      expect(installed.directory.startsWith(path.join(projectRoot, '.agentuse', 'packages'))).toBe(true);

      const { PluginManager } = await import('../src/plugin');
      const manager = new PluginManager();
      await manager.loadPlugins([], projectRoot);
      (globalThis as any).__projectPackageEvent = false;
      await manager.emitAgentComplete({
        agent: { name: 'test', model: 'demo:test' },
        result: { text: '', duration: 0, toolCalls: 0, hasTextOutput: false },
        isSubAgent: false,
        consoleOutput: '',
      });
      expect((globalThis as any).__projectPackageEvent).toBe(true);
      delete (globalThis as any).__projectPackageEvent;

      await removePlugin('project-events', { local: true, projectRoot });
      expect(await readProjectPluginRecords({ local: true, projectRoot })).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
