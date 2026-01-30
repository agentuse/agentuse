import type { Tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { CommandValidator } from './command-validator.js';
import type { BashConfig, ToolOutput, ToolErrorOutput } from './types.js';
import { resolveRealPath, type PathResolverContext } from './path-validator.js';
import { logger } from '../utils/logger.js';

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const DEFAULT_MAX_OUTPUT = 30 * 1024; // 30KB

// Environment variables that should be cleared for security
// These can be used for library injection, path hijacking, or other attacks
const DANGEROUS_ENV_VARS = [
  // Library injection (Linux)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_DYNAMIC_WEAK',
  'LD_ORIGIN_PATH',
  'LD_PROFILE',
  'LD_SHOW_AUXV',

  // Library injection (macOS)
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_IMAGE_SUFFIX',
  'DYLD_PRINT_LIBRARIES',

  // Python injection
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',

  // Node.js injection
  'NODE_OPTIONS',
  'NODE_PATH',

  // Ruby injection
  'RUBYLIB',
  'RUBYOPT',

  // Perl injection
  'PERL5LIB',
  'PERL5OPT',
  'PERLLIB',

  // Bash startup injection
  'BASH_ENV',
  'ENV',
  'CDPATH',

  // Git hooks (can execute arbitrary code)
  'GIT_TEMPLATE_DIR',
  'GIT_EXEC_PATH',

  // IFS manipulation (word splitting attacks)
  'IFS',

  // Proxy hijacking
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'all_proxy',
  'ftp_proxy',
  'FTP_PROXY',
];

/**
 * Create a sanitized environment for command execution
 * Removes dangerous environment variables that could be used for attacks
 */
function createSafeEnvironment(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Clear all dangerous environment variables
  for (const varName of DANGEROUS_ENV_VARS) {
    delete env[varName];
  }

  // Set safe defaults
  env['SHELL'] = '/bin/sh';
  env['PWD'] = projectRoot;

  // Ensure PATH doesn't start with current directory (PATH injection)
  if (env['PATH']) {
    const paths = env['PATH'].split(':').filter(p => p !== '.' && p !== '');
    env['PATH'] = paths.join(':');
  }

  return env;
}

/**
 * Kill a process and all its children
 */
async function killProcessTree(pid: number): Promise<void> {
  try {
    // On Unix, use negative PID to kill process group
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Fallback to just killing the process
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already dead
    }
  }
}

/**
 * Resolve variable placeholders in an allowed path.
 * Supported: ${root}, ${agentDir}, ${tmpDir}, ~
 */
function resolveAllowedPath(allowedPath: string, context: PathResolverContext): string {
  let result = allowedPath;

  // Resolve ~ for home directory
  if (result.startsWith('~')) {
    result = result.replace(/^~/, os.homedir());
  }

  // Resolve variables
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
 * Check if a path is within any of the allowed directories
 */
function isPathWithinAllowed(
  targetPath: string,
  projectRoot: string,
  allowedPaths: string[],
  context: PathResolverContext
): boolean {
  const normalizedTarget = path.normalize(targetPath);

  // Check project root
  const normalizedProjectRoot = path.normalize(projectRoot);
  const relativeToProject = path.relative(normalizedProjectRoot, normalizedTarget);
  if (!relativeToProject.startsWith('..') && !path.isAbsolute(relativeToProject)) {
    return true;
  }

  // Check allowedPaths with variable resolution
  for (const allowedPath of allowedPaths) {
    const resolvedAllowedPath = resolveAllowedPath(allowedPath, context);
    const normalizedAllowed = path.normalize(resolvedAllowedPath);
    const relative = path.relative(normalizedAllowed, normalizedTarget);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return true;
    }
  }

  return false;
}

/**
 * Create the bash tool
 */
export function createBashTool(
  config: BashConfig,
  projectRoot: string,
  context?: PathResolverContext
): Tool {
  const allowedPaths = config.allowedPaths ?? [];
  const resolverContext: PathResolverContext = context ?? { projectRoot };
  const validator = new CommandValidator(config.commands, projectRoot, allowedPaths, resolverContext);
  const timeoutConfigured = config.timeout !== undefined;
  const defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT;

  // Build description with allowed commands and paths
  const allowedCommandsList = config.commands.map(cmd => `  - ${cmd}`).join('\n');

  // Resolve allowed paths for display
  const allowedPathsList = allowedPaths.length > 0
    ? allowedPaths.map(p => {
        const resolved = resolveAllowedPath(p, resolverContext);
        // If path contains ${tmpDir}, show the resolved path for clarity
        if (p.includes('${tmpDir}')) {
          return `  - ${resolved} (use this for temporary files)`;
        }
        return `  - ${resolved}`;
      }).join('\n')
    : `  - ${projectRoot} (project root)`;

  const description = `Execute a shell command. Only commands matching the configured allowlist patterns are permitted.

Allowed command patterns:
${allowedCommandsList}

Allowed file paths (use these for any file operations):
${allowedPathsList}

Commands not matching these patterns will be rejected.`;

  // Build input schema - only expose timeout if not configured by user
  const baseSchema = {
    command: z.string().describe('The shell command to execute'),
    workdir: z.string().optional().describe(`Working directory for command execution. Must be within the project. Defaults to project root. Use this instead of 'cd' commands.`),
  };

  const inputSchema = timeoutConfigured
    ? z.object(baseSchema)
    : z.object({
        ...baseSchema,
        timeout: z.number().optional().describe(`Optional timeout in milliseconds (default: ${DEFAULT_TIMEOUT}ms)`),
      });

  return {
    description,
    inputSchema,
    execute: async ({ command, workdir, timeout }: {
      command: string;
      workdir?: string;
      timeout?: number;
    }): Promise<ToolOutput> => {
      // Validate command (async with tree-sitter)
      const validation = await validator.validate(command);
      if (!validation.allowed) {
        const error: ToolErrorOutput = {
          success: false,
          error: validation.error || 'Command validation failed',
        };

        // Log warning after tool result is displayed (next tick)
        setImmediate(() => {
          logger.warn(`Bash command blocked: "${command}"`);
        });

        return { output: JSON.stringify(error) };
      }

      // Resolve and validate workdir
      let cwd = projectRoot;
      if (workdir) {
        const resolvedWorkdir = path.isAbsolute(workdir)
          ? workdir
          : path.resolve(projectRoot, workdir);

        // Security: ensure workdir is within allowed directories
        if (!isPathWithinAllowed(resolvedWorkdir, projectRoot, allowedPaths, resolverContext)) {
          const error: ToolErrorOutput = {
            success: false,
            error: `Working directory outside allowed paths. Add "${workdir}" to tools.bash.allowedPaths`,
          };
          return { output: JSON.stringify(error) };
        }
        cwd = resolvedWorkdir;
      }

      // If user configured timeout, use it strictly; otherwise let model decide
      const timeoutMs = timeoutConfigured
        ? defaultTimeout
        : (timeout ?? defaultTimeout);

      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let stdoutTruncated = false;
        let stderrTruncated = false;

        // Spawn the command with sanitized environment
        const child = spawn(command, {
          shell: true,
          cwd,
          detached: true, // Create new process group for cleanup
          env: createSafeEnvironment(cwd),
        });

        // Set up timeout
        const timeoutHandle = setTimeout(async () => {
          timedOut = true;
          if (child.pid) {
            await killProcessTree(child.pid);
          }
        }, timeoutMs);

        // Collect stdout
        child.stdout?.on('data', (data: Buffer) => {
          if (stdout.length < DEFAULT_MAX_OUTPUT) {
            stdout += data.toString();
            if (stdout.length > DEFAULT_MAX_OUTPUT) {
              stdout = stdout.slice(0, DEFAULT_MAX_OUTPUT);
              stdoutTruncated = true;
            }
          }
        });

        // Collect stderr
        child.stderr?.on('data', (data: Buffer) => {
          if (stderr.length < DEFAULT_MAX_OUTPUT) {
            stderr += data.toString();
            if (stderr.length > DEFAULT_MAX_OUTPUT) {
              stderr = stderr.slice(0, DEFAULT_MAX_OUTPUT);
              stderrTruncated = true;
            }
          }
        });

        // Handle process exit
        child.on('close', (code) => {
          clearTimeout(timeoutHandle);

          // Build output
          let output = '';

          if (stdout) {
            output += stdout;
          }

          if (stderr) {
            if (output) output += '\n\n';
            output += `[stderr]\n${stderr}`;
          }

          // Build metadata hints for LLM (OpenCode pattern)
          const resultMetadata: string[] = ['<bash_metadata>'];

          if (stdoutTruncated || stderrTruncated) {
            resultMetadata.push(`bash tool truncated output as it exceeded ${DEFAULT_MAX_OUTPUT} byte limit`);
          }

          if (timedOut) {
            resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeoutMs}ms`);
          }

          if (code !== 0 && code !== null) {
            resultMetadata.push(`exit code: ${code}`);
          }

          // Append metadata if any warnings/info
          if (resultMetadata.length > 1) {
            resultMetadata.push('</bash_metadata>');
            output += '\n\n' + resultMetadata.join('\n');
          }

          resolve({
            output: output || '(no output)',
            metadata: {
              exitCode: code,
              timedOut,
              truncated: stdoutTruncated || stderrTruncated,
            },
          });
        });

        // Handle errors
        child.on('error', (err) => {
          clearTimeout(timeoutHandle);
          const error: ToolErrorOutput = {
            success: false,
            error: `Failed to execute command: ${err.message}`,
          };
          resolve({ output: JSON.stringify(error) });
        });
      });
    },
  };
}
