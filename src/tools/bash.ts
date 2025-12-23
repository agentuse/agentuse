import type { Tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import { CommandValidator } from './command-validator.js';
import type { BashConfig, ToolOutput, ToolErrorOutput } from './types.js';

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
 * Create the bash tool
 */
export function createBashTool(
  config: BashConfig,
  projectRoot: string
): Tool {
  const validator = new CommandValidator(config.commands, projectRoot);
  const defaultTimeout = config.timeout || DEFAULT_TIMEOUT;

  // Build description with allowed commands
  const allowedCommandsList = config.commands.map(cmd => `  - ${cmd}`).join('\n');
  const description = `Execute a shell command. Only commands matching the configured allowlist patterns are permitted.

Allowed command patterns:
${allowedCommandsList}

Commands not matching these patterns will be rejected.`;

  return {
    description,
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout: z.number().optional().describe(`Timeout in milliseconds (default: ${defaultTimeout})`),
    }),
    execute: async ({ command, timeout }: {
      command: string;
      timeout?: number;
    }): Promise<ToolOutput> => {
      // Validate command
      const validation = validator.validate(command);
      if (!validation.allowed) {
        const error: ToolErrorOutput = {
          success: false,
          error: validation.error || 'Command validation failed',
        };
        return { output: JSON.stringify(error) };
      }

      const timeoutMs = timeout || defaultTimeout;

      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let stdoutTruncated = false;
        let stderrTruncated = false;

        // Spawn the command with sanitized environment
        const child = spawn(command, {
          shell: true,
          cwd: projectRoot,
          detached: true, // Create new process group for cleanup
          env: createSafeEnvironment(projectRoot),
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
            if (stdoutTruncated) {
              output += '\n... (stdout truncated)';
            }
          }

          if (stderr) {
            if (output) output += '\n\n';
            output += `[stderr]\n${stderr}`;
            if (stderrTruncated) {
              output += '\n... (stderr truncated)';
            }
          }

          if (timedOut) {
            output += `\n\n[Process timed out after ${timeoutMs}ms and was killed]`;
          }

          if (code !== 0 && code !== null) {
            output += `\n\n[Exit code: ${code}]`;
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
