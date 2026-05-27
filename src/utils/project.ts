import { existsSync, statSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { homedir } from 'os';
import { logger } from './logger';

/**
 * Find project root by searching upward from a starting directory.
 * Looks for common project markers in order of specificity.
 *
 * The upward walk stops at $HOME. Markers like `.agentuse`, `.git`, and
 * `package.json` commonly exist at the user's home directory (per-user
 * config dirs, dotfile repos), and escalating to $HOME would expose the
 * entire home directory to anything that uses projectRoot as a trust
 * boundary (e.g. sandbox bind mounts).
 *
 * @param startPath - Starting directory or file path
 * @returns Project root directory path
 */
export function findProjectRoot(startPath: string): string {
  const originalStartPath = startPath;
  // If startPath exists and is a file (not a directory), start from its directory
  let currentDir = startPath;
  if (existsSync(startPath)) {
    const stats = statSync(startPath);
    if (stats.isFile()) {
      currentDir = dirname(startPath);
    }
  }

  // For URLs or non-existent paths, use current working directory
  if (!existsSync(currentDir) || currentDir.startsWith('http')) {
    return process.cwd();
  }

  const fallbackDir = currentDir;
  currentDir = resolve(currentDir);
  const root = dirname(currentDir) === currentDir ? currentDir : '/';
  const home = resolve(homedir());

  logger.debug(`Searching for project root starting from: ${currentDir}`);

  // Search upward for project markers, but never escalate to $HOME or above.
  while (currentDir !== root) {
    if (currentDir === home || home.startsWith(currentDir + sep)) {
      logger.debug(`Reached $HOME (${home}) without finding a project marker — not escalating further`);
      break;
    }

    // Check for project markers in priority order
    const markers = [
      '.agentuse',            // Agentuse plugins directory (if using plugins)
      '.git',                 // Git repository root (most common)
      'package.json',         // Node.js project
    ];

    for (const marker of markers) {
      const markerPath = resolve(currentDir, marker);
      logger.debug(`Checking for ${marker} at ${markerPath}`);
      if (existsSync(markerPath)) {
        logger.debug(`Found project root marker '${marker}' at: ${currentDir}`);
        return currentDir;
      }
    }

    // Move up one directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  // No project root found, use the starting directory
  const fallback = existsSync(originalStartPath) ? resolve(fallbackDir) : dirname(originalStartPath);
  logger.debug(`No project root markers found, using: ${fallback}`);
  return fallback;
}

/**
 * Resolve a CLI agent argument to the local file that will be parsed.
 *
 * This intentionally mirrors the run command's supported extensionless
 * invocation: `agentuse run agents/foo` should resolve `agents/foo.agentuse`
 * before stateRoot is chosen, not only later when parsing.
 */
export function resolveLocalAgentPath(file: string, cwd = process.cwd()): string | undefined {
  if (!file || file === '-') return undefined;
  if (file.startsWith('http://') || file.startsWith('https://')) return undefined;

  const absolute = resolve(cwd, file);
  if (existsSync(absolute)) return absolute;

  if (!file.endsWith('.agentuse')) {
    const withExt = `${absolute}.agentuse`;
    if (existsSync(withExt)) return withExt;
  }

  return undefined;
}

/**
 * Resolve project context based on current directory and CLI options.
 *
 * Returns two distinct roots:
 * - `projectRoot`: cwd-derived. Drives execution context (env, plugins,
 *   sandbox bind mounts, the model's `path.root`). What "I'm running in"
 *   means.
 * - `stateRoot`: agent-file-derived when an `agentFilePath` is supplied.
 *   Drives state identity (session storage path, agentId). What "this agent's
 *   home" means. Falls back to `projectRoot` for URL/stdin agents.
 *
 * Splitting these means a session for `/repo-A/agents/foo.agentuse` always
 * lands under `/repo-A`'s storage, regardless of which shell you invoked it
 * from. Today the two are conflated, so the same agent gets fragmented
 * session history across cwds.
 *
 * @param currentDir - Current working directory
 * @param options - CLI options. When `projectRoot` is provided, it is used
 *   directly (no upward walk). This matches `serve -C <dir>` semantics: an
 *   explicit directory is authoritative.
 */
export function resolveProjectContext(
  currentDir: string,
  options: { envFile?: string; projectRoot?: string; agentFilePath?: string } = {}
): {
  projectRoot: string;
  stateRoot: string;
  envFile: string;
  pluginDirs: string[];
} {
  // If caller provided an explicit project root (e.g. from -C), use it as-is.
  // Otherwise, search upward for project markers.
  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : findProjectRoot(currentDir);

  // stateRoot follows the agent file's own project when available so sessions
  // and agentId are stable per-agent regardless of cwd.
  const stateRoot = options.agentFilePath && existsSync(options.agentFilePath)
    ? findProjectRoot(options.agentFilePath)
    : projectRoot;

  // Resolve env file path
  let envFile: string;
  if (options.envFile) {
    // Explicit env file override
    envFile = resolve(options.envFile);
  } else {
    // Look for env files in project root
    const candidates = [
      resolve(projectRoot, '.env.local'),
      resolve(projectRoot, '.env'),
    ];

    envFile = candidates.find(f => existsSync(f)) || resolve(projectRoot, '.env');
  }

  // Resolve plugin directories
  const pluginDirs = [
    resolve(projectRoot, '.agentuse', 'plugins'),
    resolve(process.env.HOME || '~', '.agentuse', 'plugins'),
  ].filter(dir => existsSync(dir));

  return {
    projectRoot,
    stateRoot,
    envFile,
    pluginDirs,
  };
}
