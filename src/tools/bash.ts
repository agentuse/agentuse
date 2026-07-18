import type { Tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as path from 'path';
import * as os from 'os';
import { CommandValidator, getBuiltinPayloadCommandInvocation } from './command-validator.js';
import type { BashConfig, ToolOutput, ToolErrorOutput } from './types.js';
import { resolveRealPath, type PathResolverContext } from './path-validator.js';
import { createBoundedAccumulator, getToolOutputLimits } from './tool-output-limits.js';
import { logger } from '../utils/logger.js';
import { parseDurationMs } from '../utils/duration.js';
import type { ModelToolOutputArtifactRef, ToolOutputArtifactRef, ToolOutputArtifactStream } from '../session/types.js';

const DEFAULT_TIMEOUT = 120000; // 2 minutes

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

  // Drop every non-absolute PATH entry (PATH injection). Filtering only '.'
  // and '' left relative entries like 'bin' or './tools', which still let a
  // binary planted in cwd shadow a real command.
  if (env['PATH']) {
    const paths = env['PATH'].split(':').filter(p => p.startsWith('/'));
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
  const normalizedTarget = resolveRealPath(targetPath);

  // Check project root
  const normalizedProjectRoot = resolveRealPath(projectRoot);
  const relativeToProject = path.relative(normalizedProjectRoot, normalizedTarget);
  if (!relativeToProject.startsWith('..') && !path.isAbsolute(relativeToProject)) {
    return true;
  }

  // Check allowedPaths with variable resolution
  for (const allowedPath of allowedPaths) {
    const resolvedAllowedPath = resolveAllowedPath(allowedPath, context);
    const normalizedAllowed = resolveRealPath(resolvedAllowedPath);
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
  const defaultTimeout = config.timeout !== undefined
    ? parseDurationMs(config.timeout, {
        bareUnit: 'milliseconds',
        field: 'tools.bash.timeout',
        onBareNumber: (v) => {
          logger.warn(
            `tools.bash.timeout: ${v} is interpreted as MILLISECONDS (deprecated). ` +
            `Use a suffixed duration like "${v}ms" or "${Math.max(1, Math.round(v / 1000))}s" - ` +
            `bare numbers here will mean seconds in 1.0.`
          );
        },
      })
    : DEFAULT_TIMEOUT;
  const { maxBytes: maxOutputBytes, headRatio } = getToolOutputLimits();
  const artifactSink = resolverContext.toolOutputArtifacts;

  function modelToolOutputArtifactRef(artifact: ToolOutputArtifactRef): ModelToolOutputArtifactRef {
    return {
      kind: artifact.kind,
      path: artifact.path,
      bytes: artifact.bytes,
      originalChars: artifact.originalChars,
    };
  }

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

How allowlist matching works:
- A pattern matches token by token: the first token is the command name, each following pattern token must match an argument (in order). "*" matches any run of arguments, "?" matches a single character inside a token.
- Extra arguments before, between, or after pattern tokens are fine as long as every pattern token finds a match (e.g. "curl * https://r.jina.ai/*" allows "curl -sSL https://r.jina.ai/x -o tmp/y.txt").
- In compound commands (&&, ||, ;, |), EVERY segment must match an allowed pattern on its own. Don't chain helpers like echo/cat unless they are allowlisted; run one allowed command per call instead.
- Redirections (> file, 2>&1) are not part of matching, but redirection target paths must be inside the allowed file paths.
- "cd" is always allowed, but prefer the workdir parameter.

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
        timeout: z.number().optional().describe(`Optional timeout in MILLISECONDS, not seconds (default: ${DEFAULT_TIMEOUT}ms = 2 minutes). e.g. 30000 for 30 seconds.`),
      });

  return {
    description,
    inputSchema,
    execute: async ({ command, workdir, timeout }: {
      command: string;
      workdir?: string;
      timeout?: number;
    }, callOptions?: { abortSignal?: AbortSignal; toolCallId?: string }): Promise<ToolOutput> => {
      const abortSignal = callOptions?.abortSignal;
      const callId = callOptions?.toolCallId;
      const audit = resolverContext.effectAudit;

      // Validate command (async with tree-sitter)
      const validation = await validator.validate(command);
      if (!validation.allowed) {
        const message = [
          'Command blocked by agent configuration.',
          `Reason: ${validation.error || 'Command validation failed'}`,
          'Matching rules: patterns match token by token ("*" = any run of arguments); extra arguments around matched tokens are fine. In compound commands (&&, ;, |) EVERY segment must independently match an allowed pattern, so retry with a single allowed command and without unlisted helpers like echo/cat.',
          'Run `agentuse doctor <agent-file>` to diagnose missing tools or skill grants.',
        ].filter(Boolean).join('\n');
        const error: ToolErrorOutput = {
          success: false,
          error: message,
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

      // Refuse to spawn at all when the run is already aborted (e.g. an approval
      // suspension began before this sibling call was dispatched). Spawning here
      // would execute an effect no human ever sees.
      if (abortSignal?.aborted) {
        audit?.append({
          event: 'bash-refused-aborted',
          ...(callId && { callId }),
          command,
        });
        const error: ToolErrorOutput = {
          success: false,
          error: 'Command not started: execution aborted (run suspended or cancelled).',
        };
        return { output: JSON.stringify(error), metadata: { aborted: true } };
      }

      let artifactStream: ToolOutputArtifactStream | undefined;
      try {
        artifactStream = await artifactSink?.createStream('tools__bash', {
          command,
          cwd,
          timeoutMs,
        });
      } catch (error) {
        logger.debug(`Failed to create bash full-output artifact stream: ${(error as Error).message}`);
      }

      let artifactChannel: 'stdout' | 'stderr' | undefined;
      const writeArtifactChunk = (channel: 'stdout' | 'stderr', chunk: string): void => {
        if (!artifactStream || chunk.length === 0) return;
        if (artifactChannel !== channel) {
          artifactStream.write(`\n[${channel}]\n`);
          artifactChannel = channel;
        }
        artifactStream.write(chunk);
      };

      const finishArtifact = async (truncated: boolean): Promise<ToolOutputArtifactRef | undefined> => {
        if (!artifactStream) return undefined;
        if (!truncated) {
          try {
            await artifactStream.discard();
          } catch (error) {
            logger.debug(`Failed to discard bash full-output artifact stream: ${(error as Error).message}`);
          }
          return undefined;
        }

        try {
          return await artifactStream.finalize();
        } catch (error) {
          logger.debug(`Failed to persist bash full-output artifact: ${(error as Error).message}`);
          return undefined;
        }
      };

      return new Promise((resolve) => {
        const stdoutAcc = createBoundedAccumulator(maxOutputBytes, headRatio);
        const stderrAcc = createBoundedAccumulator(maxOutputBytes, headRatio);
        let timedOut = false;
        let aborted = false;
        const spawnedAt = Date.now();

        const payloadInvocation = getBuiltinPayloadCommandInvocation(command, config.commands);

        // Spawn built-in payload commands without a shell so embedded languages
        // like JavaScript are passed as data, not re-parsed as shell syntax.
        const child = payloadInvocation && !payloadInvocation.matchedPattern.startsWith('blocked:')
          ? spawn(payloadInvocation.command, payloadInvocation.args, {
            shell: false,
            cwd,
            detached: true, // Create new process group for cleanup
            env: createSafeEnvironment(cwd),
          })
          : spawn(command, {
            shell: true,
            cwd,
            detached: true, // Create new process group for cleanup
            env: createSafeEnvironment(cwd),
          });

        // Audit at the OS boundary: the record exists the moment the process
        // does, independent of whether the stream consumer ever sees this call.
        audit?.append({
          event: 'bash-spawn',
          ...(callId && { callId }),
          command,
          cwd,
          ...(child.pid !== undefined && { pid: child.pid }),
        });

        // Set up timeout
        const timeoutHandle = setTimeout(async () => {
          timedOut = true;
          if (child.pid) {
            await killProcessTree(child.pid);
          }
        }, timeoutMs);

        // Abort (approval suspension or run cancellation) kills the whole
        // process tree. Without this, a `birdc reply` sibling of a pending gate
        // keeps running detached and posts before any human decision.
        const onAbort = () => {
          aborted = true;
          if (child.pid) {
            void killProcessTree(child.pid);
          }
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        // Decode as UTF-8 across chunk boundaries. A bare data.toString() per
        // ~64KB chunk corrupts any multi-byte character (emoji/CJK/accents)
        // that straddles a boundary; StringDecoder buffers the partial bytes.
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');

        // Collect stdout (head+tail bounded; middle dropped if it overflows)
        child.stdout?.on('data', (data: Buffer) => {
          const chunk = stdoutDecoder.write(data);
          if (chunk) {
            stdoutAcc.append(chunk);
            writeArtifactChunk('stdout', chunk);
          }
        });

        // Collect stderr (head+tail bounded; middle dropped if it overflows)
        child.stderr?.on('data', (data: Buffer) => {
          const chunk = stderrDecoder.write(data);
          if (chunk) {
            stderrAcc.append(chunk);
            writeArtifactChunk('stderr', chunk);
          }
        });

        // Handle process exit
        child.on('close', async (code) => {
          clearTimeout(timeoutHandle);
          abortSignal?.removeEventListener('abort', onAbort);
          audit?.append({
            event: 'bash-exit',
            ...(callId && { callId }),
            ...(child.pid !== undefined && { pid: child.pid }),
            code,
            timedOut,
            aborted,
            durationMs: Date.now() - spawnedAt,
          });

          // Flush any bytes the decoders were holding for a split character.
          const stdoutTail = stdoutDecoder.end();
          if (stdoutTail) {
            stdoutAcc.append(stdoutTail);
            writeArtifactChunk('stdout', stdoutTail);
          }
          const stderrTail = stderrDecoder.end();
          if (stderrTail) {
            stderrAcc.append(stderrTail);
            writeArtifactChunk('stderr', stderrTail);
          }

          const stdout = stdoutAcc.finalize();
          const stderr = stderrAcc.finalize();
          const truncated = stdoutAcc.truncated || stderrAcc.truncated;
          const fullOutputArtifact = await finishArtifact(truncated);
          const modelFullOutputArtifact = fullOutputArtifact
            ? modelToolOutputArtifactRef(fullOutputArtifact)
            : undefined;

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

          if (truncated) {
            resultMetadata.push(`bash tool truncated output as it exceeded ${maxOutputBytes} byte limit (kept head + tail)`);
          }

          if (modelFullOutputArtifact) {
            resultMetadata.push(`full output saved to session artifact: ${modelFullOutputArtifact.path} (${modelFullOutputArtifact.bytes} bytes)`);
          }

          if (timedOut) {
            resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeoutMs}ms`);
          }

          if (aborted) {
            resultMetadata.push('bash tool killed the command: execution aborted (run suspended or cancelled)');
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
              truncated,
              ...(aborted && { aborted }),
              ...(modelFullOutputArtifact && { fullOutputArtifact: modelFullOutputArtifact }),
            },
          });
        });

        // Handle errors
        child.on('error', async (err) => {
          clearTimeout(timeoutHandle);
          abortSignal?.removeEventListener('abort', onAbort);
          audit?.append({
            event: 'bash-exit',
            ...(callId && { callId }),
            ...(child.pid !== undefined && { pid: child.pid }),
            error: err.message,
            aborted,
            durationMs: Date.now() - spawnedAt,
          });
          await finishArtifact(false);
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
