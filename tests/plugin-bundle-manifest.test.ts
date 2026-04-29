import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { findManifest, loadPluginFromRoot, MANIFEST_LOCATIONS } from '../src/plugin-bundle/manifest';

describe('plugin-bundle manifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-manifest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds plugin.json at root', async () => {
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'p1' }));
    const found = await findManifest(dir);
    expect(found).toBe(join(dir, 'plugin.json'));
  });

  it('prefers .plugin/plugin.json over root plugin.json', async () => {
    await mkdir(join(dir, '.plugin'));
    await writeFile(join(dir, '.plugin', 'plugin.json'), JSON.stringify({ name: 'inner' }));
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'outer' }));
    const found = await findManifest(dir);
    expect(found).toBe(join(dir, '.plugin', 'plugin.json'));
  });

  it('finds .claude-plugin/plugin.json', async () => {
    await mkdir(join(dir, '.claude-plugin'));
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude' }));
    const found = await findManifest(dir);
    expect(found).toBe(join(dir, '.claude-plugin', 'plugin.json'));
  });

  it('returns null when no manifest exists', async () => {
    expect(await findManifest(dir)).toBeNull();
  });

  it('loads a minimal plugin and applies default skill/agent dirs', async () => {
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'minimal' }));
    await mkdir(join(dir, 'skills'));
    await mkdir(join(dir, 'agents'));
    const plugin = await loadPluginFromRoot(dir, 'test');
    expect(plugin).not.toBeNull();
    expect(plugin!.manifest.name).toBe('minimal');
    expect(plugin!.skillDirs).toEqual([join(dir, 'skills')]);
    expect(plugin!.agentDirs).toEqual([join(dir, 'agents')]);
    expect(plugin!.mcpServers).toEqual({});
  });

  it('omits implicit skill/agent dirs when missing', async () => {
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'bare' }));
    const plugin = await loadPluginFromRoot(dir, 'test');
    expect(plugin!.skillDirs).toEqual([]);
    expect(plugin!.agentDirs).toEqual([]);
  });

  it('honors explicit skills/agents arrays', async () => {
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await mkdir(join(dir, 'extra-agents'));
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({ name: 'multi', skills: ['a', 'b'], agents: 'extra-agents' })
    );
    const plugin = await loadPluginFromRoot(dir, 'test');
    expect(plugin!.skillDirs).toEqual([join(dir, 'a'), join(dir, 'b')]);
    expect(plugin!.agentDirs).toEqual([join(dir, 'extra-agents')]);
  });

  it('loads inline mcpServers and expands ${PLUGIN_ROOT}', async () => {
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'mcp-plugin',
        mcpServers: {
          mcpServers: {
            db: { command: '${PLUGIN_ROOT}/bin/server', args: ['--root', '${CLAUDE_PLUGIN_ROOT}'] },
          },
        },
      })
    );
    const plugin = await loadPluginFromRoot(dir, 'test');
    const db = (plugin!.mcpServers as any).db;
    expect(db.command).toBe(join(dir, 'bin/server'));
    expect(db.args).toEqual(['--root', dir]);
  });

  it('loads mcpServers from external file path', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { x: { command: '${PLUGIN_ROOT}/x' } } })
    );
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({ name: 'with-file', mcpServers: '.mcp.json' })
    );
    const plugin = await loadPluginFromRoot(dir, 'test');
    expect((plugin!.mcpServers as any).x.command).toBe(join(dir, 'x'));
  });

  it('rejects invalid plugin names', async () => {
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'Bad_Name' }));
    await expect(loadPluginFromRoot(dir, 'test')).rejects.toThrow(/kebab-case/);
  });

  it('rejects malformed JSON', async () => {
    await writeFile(join(dir, 'plugin.json'), '{not json');
    await expect(loadPluginFromRoot(dir, 'test')).rejects.toThrow(/Invalid JSON/);
  });

  it('returns null when there is no manifest at the root', async () => {
    const out = await loadPluginFromRoot(dir, 'test');
    expect(out).toBeNull();
  });

  it('exposes manifest locations in priority order', () => {
    expect(MANIFEST_LOCATIONS[0]).toBe('.plugin/plugin.json');
  });
});
