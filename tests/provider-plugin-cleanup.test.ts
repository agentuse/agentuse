import { describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { providerPluginRegistryPath, readInstalledPluginRecords, resetProviderPluginCache } from '../src/plugin/provider-runtime';
import { installPlugin, removePlugin, updatePlugins } from '../src/plugin/provider-installer';

/** A directory holding a read-only subdirectory with a file: recursive removal fails with EACCES. */
async function makeUndeletable(directory: string): Promise<string> {
  const locked = path.join(directory, 'locked');
  await fs.mkdir(locked);
  await fs.writeFile(path.join(locked, 'file'), 'x');
  await fs.chmod(locked, 0o555);
  return locked;
}

/** Restore write permission on every `locked` directory below `root` so the test can clean up. */
async function unlockAll(root: string): Promise<void> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'locked') {
      await fs.chmod(path.join(entry.parentPath, entry.name), 0o755);
    }
  }
}

describe('plugin cleanup after the registry commit', () => {
  it('keeps a committed update and removal when removing the old copy fails', async () => {
    if (process.getuid?.() === 0) return; // root can delete inside a read-only directory
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-plugin-cleanup-test-'));
    const source = path.join(root, 'source');
    const dataDir = path.join(root, 'data');
    const oldDataDir = process.env.AGENTUSE_DATA_DIR;
    process.env.AGENTUSE_DATA_DIR = dataDir;
    resetProviderPluginCache();
    await fs.mkdir(source);
    const writeManifest = (version: string) => fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'cleanup-provider', version, agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await writeManifest('1.0.0');
    await fs.writeFile(path.join(source, 'index.js'), 'export default function () {}\n');
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
    const first = git('rev-parse', 'HEAD');
    await writeManifest('2.0.0');
    git('add', '.');
    git('commit', '-m', 'later');
    const second = git('rev-parse', 'HEAD');

    try {
      const installed = await installPlugin(`${source}@${second}`);
      // Record the install as the older commit so the update replaces the directory.
      const registry = providerPluginRegistryPath();
      const records = JSON.parse(await fs.readFile(registry, 'utf8')) as Array<Record<string, unknown>>;
      await fs.writeFile(registry, JSON.stringify(records.map((record) => ({ ...record, version: '1.0.0', commit: first }))));
      await makeUndeletable(installed.directory);

      const [updated] = await updatePlugins('cleanup-provider');

      expect(updated).toMatchObject({ version: '2.0.0', commit: second, changed: true });
      expect((await readInstalledPluginRecords()).find((record) => record.name === 'cleanup-provider'))
        .toMatchObject({ version: '2.0.0', commit: second });
      const manifest = JSON.parse(await fs.readFile(path.join(installed.directory, 'package.json'), 'utf8'));
      expect(manifest.version).toBe('2.0.0');

      await makeUndeletable(installed.directory);
      await removePlugin('cleanup-provider');

      expect((await readInstalledPluginRecords()).some((record) => record.name === 'cleanup-provider')).toBe(false);
    } finally {
      if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
      else process.env.AGENTUSE_DATA_DIR = oldDataDir;
      resetProviderPluginCache();
      await unlockAll(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
