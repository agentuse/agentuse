import { existsSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { logger } from './logger';

/**
 * Find project root by searching upward from a starting directory.
 * Looks for common project markers in order of specificity.
 *
 * @param startPath - Starting directory or file path
 * @returns Project root directory path
 */
export function findProjectRoot(startPath: string): string {
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

  currentDir = resolve(currentDir);
  const root = dirname(currentDir) === currentDir ? currentDir : '/';

  logger.debug(`Searching for project root starting from: ${currentDir}`);

  // Search upward for project markers
  while (currentDir !== root) {
    // Check for project markers in priority order
    const markers = [
      'agentuse.json',        // Future: Agentuse-specific config (not implemented yet)
      'agentuse.toml',        // Future: Alternative config format (not implemented yet)
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
  logger.debug(`No project root markers found, using: ${dirname(startPath)}`);
  return dirname(startPath);
}

/**
 * Resolve project context based on current directory and CLI options
 *
 * @param currentDir - Current working directory
 * @param options - CLI options
 * @returns Project context with resolved paths
 */
export function resolveProjectContext(
  currentDir: string,
  options: { envFile?: string } = {}
): {
  projectRoot: string;
  envFile: string;
  pluginDirs: string[];
} {
  // Find project root from current directory
  const projectRoot = findProjectRoot(currentDir);

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
    envFile,
    pluginDirs,
  };
}