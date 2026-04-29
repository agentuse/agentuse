import { homedir } from 'os';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../utils/logger';
import { parsePluginSpec } from './spec';
import { resolvePluginSpec } from './resolver';
import { findManifest, loadPluginFromRoot } from './manifest';
import type { LoadedPlugin, PluginMcpServersConfig } from './types';

export interface LoadPluginsOptions {
  /** Project root used to resolve relative paths in specs and to scan local plugin dirs. */
  projectRoot: string;
  /** Specs declared in the agent frontmatter `plugins:` array. */
  specs?: string[] | undefined;
  /**
   * If true, also auto-discover bundle plugins (directories containing `plugin.json`)
   * inside `<root>/.agentuse/plugins/`, `~/.agentuse/plugins/`, `<root>/.claude/plugins/`,
   * `~/.claude/plugins/`. Defaults to true.
   */
  autoDiscover?: boolean;
}

export interface LoadedPluginsResult {
  plugins: LoadedPlugin[];
  /** All skill discovery directories contributed by plugins. */
  skillDirs: string[];
  /** All agent directories contributed by plugins. */
  agentDirs: string[];
  /** Combined MCP server map from every plugin (namespaced by `pluginName.serverName`). */
  mcpServers: PluginMcpServersConfig;
}

/**
 * Load all plugin bundles for an agent run. Failures on individual plugins are logged
 * and skipped — they should never break the agent.
 */
export async function loadPluginBundles(options: LoadPluginsOptions): Promise<LoadedPluginsResult> {
  const { projectRoot, specs = [], autoDiscover = true } = options;
  const seen = new Set<string>();
  const plugins: LoadedPlugin[] = [];

  // 1. Auto-discovered bundle directories.
  if (autoDiscover) {
    for (const dir of getAutoDiscoverDirs(projectRoot)) {
      for (const root of await listBundleDirs(dir)) {
        await tryLoad(plugins, seen, root, `auto:${root}`);
      }
    }
  }

  // 2. Frontmatter specs.
  for (const raw of specs) {
    try {
      const spec = parsePluginSpec(raw);
      const root = await resolvePluginSpec(spec, projectRoot);
      await tryLoad(plugins, seen, root, raw);
    } catch (e) {
      logger.warn(`[plugin-bundle] failed to load "${raw}": ${(e as Error).message}`);
    }
  }

  return aggregate(plugins);
}

async function tryLoad(plugins: LoadedPlugin[], seen: Set<string>, root: string, source: string) {
  if (seen.has(root)) return;
  seen.add(root);
  try {
    const loaded = await loadPluginFromRoot(root, source);
    if (!loaded) {
      // Only warn if the user explicitly asked for this one.
      if (!source.startsWith('auto:')) {
        logger.warn(`[plugin-bundle] no plugin.json found in ${root} (from "${source}")`);
      }
      return;
    }
    plugins.push(loaded);
    logger.debug(`[plugin-bundle] loaded "${loaded.manifest.name}" from ${loaded.root}`);
  } catch (e) {
    logger.warn(`[plugin-bundle] failed to load ${root}: ${(e as Error).message}`);
  }
}

function getAutoDiscoverDirs(projectRoot: string): string[] {
  const home = homedir();
  return [
    join(projectRoot, '.agentuse', 'plugins'),
    join(home, '.agentuse', 'plugins'),
    join(projectRoot, '.claude', 'plugins'),
    join(home, '.claude', 'plugins'),
  ];
}

/** Return immediate subdirectories of `dir` that contain a recognized plugin manifest. */
async function listBundleDirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dir, entry.name);
    if (await findManifest(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

function aggregate(plugins: LoadedPlugin[]): LoadedPluginsResult {
  const skillDirs: string[] = [];
  const agentDirs: string[] = [];
  const mcpServers: PluginMcpServersConfig = {} as PluginMcpServersConfig;
  const usedNames = new Set<string>();

  for (const p of plugins) {
    skillDirs.push(...p.skillDirs);
    agentDirs.push(...p.agentDirs);
    for (const [serverName, cfg] of Object.entries(p.mcpServers ?? {})) {
      // Namespace to avoid collisions with user-defined mcpServers and other plugins.
      let key = `${p.manifest.name}.${serverName}`;
      let i = 2;
      while (usedNames.has(key) || key in (mcpServers as Record<string, unknown>)) {
        key = `${p.manifest.name}.${serverName}#${i++}`;
      }
      usedNames.add(key);
      (mcpServers as Record<string, unknown>)[key] = cfg;
    }
  }

  return { plugins, skillDirs, agentDirs, mcpServers };
}
