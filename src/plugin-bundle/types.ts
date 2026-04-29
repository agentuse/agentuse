/**
 * Plugin bundle system — Claude/VS Code-style packaged customizations.
 *
 * A plugin bundle is a directory containing a `plugin.json` manifest plus any
 * combination of skills, agents, and MCP server definitions. Bundles can be
 * loaded from a local path or fetched from a Git host (GitHub by default).
 *
 * This is a separate concept from the in-process `PluginManager` in `src/plugin/`,
 * which only handles JS/TS lifecycle hooks (e.g. `agent:complete`).
 */

import type { AgentConfig } from '../parser';

/** MCP servers config — same shape as in agent frontmatter. */
export type PluginMcpServersConfig = NonNullable<AgentConfig['mcpServers']>;

export interface PluginManifest {
  /** kebab-case identifier */
  name: string;
  version?: string;
  description?: string;
  author?: { name: string; email?: string; url?: string };
  /** Path(s) to skill directories, relative to the plugin root. Defaults to "skills/" if present. */
  skills?: string | string[];
  /** Path(s) to agent directories, relative to the plugin root. Defaults to "agents/" if present. */
  agents?: string | string[];
  /** Path to a JSON file (e.g. ".mcp.json") OR an inline `{ mcpServers: {...} }` object. */
  mcpServers?: string | { mcpServers?: PluginMcpServersConfig } | PluginMcpServersConfig;
}

/** A successfully loaded plugin bundle. */
export interface LoadedPlugin {
  /** Directory of the plugin (absolute path). */
  root: string;
  /** Where the plugin came from (spec string or "auto" for auto-discovered bundles). */
  source: string;
  manifest: PluginManifest;
  /** Absolute paths to skill discovery directories. */
  skillDirs: string[];
  /** Absolute paths to agent directories. */
  agentDirs: string[];
  /** MCP servers contributed by this plugin, namespaced by plugin name and ready for `connectMCP`. */
  mcpServers: PluginMcpServersConfig;
}

/** Parsed plugin spec from frontmatter `plugins:` array. */
export type PluginSpec =
  | { kind: 'local'; path: string; raw: string }
  | {
      kind: 'git';
      host: 'github' | 'generic';
      /** owner for github, full URL for generic */
      owner: string;
      repo: string;
      /** Subpath within the cloned repo (no leading slash). */
      subpath?: string;
      /** Branch, tag, or commit SHA. */
      ref?: string;
      /** Full URL for generic git hosts (https/ssh). */
      url?: string;
      raw: string;
    };
