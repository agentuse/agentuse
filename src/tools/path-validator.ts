import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { minimatch } from 'minimatch';
import { expandHome } from '../utils/path.js';
import { isPathInside } from '../utils/path-policy.js';
import {
  grantsPermission,
  type EffectAuditSink,
  type FilesystemPathConfig,
  type FilesystemPermission,
  type LiveToolOutputSink,
  type PathValidationResult,
  type ToolOutputArtifactSink
} from './types.js';

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
  toolOutputArtifacts?: ToolOutputArtifactSink | undefined;
  /** Effect-layer audit journal; bash spawn/exit records land here (effect WAL). */
  effectAudit?: EffectAuditSink | undefined;
  /** Human-only live tail of a still-running tool call (session view). */
  liveToolOutput?: LiveToolOutputSink | undefined;
  /** Current session id, for tools that link output to the run (e.g. artifacts). */
  sessionId?: string | undefined;
  /** Stable agent id, for tools that record provenance (e.g. artifacts). */
  agentId?: string | undefined;
  /** Resolved model string (provider:id), for capability-gate error messages. */
  modelId?: string | undefined;
  /**
   * The running model's input modalities (e.g. ["text","image","pdf"]) from the
   * registry, used to gate media reads: an image/PDF is only handed to the model
   * when this includes "image"/"pdf". Undefined when the model is not in the
   * registry — treated as "unknown capability", so media reads are still
   * attempted (the provider surfaces a clear error if truly unsupported).
   */
  modelInputModalities?: string[] | undefined;
  /**
   * Whether the model's transport can actually deliver an image/PDF inside a
   * tool result. Distinct from modalities: e.g. gpt-4o accepts images, but the
   * OpenAI Chat-Completions transport (custom base URL) or OpenRouter would
   * stringify it, and Bedrock throws on a PDF. When a kind is unsupported here,
   * a media read returns a text error instead of emitting a broken part.
   * Undefined falls back to the modalities-only gate (legacy behavior).
   */
  mediaToolResultSupport?: { image: boolean; pdf: boolean } | undefined;
}

/**
 * Resolve a path to its real path, following symlinks.
 * Handles macOS /var -> /private/var and similar symlinks.
 * For non-existent paths, resolves the nearest existing ancestor directory.
 */
export function resolveRealPath(inputPath: string): string {
  try {
    // For existing paths, resolve symlinks directly
    return fs.realpathSync(inputPath);
  } catch {
    // For non-existing paths, traverse up to find the nearest existing ancestor
    const parts: string[] = [];
    let current = inputPath;

    while (current !== path.dirname(current)) {
      parts.unshift(path.basename(current));
      current = path.dirname(current);

      try {
        const realAncestor = fs.realpathSync(current);
        return path.join(realAncestor, ...parts);
      } catch {
        // Keep traversing up
      }
    }

    // Reached root without finding an existing ancestor
    return inputPath;
  }
}

/**
 * Resolve the variable placeholders allowed in a configured path.
 * Supported: `~`, ${root}, ${agentDir}, ${tmpDir}.
 *
 * Shared by the filesystem path validator, the bash tool, and the command
 * validator so a path written in config resolves identically everywhere.
 */
export function resolveAllowedPath(allowedPath: string, context: PathResolverContext): string {
  let result = expandHome(allowedPath);

  const tmpDir = resolveRealPath(context.tmpDir ?? os.tmpdir());
  result = result
    .replace(/\$\{root\}/g, context.projectRoot)
    .replace(/\$\{tmpDir\}/g, tmpDir);

  // Only replace ${agentDir} if it's defined
  if (context.agentDir) {
    result = result.replace(/\$\{agentDir\}/g, context.agentDir);
  }

  return result;
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
  const literals: string[] = [];
  const protectedText = text.replace(/\\\$\{(?:root|agentDir|tmpDir)\}/g, (placeholder) => {
    const marker = `\uE000agentuse-safe-variable-${literals.length}\uE001`;
    literals.push(placeholder.slice(1));
    return marker;
  });
  const tmpDir = resolveRealPath(context.tmpDir ?? os.tmpdir());
  let result = protectedText
    .replace(/\$\{root\}/g, context.projectRoot)
    .replace(/\$\{tmpDir\}/g, tmpDir);

  // Only replace ${agentDir} if it's defined
  if (context.agentDir) {
    result = result.replace(/\$\{agentDir\}/g, context.agentDir);
  }

  return result.replace(/\uE000agentuse-safe-variable-(\d+)\uE001/g, (_marker, index: string) => (
    literals[Number(index)] ?? _marker
  ));
}

/**
 * Escape safe placeholders so prompt preparation leaves them as literal syntax.
 * Use this when embedding source code or documentation inside agent instructions.
 */
export function escapeSafeVariables(text: string): string {
  return text.replace(/(?<!\\)\$\{(?:root|agentDir|tmpDir)\}/g, '\\$&');
}

// ── Filesystem mount resolution for sandbox ─────────────────────────

export interface ResolvedMount {
  hostPath: string;   // Absolute resolved host path
  writable: boolean;  // true if write/edit permission
}

/**
 * Resolve filesystem configs into mountable directory paths for Docker sandbox.
 * Skips glob patterns (not mountable). Deduplicates by hostPath (writable wins).
 */
export function resolveFilesystemMounts(
  configs: FilesystemPathConfig[],
  context: PathResolverContext,
): ResolvedMount[] {
  const mountMap = new Map<string, boolean>(); // hostPath → writable

  for (const config of configs) {
    const patterns = config.paths ?? (config.path ? [config.path] : []);
    const writable = config.permissions.includes('write') || config.permissions.includes('edit');

    for (const pattern of patterns) {
      // Skip glob patterns — not mountable as directories
      if (/[*?[\]]/.test(pattern)) continue;

      // Resolve variables and ~ expansion
      let resolved = expandHome(resolveSafeVariables(pattern, context));

      // Resolve to real path (follows symlinks, handles macOS /var → /private/var)
      resolved = resolveRealPath(resolved);

      // Deduplicate: writable wins
      const existing = mountMap.get(resolved);
      mountMap.set(resolved, existing === true || writable);
    }
  }

  return Array.from(mountMap.entries()).map(([hostPath, writable]) => ({ hostPath, writable }));
}

export class PathValidator {
  private readonly projectRoot: string;
  private readonly agentDir: string | undefined;
  private readonly tmpDir: string;
  private readonly configs: FilesystemPathConfig[];

  constructor(configs: FilesystemPathConfig[], context: PathResolverContext) {
    this.configs = configs;
    this.projectRoot = resolveRealPath(context.projectRoot);
    this.agentDir = context.agentDir ? resolveRealPath(context.agentDir) : undefined;
    this.tmpDir = resolveRealPath(context.tmpDir ?? os.tmpdir());
  }

  /**
   * Resolve variable placeholders in a path pattern
   * Supported: ${root}, ${agentDir}, ${tmpDir}, ~
   */
  private resolveVariables(pattern: string): string {
    let result = resolveAllowedPath(pattern, {
      projectRoot: this.projectRoot,
      agentDir: this.agentDir,
      tmpDir: this.tmpDir,
    });

    if (result.includes('${')) {
      return path.normalize(result);
    }

    if (!path.isAbsolute(result)) {
      result = path.resolve(this.projectRoot, result);
    }

    return path.normalize(result);
  }

  /**
   * Resolve a file path to absolute, normalized form
   */
  resolvePath(filePath: string): string {
    // Handle ~ for home directory
    filePath = expandHome(filePath);

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
   * Check if a path matches a pattern.
   * - If pattern has no glob chars (*, ?, [): uses containment (path is within directory)
   * - If pattern has glob chars: uses glob matching via minimatch
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    const resolvedPattern = this.resolveVariables(pattern);

    // Normalize both for consistent matching
    const normalizedPath = path.normalize(filePath);
    const normalizedPattern = path.normalize(resolvedPattern);

    // If no glob characters, use containment (industry standard: path = path/**)
    if (!/[*?[\]]/.test(normalizedPattern)) {
      return isPathInside(normalizedPattern, normalizedPath);
    }

    // Otherwise use glob matching
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
      if (!grantsPermission(config.permissions, permission)) {
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
    const realPath = resolveRealPath(resolvedPath);

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
      if (grantsPermission(config.permissions, permission)) {
        const configPatterns = config.paths ?? (config.path ? [config.path] : []);
        patterns.push(...configPatterns.map(p => this.resolveVariables(p)));
      }
    }

    return patterns;
  }
}
