import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { minimatch } from 'minimatch';
import type { FilesystemPathConfig, FilesystemPermission, PathValidationResult } from './types.js';

// Sensitive file patterns that are blocked by default
const SENSITIVE_FILE_PATTERNS = [
  // Environment files with secrets
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '.env.*',
];

// Exceptions to sensitive file patterns (safe to read)
const SENSITIVE_FILE_EXCEPTIONS = [
  '.env.sample',
  '.env.example',
  '.env.template',
  '.env.defaults',
];

export interface PathResolverContext {
  projectRoot: string;
  agentDir?: string | undefined;
  tmpDir?: string | undefined;
}

/**
 * Resolve safe variable placeholders in a string.
 * Only resolves ${root}, ${agentDir}, ${tmpDir} - NOT ${env:*} to prevent secret exposure.
 *
 * @param text The text that may contain variable placeholders
 * @param context Path resolver context with projectRoot, agentDir, and tmpDir
 * @returns The text with safe variables resolved
 */
export function resolveSafeVariables(text: string, context: PathResolverContext): string {
  let result = text
    .replace(/\$\{root\}/g, context.projectRoot)
    .replace(/\$\{tmpDir\}/g, context.tmpDir ?? os.tmpdir());

  // Only replace ${agentDir} if it's defined
  if (context.agentDir) {
    result = result.replace(/\$\{agentDir\}/g, context.agentDir);
  }

  return result;
}

export class PathValidator {
  private readonly projectRoot: string;
  private readonly agentDir: string | undefined;
  private readonly tmpDir: string;
  private readonly configs: FilesystemPathConfig[];

  constructor(configs: FilesystemPathConfig[], context: PathResolverContext) {
    this.configs = configs;
    this.projectRoot = context.projectRoot;
    this.agentDir = context.agentDir;
    this.tmpDir = context.tmpDir ?? os.tmpdir();
  }

  /**
   * Resolve variable placeholders in a path pattern
   * Supported: ${root}, ${agentDir}, ${tmpDir}, ~
   */
  private resolveVariables(pattern: string): string {
    let result = pattern
      .replace(/\$\{root\}/g, this.projectRoot)
      .replace(/\$\{tmpDir\}/g, this.tmpDir)
      .replace(/^~/, os.homedir());

    // Only replace ${agentDir} if it's defined
    if (this.agentDir) {
      result = result.replace(/\$\{agentDir\}/g, this.agentDir);
    }

    return result;
  }

  /**
   * Resolve a file path to absolute, normalized form
   */
  resolvePath(filePath: string): string {
    // Handle ~ for home directory
    if (filePath.startsWith('~')) {
      filePath = filePath.replace(/^~/, os.homedir());
    }

    // Resolve to absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);

    // Normalize to remove . and ..
    return path.normalize(absolutePath);
  }

  /**
   * Check if a file is a sensitive file that should be blocked
   */
  private isSensitiveFile(filePath: string): boolean {
    const basename = path.basename(filePath);

    // Check if it's an exception (safe files)
    for (const exception of SENSITIVE_FILE_EXCEPTIONS) {
      if (basename === exception || basename.toLowerCase() === exception.toLowerCase()) {
        return false;
      }
    }

    // Check if it matches sensitive patterns
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.includes('*')) {
        // Wildcard pattern
        if (minimatch(basename, pattern, { dot: true })) {
          return true;
        }
      } else {
        // Exact match
        if (basename === pattern || basename.toLowerCase() === pattern.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Resolve symlinks to get the real path
   */
  private resolveSymlinks(filePath: string): string {
    try {
      // For existing files, resolve symlinks
      return fs.realpathSync(filePath);
    } catch {
      // For non-existing files (write), resolve parent directory
      const dir = path.dirname(filePath);
      try {
        const realDir = fs.realpathSync(dir);
        return path.join(realDir, path.basename(filePath));
      } catch {
        // Parent doesn't exist either, return as-is
        return filePath;
      }
    }
  }

  /**
   * Check if a path matches a glob pattern
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    const resolvedPattern = this.resolveVariables(pattern);

    // Normalize both for consistent matching
    const normalizedPath = path.normalize(filePath);
    const normalizedPattern = path.normalize(resolvedPattern);

    return minimatch(normalizedPath, normalizedPattern, {
      dot: true,        // Match dotfiles
      matchBase: false, // Don't match basename only
      nocase: process.platform === 'darwin', // Case-insensitive on macOS
    });
  }

  /**
   * Find all patterns that match a path and have the required permission
   */
  private findMatchingConfigs(
    filePath: string,
    permission: FilesystemPermission
  ): { config: FilesystemPathConfig; pattern: string }[] {
    const matches: { config: FilesystemPathConfig; pattern: string }[] = [];

    for (const config of this.configs) {
      if (!config.permissions.includes(permission)) {
        continue;
      }

      const patterns = config.paths ?? (config.path ? [config.path] : []);

      for (const pattern of patterns) {
        if (this.matchesPattern(filePath, pattern)) {
          matches.push({ config, pattern });
        }
      }
    }

    return matches;
  }

  /**
   * Validate if a path is allowed for the given operation
   */
  validate(
    filePath: string,
    operation: FilesystemPermission
  ): PathValidationResult {
    // Resolve the path to absolute form
    const resolvedPath = this.resolvePath(filePath);

    // Resolve symlinks to prevent symlink-based escapes
    const realPath = this.resolveSymlinks(resolvedPath);

    // Check for sensitive files (e.g., .env)
    if (this.isSensitiveFile(realPath)) {
      return {
        allowed: false,
        resolvedPath: realPath,
        error: `Access denied: '${path.basename(realPath)}' is a sensitive file that may contain secrets`,
      };
    }

    // If no configs, nothing is allowed
    if (this.configs.length === 0) {
      return {
        allowed: false,
        resolvedPath: realPath,
        error: 'No filesystem paths configured',
      };
    }

    // Find matching patterns with required permission
    const matches = this.findMatchingConfigs(realPath, operation);

    if (matches.length === 0) {
      // Check if path matches any pattern (wrong permission)
      const allPatterns = this.configs.flatMap(c => c.paths ?? (c.path ? [c.path] : []));
      const matchesAnyPattern = allPatterns.some(p => this.matchesPattern(realPath, p));

      if (matchesAnyPattern) {
        return {
          allowed: false,
          resolvedPath: realPath,
          error: `Permission denied: '${operation}' not allowed for this path`,
        };
      }

      return {
        allowed: false,
        resolvedPath: realPath,
        error: `Path not in allowed directories: ${realPath}`,
      };
    }

    return {
      allowed: true,
      resolvedPath: realPath,
      matchedPattern: matches[0].pattern,
    };
  }

  /**
   * Get all configured patterns for a specific permission
   */
  getPatternsForPermission(permission: FilesystemPermission): string[] {
    const patterns: string[] = [];

    for (const config of this.configs) {
      if (config.permissions.includes(permission)) {
        const configPatterns = config.paths ?? (config.path ? [config.path] : []);
        patterns.push(...configPatterns.map(p => this.resolveVariables(p)));
      }
    }

    return patterns;
  }
}
