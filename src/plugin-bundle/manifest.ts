import { z } from 'zod';
import { readFile, stat } from 'fs/promises';
import { join, isAbsolute, resolve } from 'path';
import type { LoadedPlugin, PluginManifest, PluginMcpServersConfig } from './types';

/** Locations checked for `plugin.json`, in priority order. */
export const MANIFEST_LOCATIONS = [
  '.plugin/plugin.json',
  'plugin.json',
  '.github/plugin/plugin.json',
  '.claude-plugin/plugin.json',
];

const ManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Plugin name must be kebab-case (lowercase letters, numbers, hyphens)'),
  version: z.string().optional(),
  description: z.string().max(1024).optional(),
  author: z
    .object({
      name: z.string(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  mcpServers: z.union([z.string(), z.record(z.unknown()), z.object({ mcpServers: z.record(z.unknown()) })]).optional(),
});

/** Try to find a `plugin.json` inside `root`. Returns absolute path or null. */
export async function findManifest(root: string): Promise<string | null> {
  for (const rel of MANIFEST_LOCATIONS) {
    const candidate = join(root, rel);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Load a plugin bundle from an already-resolved root directory.
 * Returns null if no manifest is found (caller decides whether to warn).
 */
export async function loadPluginFromRoot(root: string, source: string): Promise<LoadedPlugin | null> {
  const manifestPath = await findManifest(root);
  if (!manifestPath) return null;

  const raw = await readFile(manifestPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${(e as Error).message}`);
  }

  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const msg = result.error.errors.map(e => `${e.path.join('.') || 'root'}: ${e.message}`).join('; ');
    throw new Error(`Invalid plugin manifest at ${manifestPath}: ${msg}`);
  }

  const manifest = result.data as PluginManifest;
  const absRoot = resolve(root);

  const skillDirs = await resolveDirList(absRoot, manifest.skills, 'skills');
  const agentDirs = await resolveDirList(absRoot, manifest.agents, 'agents');
  const mcpServers = await loadMcpServers(absRoot, manifest);

  return { root: absRoot, source, manifest, skillDirs, agentDirs, mcpServers };
}

async function resolveDirList(
  root: string,
  value: string | string[] | undefined,
  defaultDir: string
): Promise<string[]> {
  const candidates: string[] = [];
  if (value === undefined) {
    candidates.push(defaultDir);
  } else if (typeof value === 'string') {
    candidates.push(value);
  } else {
    candidates.push(...value);
  }

  const out: string[] = [];
  for (const c of candidates) {
    const abs = isAbsolute(c) ? c : join(root, c);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) out.push(abs);
    } catch {
      // Silently skip missing dirs (especially the implicit defaults).
    }
  }
  return out;
}

async function loadMcpServers(root: string, manifest: PluginManifest): Promise<PluginMcpServersConfig> {
  const mcp = manifest.mcpServers;
  if (mcp === undefined) return {};

  let inline: Record<string, unknown> | undefined;

  if (typeof mcp === 'string') {
    const file = isAbsolute(mcp) ? mcp : join(root, mcp);
    try {
      const raw = await readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      inline =
        parsed && typeof parsed === 'object' && 'mcpServers' in parsed
          ? (parsed as { mcpServers: Record<string, unknown> }).mcpServers
          : (parsed as Record<string, unknown>);
    } catch (e) {
      throw new Error(`Failed to read MCP config ${file}: ${(e as Error).message}`);
    }
  } else if (mcp && typeof mcp === 'object') {
    if ('mcpServers' in mcp && (mcp as { mcpServers?: unknown }).mcpServers) {
      inline = (mcp as { mcpServers: Record<string, unknown> }).mcpServers;
    } else {
      inline = mcp as Record<string, unknown>;
    }
  }

  if (!inline) return {};

  // Expand ${PLUGIN_ROOT} / ${CLAUDE_PLUGIN_ROOT} tokens to absolute paths.
  return expandPluginRootTokens(inline, root) as PluginMcpServersConfig;
}

function expandPluginRootTokens<T>(value: T, root: string): T {
  const replace = (s: string) => s.replace(/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/g, root);

  if (typeof value === 'string') return replace(value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => expandPluginRootTokens(v, root)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandPluginRootTokens(v, root);
    }
    return out as unknown as T;
  }
  return value;
}
