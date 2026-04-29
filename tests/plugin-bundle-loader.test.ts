import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPluginBundles } from '../src/plugin-bundle/loader';

describe('loadPluginBundles', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'plugin-loader-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns empty result when no plugins are found', async () => {
    const result = await loadPluginBundles({ projectRoot, autoDiscover: false });
    expect(result.plugins).toEqual([]);
    expect(result.skillDirs).toEqual([]);
    expect(result.mcpServers).toEqual({});
  });

  it('loads a local plugin via relative spec', async () => {
    const pluginDir = join(projectRoot, 'plugins', 'mine');
    await mkdir(join(pluginDir, 'skills'), { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'mine' }));

    const result = await loadPluginBundles({
      projectRoot,
      specs: ['./plugins/mine'],
      autoDiscover: false,
    });

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].manifest.name).toBe('mine');
    expect(result.skillDirs).toEqual([join(pluginDir, 'skills')]);
  });

  it('auto-discovers bundle directories under .agentuse/plugins', async () => {
    const pluginDir = join(projectRoot, '.agentuse', 'plugins', 'auto1');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'auto1' }));

    const result = await loadPluginBundles({ projectRoot });
    expect(result.plugins.find(p => p.manifest.name === 'auto1')).toBeTruthy();
  });

  it('ignores bundle dirs without a plugin.json (legacy single-file plugins)', async () => {
    const dir = join(projectRoot, '.agentuse', 'plugins', 'legacy-dir');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'something.js'), 'export default {};');

    const result = await loadPluginBundles({ projectRoot });
    expect(result.plugins).toEqual([]);
  });

  it('namespaces MCP servers by plugin name', async () => {
    const pluginDir = join(projectRoot, 'p');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'p',
        mcpServers: { mcpServers: { db: { command: 'echo' } } },
      })
    );

    const result = await loadPluginBundles({ projectRoot, specs: ['./p'], autoDiscover: false });
    expect(Object.keys(result.mcpServers)).toEqual(['p.db']);
  });

  it('does not throw on a bad spec — warns and continues', async () => {
    const result = await loadPluginBundles({
      projectRoot,
      specs: ['not a valid spec/'],
      autoDiscover: false,
    });
    expect(result.plugins).toEqual([]);
  });

  it('deduplicates the same root resolved twice', async () => {
    const pluginDir = join(projectRoot, '.agentuse', 'plugins', 'dup');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'dup' }));

    const result = await loadPluginBundles({
      projectRoot,
      // Auto-discovered AND explicitly listed → must only count once.
      specs: ['./.agentuse/plugins/dup'],
    });
    expect(result.plugins.filter(p => p.manifest.name === 'dup')).toHaveLength(1);
  });
});
