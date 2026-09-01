import { readFileSync, existsSync, statSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import * as dotenv from 'dotenv';
import { parseDurationMs } from './duration';

export interface ModelAliasFallbackConfig {
  /** Ordered model ids or aliases. The first available candidate is preferred. */
  candidates: string[];
  /** How long a transiently failing concrete model is skipped by this process. */
  cooldown?: string;
}

export type ModelAliasConfig = string | ModelAliasFallbackConfig;

export interface GlobalConfigProject {
  id?: string;
  path: string;
}

export interface GlobalServeConfig {
  projects?: GlobalConfigProject[];
  default?: string;
  port?: number;
  host?: string;
  publicUrl?: string;
  auth?: boolean;
  logFile?: boolean;
  /**
   * Hide raw agent source in the operator surface: `/api/agents/detail` omits
   * the `.agentuse` body (`sourceHidden: true` instead) and the dashboard drops
   * the Source tab. For deployments shared with people who may run and observe
   * agents but should not read their instructions (demos, client sandboxes).
   * Capability summaries (model, tools, schedule) stay visible.
   */
  hideAgentSource?: boolean;
  /**
   * Deployment branding for the serve web UI. `name` renders beside the
   * AgentUse wordmark in the topbar and prefixes document titles and the
   * web-app manifest ("Kettlebase · AgentUse"). Name only by design:
   * custom logos/wordmarks are out of scope (#152).
   */
  brand?: { name?: string };
  /**
   * Display nouns for the serve web UI, render layer only. Keys are the fixed
   * technical terms; values are what this deployment calls them (e.g.
   * `{ "project": "department", "folder": "team" }`). A value may carry an
   * explicit plural as "singular|plural" for irregulars. API routes, payload
   * fields, and the CLI always keep the technical terms; the `agent` noun is
   * not renameable by design (#156).
   */
  terms?: { project?: string; folder?: string };
}

/**
 * Model defaults and aliases. Lets a fleet of agent files be repointed at a
 * new model by editing one place instead of every `model:` line.
 */
export interface GlobalModelsConfig {
  /**
   * Model used by agent files that omit `model:`. Overridden by the
   * `AGENTUSE_MODEL` env var. May itself be an alias.
   */
  default?: string;
  /**
   * Named models, referenced from an agent file as `@name` (e.g.
   * `{ "fast": "anthropic:claude-haiku-4-5" }` used as `model: "@fast"`).
   * A value may be a concrete id, a version alias, another `@name`, or an
   * ordered fallback object with candidates and an optional cooldown.
   */
  aliases?: Record<string, ModelAliasConfig>;
}

export interface GlobalConfig {
  serve?: GlobalServeConfig;
  /**
   * Environment variables applied into `process.env` at startup, mirroring the
   * `env` block in Claude Code's settings.json. Lets non-secret defaults (e.g.
   * `AGENTUSE_MOCK_MODEL`) live in config.json instead of a separate `.env`.
   * Applied with override:false, so shell env and `.env` always win.
   */
  env?: Record<string, string>;
  /** Model default + named aliases (see GlobalModelsConfig). */
  models?: GlobalModelsConfig;
}

/**
 * Alias names are referenced as `@name` from agent frontmatter, so they must not
 * contain the characters that would make that reference ambiguous (a colon would
 * read as a provider separator, whitespace as two YAML tokens).
 */
const ALIAS_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateModels(input: unknown, configPath: string): GlobalModelsConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(configPath, '`models` must be an object');
  }
  const models = input as Record<string, unknown>;
  const out: GlobalModelsConfig = {};

  if (models.default !== undefined) {
    if (typeof models.default !== 'string' || models.default.trim().length === 0) {
      fail(configPath, '`models.default` must be a non-empty string');
    }
    out.default = models.default.trim();
  }

  if (models.aliases !== undefined) {
    if (models.aliases === null || typeof models.aliases !== 'object' || Array.isArray(models.aliases)) {
      fail(configPath, '`models.aliases` must be an object');
    }
    const aliases: Record<string, ModelAliasConfig> = {};
    const seen = new Map<string, string>();
    for (const [name, value] of Object.entries(models.aliases as Record<string, unknown>)) {
      if (name.startsWith('@')) {
        fail(
          configPath,
          `\`models.aliases\` key "${name}" must not include the @ sigil ` +
            `(define it as "${name.slice(1)}", reference it as "${name}")`
        );
      }
      if (!ALIAS_NAME_PATTERN.test(name)) {
        fail(
          configPath,
          `\`models.aliases\` key "${name}" must be alphanumeric with hyphens or underscores`
        );
      }
      // Lookup is case-insensitive, so two keys differing only in case would
      // make resolution depend on object order.
      const lower = name.toLowerCase();
      const clash = seen.get(lower);
      if (clash !== undefined) {
        fail(configPath, `\`models.aliases\` has "${clash}" and "${name}", which differ only in case`);
      }
      seen.set(lower, name);
      if (typeof value === 'string') {
        if (value.trim().length === 0) {
          fail(configPath, `\`models.aliases.${name}\` must be a non-empty string or fallback object`);
        }
        aliases[name] = value.trim();
        continue;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(configPath, `\`models.aliases.${name}\` must be a non-empty string or fallback object`);
      }
      const fallback = value as Record<string, unknown>;
      const unknownKeys = Object.keys(fallback).filter((key) => !['candidates', 'cooldown'].includes(key));
      if (unknownKeys.length > 0) {
        fail(configPath, `\`models.aliases.${name}\` has unknown key(s): ${unknownKeys.join(', ')}`);
      }
      if (!Array.isArray(fallback.candidates) || fallback.candidates.length === 0) {
        fail(configPath, `\`models.aliases.${name}.candidates\` must be a non-empty array`);
      }
      const candidates = fallback.candidates.map((candidate, index) => {
        if (typeof candidate !== 'string' || candidate.trim().length === 0) {
          fail(configPath, `\`models.aliases.${name}.candidates[${index}]\` must be a non-empty string`);
        }
        return candidate.trim();
      });
      let cooldown: string | undefined;
      if (fallback.cooldown !== undefined) {
        if (typeof fallback.cooldown !== 'string' || fallback.cooldown.trim().length === 0) {
          fail(configPath, `\`models.aliases.${name}.cooldown\` must be a duration string such as "5m"`);
        }
        cooldown = fallback.cooldown.trim();
        try {
          parseDurationMs(cooldown, { bareUnit: 'seconds', field: `models.aliases.${name}.cooldown` });
        } catch (error) {
          fail(configPath, (error as Error).message);
        }
      }
      aliases[name] = { candidates, ...(cooldown !== undefined && { cooldown }) };
    }
    out.aliases = aliases;
  }

  return out;
}

/**
 * Directory containing AgentUse's user-controlled configuration files.
 *
 * `AGENTUSE_CONFIG_DIR` is the profile-level isolation boundary: config.json,
 * .env, managed projects, user-global plugins, and user-global skills all
 * derive from it. The file-level overrides below remain temporarily for
 * compatibility with existing installations.
 */
export function getGlobalConfigDir(): string {
  const override = process.env.AGENTUSE_CONFIG_DIR;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(homedir(), '.agentuse');
}

export function getGlobalConfigPath(): string {
  // Deprecated 2026-09-01; remove no earlier than 2026-12-01.
  const legacyOverride = process.env.AGENTUSE_CONFIG;
  if (legacyOverride && legacyOverride.length > 0) return path.resolve(legacyOverride);
  return path.join(getGlobalConfigDir(), 'config.json');
}

/** Managed projects normally live in the configuration directory. The legacy
 * AGENTUSE_CONFIG file override continues to place them beside that file. */
export function getManagedProjectsRoot(configPath = getGlobalConfigPath()): string {
  return path.join(path.dirname(configPath), 'projects');
}

/** Add a project without rewriting unrelated or forward-compatible config
 * fields. The rename keeps readers from observing a partially-written file. */
export function persistServeProject(
  project: GlobalConfigProject,
  configPath = getGlobalConfigPath(),
): void {
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(configPath, 'root must be a JSON object');
    }
    root = raw as Record<string, unknown>;
  }
  const existingServe = root.serve;
  if (existingServe !== undefined && (existingServe === null || typeof existingServe !== 'object' || Array.isArray(existingServe))) {
    fail(configPath, '`serve` must be an object');
  }
  const serve = { ...((existingServe as Record<string, unknown> | undefined) ?? {}) };
  const existingProjects = serve.projects;
  if (existingProjects !== undefined && !Array.isArray(existingProjects)) {
    fail(configPath, '`serve.projects` must be an array');
  }
  const projects = [...((existingProjects as unknown[] | undefined) ?? [])];
  projects.push(project);
  serve.projects = projects;
  root.serve = serve;

  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, configPath);
}

/** Remove one saved project without disturbing unrelated or newer config fields.
 * Project files are deliberately left in place; this only changes what `serve`
 * loads on startup. Matching both id and resolved path handles legacy entries
 * that did not persist an explicit id. */
export function removeServeProject(
  project: { id: string; path: string },
  configPath = getGlobalConfigPath(),
): void {
  if (!existsSync(configPath)) return;
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(configPath, 'root must be a JSON object');
  }
  const root = raw as Record<string, unknown>;
  const existingServe = root.serve;
  if (existingServe === undefined) return;
  if (existingServe === null || typeof existingServe !== 'object' || Array.isArray(existingServe)) {
    fail(configPath, '`serve` must be an object');
  }
  const serve = { ...(existingServe as Record<string, unknown>) };
  const existingProjects = serve.projects;
  if (existingProjects !== undefined && !Array.isArray(existingProjects)) {
    fail(configPath, '`serve.projects` must be an array');
  }
  const targetPath = path.resolve(project.path);
  serve.projects = ((existingProjects as unknown[] | undefined) ?? []).filter((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
    const candidate = value as Record<string, unknown>;
    if (candidate.id === project.id) return false;
    return typeof candidate.path !== 'string' || path.resolve(expandHome(candidate.path)) !== targetPath;
  });
  if (serve.default === project.id) delete serve.default;
  root.serve = serve;

  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, configPath);
}

export function getGlobalEnvPath(): string {
  // Deprecated 2026-09-01; remove no earlier than 2026-12-01.
  const legacyOverride = process.env.AGENTUSE_ENV;
  if (legacyOverride && legacyOverride.length > 0) return path.resolve(legacyOverride);
  return path.join(getGlobalConfigDir(), '.env');
}

export function loadGlobalEnv(options: { override?: boolean } = {}): string | undefined {
  const envPath = getGlobalEnvPath();
  if (!existsSync(envPath)) return undefined;
  dotenv.config({
    path: envPath,
    override: options.override ?? false,
    quiet: true,
  });
  return envPath;
}

/**
 * Apply the config.json `env` block into `process.env`. Like dotenv's
 * `override:false`, it never clobbers a variable that is already set, so shell
 * env and `.env` (loaded first) always win. Returns the keys it actually set.
 * Throws if the config is malformed (callers that load config separately should
 * pass it in to avoid a second read + throw path).
 */
export function applyGlobalConfigEnv(config = loadGlobalConfig()): string[] {
  const env = config?.env;
  if (!env) return [];
  const applied: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/**
 * Load user-global defaults at startup: the `~/.agentuse/.env` file first, then
 * the `env` block from `~/.agentuse/config.json`. Neither overrides a variable
 * already present in `process.env`, giving precedence shell > .env > config.json.
 * Propagates on a malformed config.json so the user is told instead of silently
 * getting defaults.
 */
export function loadGlobalDefaults(): { envFile: string | undefined; configEnvKeys: string[] } {
  const envFile = loadGlobalEnv();
  const configEnvKeys = applyGlobalConfigEnv();
  return { envFile, configEnvKeys };
}

/** Model settings with `aliases` always present, so callers can skip the guard. */
export interface ModelSettings {
  default?: string;
  aliases: Record<string, ModelAliasConfig>;
}

const EMPTY_MODEL_SETTINGS: ModelSettings = Object.freeze({ aliases: Object.freeze({}) as Record<string, ModelAliasConfig> });

let modelSettingsCache: { key: string; settings: ModelSettings } | null = null;

/**
 * Load the `models` block, memoized against the config file's path and mtime.
 *
 * Alias resolution runs on every agent parse, and `agentuse serve` re-parses the
 * same agents for the life of the daemon, so this must be cheap; the mtime check
 * keeps it that way without going stale when the user edits their aliases.
 * A malformed config propagates rather than silently degrading to no aliases,
 * which would resolve a `@name` to nothing or pick an unintended model.
 */
export function loadModelSettings(configPath = getGlobalConfigPath()): ModelSettings {
  let key: string;
  try {
    const stat = statSync(configPath);
    key = `${configPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    // No config file: nothing to cache against, and nothing to read.
    modelSettingsCache = null;
    return EMPTY_MODEL_SETTINGS;
  }

  if (modelSettingsCache?.key === key) return modelSettingsCache.settings;

  const config = loadGlobalConfig(configPath);
  const settings: ModelSettings = {
    ...(config?.models?.default !== undefined && { default: config.models.default }),
    aliases: config?.models?.aliases ?? {},
  };
  modelSettingsCache = { key, settings };
  return settings;
}

/** Test seam: forget the memoized `models` block. */
export function resetModelSettingsCache(): void {
  modelSettingsCache = null;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function fail(configPath: string, msg: string): never {
  throw new Error(`Invalid config at ${configPath}: ${msg}`);
}

export function loadGlobalConfig(configPath = getGlobalConfigPath()): GlobalConfig | null {
  if (!existsSync(configPath)) return null;
  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
  }
  return validate(parsed, configPath);
}

function validate(input: unknown, configPath: string): GlobalConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(configPath, 'root must be a JSON object');
  }
  const root = input as Record<string, unknown>;
  const out: GlobalConfig = {};

  if (root.env !== undefined) {
    if (root.env === null || typeof root.env !== 'object' || Array.isArray(root.env)) {
      fail(configPath, '`env` must be an object');
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(root.env as Record<string, unknown>)) {
      if (typeof value !== 'string') fail(configPath, `env.${key} must be a string`);
      env[key] = value;
    }
    out.env = env;
  }

  if (root.models !== undefined) {
    out.models = validateModels(root.models, configPath);
  }

  if (root.serve === undefined) return out;
  if (root.serve === null || typeof root.serve !== 'object' || Array.isArray(root.serve)) {
    fail(configPath, '`serve` must be an object');
  }
  const serve = root.serve as Record<string, unknown>;
  const srv: GlobalServeConfig = {};

  if (serve.projects !== undefined) {
    if (!Array.isArray(serve.projects)) fail(configPath, '`serve.projects` must be an array');
    srv.projects = serve.projects.map((p, i) => {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        fail(configPath, `serve.projects[${i}] must be an object`);
      }
      const entry = p as Record<string, unknown>;
      if (typeof entry.path !== 'string' || entry.path.length === 0) {
        fail(configPath, `serve.projects[${i}].path is required and must be a non-empty string`);
      }
      if (entry.id !== undefined && (typeof entry.id !== 'string' || entry.id.length === 0)) {
        fail(configPath, `serve.projects[${i}].id must be a non-empty string if set`);
      }
      return { path: entry.path, ...(entry.id !== undefined ? { id: entry.id as string } : {}) };
    });
  }
  if (serve.default !== undefined) {
    if (typeof serve.default !== 'string' || serve.default.length === 0) {
      fail(configPath, '`serve.default` must be a non-empty string');
    }
    srv.default = serve.default;
  }
  if (serve.port !== undefined) {
    if (typeof serve.port !== 'number' || !Number.isInteger(serve.port) || serve.port <= 0 || serve.port > 65535) {
      fail(configPath, '`serve.port` must be an integer between 1 and 65535');
    }
    srv.port = serve.port;
  }
  if (serve.host !== undefined) {
    if (typeof serve.host !== 'string' || serve.host.length === 0) {
      fail(configPath, '`serve.host` must be a non-empty string');
    }
    srv.host = serve.host;
  }
  if (serve.publicUrl !== undefined) {
    if (typeof serve.publicUrl !== 'string' || serve.publicUrl.length === 0) {
      fail(configPath, '`serve.publicUrl` must be a non-empty string');
    }
    try {
      const url = new URL(serve.publicUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail(configPath, '`serve.publicUrl` must use http:// or https://');
      }
    } catch {
      fail(configPath, '`serve.publicUrl` must be a valid URL');
    }
    srv.publicUrl = serve.publicUrl;
  }
  if (serve.auth !== undefined) {
    if (typeof serve.auth !== 'boolean') fail(configPath, '`serve.auth` must be a boolean');
    srv.auth = serve.auth;
  }
  if (serve.logFile !== undefined) {
    if (typeof serve.logFile !== 'boolean') fail(configPath, '`serve.logFile` must be a boolean');
    srv.logFile = serve.logFile;
  }
  if (serve.hideAgentSource !== undefined) {
    if (typeof serve.hideAgentSource !== 'boolean') fail(configPath, '`serve.hideAgentSource` must be a boolean');
    srv.hideAgentSource = serve.hideAgentSource;
  }
  if (serve.brand !== undefined) {
    if (serve.brand === null || typeof serve.brand !== 'object' || Array.isArray(serve.brand)) {
      fail(configPath, '`serve.brand` must be an object');
    }
    const brand = serve.brand as Record<string, unknown>;
    const b: { name?: string } = {};
    if (brand.name !== undefined) {
      if (typeof brand.name !== 'string' || brand.name.trim().length === 0) {
        fail(configPath, '`serve.brand.name` must be a non-empty string');
      }
      if (brand.name.trim().length > 60) {
        fail(configPath, '`serve.brand.name` must be 60 characters or fewer');
      }
      b.name = brand.name.trim();
    }
    srv.brand = b;
  }
  if (serve.terms !== undefined) {
    if (serve.terms === null || typeof serve.terms !== 'object' || Array.isArray(serve.terms)) {
      fail(configPath, '`serve.terms` must be an object');
    }
    const TERM_KEYS = ['project', 'folder'] as const;
    const terms: { project?: string; folder?: string } = {};
    for (const [key, value] of Object.entries(serve.terms as Record<string, unknown>)) {
      if (!(TERM_KEYS as readonly string[]).includes(key)) {
        fail(configPath, `\`serve.terms.${key}\` is not a customizable term (expected: ${TERM_KEYS.join(', ')})`);
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        fail(configPath, `\`serve.terms.${key}\` must be a non-empty string`);
      }
      if (value.trim().length > 40) {
        fail(configPath, `\`serve.terms.${key}\` must be 40 characters or fewer`);
      }
      terms[key as (typeof TERM_KEYS)[number]] = value.trim();
    }
    srv.terms = terms;
  }
  out.serve = srv;
  return out;
}
