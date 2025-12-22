import type { Tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import { CommandValidator } from './command-validator.js';
import type { BashConfig, ToolOutput, ToolErrorOutput } from './types.js';

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const DEFAULT_MAX_OUTPUT = 30 * 1024; // 30KB

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

  return {
    description: 'Execute a shell command. Only commands matching the configured allowlist patterns are permitted.',
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

        // Spawn the command
        const child = spawn(command, {
          shell: true,
          cwd: projectRoot,
          detached: true, // Create new process group for cleanup
          env: {
            ...process.env,
            // Limit some potentially dangerous env vars
            SHELL: '/bin/sh',
          },
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
