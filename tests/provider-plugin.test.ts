import { describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { providerPluginHome, resetProviderPluginCache } from '../src/plugin/provider-runtime';
import { inspectPluginSource, installPlugin, normalizeGitHubPluginSource, readProjectPluginRecords, removePlugin, resolvePluginSource, updatePlugins } from '../src/plugin/provider-installer';

describe('GitHub plugin sources', () => {
  it('stores global plugins under the AgentUse data directory', () => {
    const oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = '/tmp/agentuse-provider-plugin-data-test';
    try {
      expect(providerPluginHome()).toBe('/tmp/agentuse-provider-plugin-data-test/plugins');
    } finally {
      if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = oldDataDir;
    }
  });

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
    expect(() => normalizeGitHubPluginSource('http://github.com/owner/repo.git')).toThrow('GitHub');
    expect(() => normalizeGitHubPluginSource('git://github.com/owner/repo.git')).toThrow('GitHub');
  });

  it('requires a pinned release or commit before inspecting a provider plugin', async () => {
    await expect(inspectPluginSource('owner/repo')).rejects.toThrow('must include a tag or full commit');
    await expect(inspectPluginSource('owner/repo@main')).rejects.toThrow('not a moving branch');
    await expect(inspectPluginSource('./local-plugin@0123456789012345678901234567890123456789')).rejects.toThrow('pinned GitHub');
  });

  it('refuses to uninstall a path outside the managed plugin directory', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-provider-plugin-path-test-'));
    const home = path.join(dataDir, 'plugins');
    const oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify([{
      name: 'tampered', version: '1.0.0', source: 'owner/repo', directory: '/',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]));
    try {
      await expect(removePlugin('tampered')).rejects.toThrow('unmanaged plugin directory');
    } finally {
      if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = oldDataDir;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('plugin lifecycle', () => {
  it('installs a local checkout pinned to an exact commit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-plugin-commit-test-'));
    const source = path.join(root, 'source');
    const dataDir = path.join(root, 'data');
    const oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'commit-provider', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(source, 'index.js'), `export default function () {}\n`);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'AgentUse Test');
    git('add', '.');
    git('commit', '-m', 'initial');
    const pinned = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'commit-provider', version: '2.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    git('add', '.');
    git('commit', '-m', 'later');

    try {
      const installed = await installPlugin(`${source}@${pinned}`);
      expect(installed).toMatchObject({ version: '1.0.0', commit: pinned, ref: pinned });
      // A pinned source resolves to the same commit, so update reports no change.
      const [unchanged] = await updatePlugins('commit-provider');
      expect(unchanged).toMatchObject({ version: '1.0.0', commit: pinned, changed: false });
    } finally {
      if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = oldDataDir;
      resetProviderPluginCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('links an unpinned local Git checkout in place instead of cloning it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-plugin-lifecycle-test-'));
    const source = path.join(root, 'source');
    const dataDir = path.join(root, 'data');
    const oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
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
      expect(installed).toMatchObject({ version: '1.0.0', directory: source, linked: true, scope: 'global' });

      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
        name: 'lifecycle-provider', version: '1.1.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
      }));
      git('add', '.');
      git('commit', '-m', 'update');
      const [updated] = await updatePlugins('lifecycle-provider');
      expect(updated?.version).toBe('1.1.0');

      await removePlugin('lifecycle-provider');
      expect(await fs.stat(source)).toBeTruthy();
    } finally {
      if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = oldDataDir;
      resetProviderPluginCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('links a plain non-git directory globally without cloning it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-global-link-test-'));
    const dataDir = path.join(root, 'data');
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'global-linked', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(source, 'index.js'), 'export default function () {}\n');
    const oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();
    try {
      const installed = await installPlugin(source);
      expect(installed).toMatchObject({ name: 'global-linked', scope: 'global', directory: source, linked: true });
      expect(installed.projectRoot).toBeUndefined();
      expect(installed.commit).toBeUndefined();
      // Nothing was copied into the managed plugin home.
      const home = providerPluginHome();
      const copied = await fs.readdir(home).catch(() => [] as string[]);
      expect(copied.filter((entry) => !entry.endsWith('.json'))).toEqual([]);

      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
        name: 'global-linked', version: '1.1.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
      }));
      const [updated] = await updatePlugins('global-linked');
      expect(updated).toMatchObject({ version: '1.1.0', directory: source, linked: true, scope: 'global', changed: true });
      const [same] = await updatePlugins('global-linked');
      expect(same).toMatchObject({ version: '1.1.0', changed: false });

      await removePlugin('global-linked');
      expect(await fs.stat(source)).toBeTruthy();
    } finally {
      if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = oldDataDir;
      resetProviderPluginCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('links, reloads, and removes a project-scoped working directory without copying it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-project-plugin-test-'));
    const source = path.join(root, 'source');
    const projectRoot = path.join(root, 'project');
    await fs.mkdir(source);
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'project-events', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(source, 'index.js'), `export default function (agentuse) { agentuse.on('agent:complete', async () => { globalThis.__projectPackageEvent = true; }); }\n`);
    try {
      const localSource = `./${path.relative(process.cwd(), source)}`;
      const installed = await installPlugin(localSource, { local: true, projectRoot });
      expect(installed).toMatchObject({
        name: 'project-events', scope: 'project', projectRoot, source: localSource, directory: source, linked: true,
      });
      expect(await readProjectPluginRecords({ local: true, projectRoot })).toHaveLength(1);

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

      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
        name: 'project-events', version: '1.1.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
      }));
      const [updated] = await updatePlugins('project-events', { local: true, projectRoot });
      expect(updated).toMatchObject({ version: '1.1.0', directory: source, linked: true });

      await removePlugin('project-events', { local: true, projectRoot });
      expect(await readProjectPluginRecords({ local: true, projectRoot })).toEqual([]);
      expect(await fs.stat(source)).toBeTruthy();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
