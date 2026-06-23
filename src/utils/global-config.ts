import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import * as dotenv from 'dotenv';

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
}

export function getGlobalConfigPath(): string {
  const override = process.env.AGENTUSE_CONFIG;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(homedir(), '.agentuse', 'config.json');
}

export function getGlobalEnvPath(): string {
  const override = process.env.AGENTUSE_ENV;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(homedir(), '.agentuse', '.env');
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
  out.serve = srv;
  return out;
}
