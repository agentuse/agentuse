import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Point the data dir (and the auth lock that guards registry writes) at a temp
// dir before the modules resolve their paths.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-plugin-registry-strict-'));
const oldDataDir = process.env.AGENTUSE_DATA_DIR;
process.env.AGENTUSE_DATA_DIR = path.join(root, 'data');
const { providerPluginRegistryPath, readInstalledPluginRecords } = await import('../src/plugin/provider-runtime');
const { installPlugin, projectPluginRegistryPath, readProjectPluginRecords, removePlugin, updatePlugins } =
  await import('../src/plugin/provider-installer');

const source = path.join(root, 'source');
const projectRoot = path.join(root, 'project');
const localSource = () => `./${path.relative(process.cwd(), source)}`;
const existing = [{ name: 'kept-a', version: '1.0.0' }, { name: 'kept-b', version: '1.0.0' }];

describe('plugin registry writes on an unusable registry', () => {
  beforeEach(async () => {
    await fs.rm(path.join(root, 'data'), { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(projectRoot, '.agentuse'), { recursive: true });
    await fs.mkdir(path.dirname(providerPluginRegistryPath()), { recursive: true });
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'new-plugin', version: '1.0.0', agentuse: { apiVersion: 1, extensions: ['./index.js'] },
    }));
    await fs.writeFile(path.join(source, 'index.js'), 'export default function () {}\n');
  });

  afterAll(async () => {
    if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = oldDataDir;
    await fs.chmod(providerPluginRegistryPath(), 0o600).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a global install over malformed JSON and keeps the file', async () => {
    const registry = providerPluginRegistryPath();
    const original = JSON.stringify(existing).slice(0, -2);
    await fs.writeFile(registry, original);

    await expect(installPlugin(localSource())).rejects.toThrow(`Plugin registry ${registry} is not valid JSON`);
    expect(await fs.readFile(registry, 'utf8')).toBe(original);
    expect(await readInstalledPluginRecords()).toEqual([]);
  });

  it('refuses a project install over a non-array root and keeps the file', async () => {
    const registry = projectPluginRegistryPath({ local: true, projectRoot });
    const original = JSON.stringify({ plugins: existing });
    await fs.writeFile(registry, original);

    await expect(installPlugin(localSource(), { local: true, projectRoot })).rejects.toThrow(
      `Plugin registry ${registry} does not contain a JSON array`
    );
    expect(await fs.readFile(registry, 'utf8')).toBe(original);
    expect(await readProjectPluginRecords({ local: true, projectRoot })).toEqual([]);
  });

  it('reports the unusable registry on update and remove instead of "not installed"', async () => {
    const registry = projectPluginRegistryPath({ local: true, projectRoot });
    await fs.writeFile(registry, 'not json');

    await expect(updatePlugins('kept-a', { local: true, projectRoot })).rejects.toThrow(registry);
    await expect(removePlugin('kept-a', { local: true, projectRoot })).rejects.toThrow(registry);
    expect(await fs.readFile(registry, 'utf8')).toBe('not json');
  });

  it.skipIf(process.getuid?.() === 0)('refuses a global install over an unreadable file and keeps it', async () => {
    const registry = providerPluginRegistryPath();
    const original = JSON.stringify(existing);
    await fs.writeFile(registry, original);
    await fs.chmod(registry, 0o000);

    await expect(installPlugin(localSource())).rejects.toThrow(`Plugin registry ${registry} could not be read`);
    await fs.chmod(registry, 0o600);
    expect(await fs.readFile(registry, 'utf8')).toBe(original);
  });

  it('still creates a missing registry', async () => {
    await installPlugin(localSource(), { local: true, projectRoot });
    expect((await readProjectPluginRecords({ local: true, projectRoot })).map((r) => r.name)).toEqual(['new-plugin']);
  });
});
