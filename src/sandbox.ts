/**
 * Docker Sandbox integration — schema, lifecycle, and tool creation
 */

import type { Tool } from 'ai';
import type Dockerode from 'dockerode';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, readdirSync, rmdirSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import type { ResolvedMount } from './tools/path-validator.js';
import { logger } from './utils/logger';

// ── Schema ──────────────────────────────────────────────────────────

const SandboxObjectSchema = z.object({
  provider: z.literal('docker'),
  image: z.string().optional(),              // default 'node:22-slim'
  timeout: z.number().positive().optional(),  // seconds, default 300
  setup: z.union([z.string(), z.array(z.string())]).optional(), // commands to run after container starts
  env: z.array(z.string()).optional(),       // env var names to forward from host
});

/** Accepts `true` (defaults) or full config object */
export const SandboxConfigSchema = z.union([
  z.literal(true),
  SandboxObjectSchema,
]).transform((val) =>
  val === true ? { provider: 'docker' as const } : val
);

export type SandboxConfig = z.output<typeof SandboxConfigSchema>;

// ── Types ───────────────────────────────────────────────────────────

type Container = Dockerode.Container;

// ── Docker socket detection ─────────────────────────────────────────

function resolveDockerOpts(): { socketPath: string } | Record<string, never> {
  // Respect DOCKER_HOST if set
  if (process.env['DOCKER_HOST']) {
    const host = process.env['DOCKER_HOST'];
    if (host.startsWith('unix://')) {
      return { socketPath: host.replace('unix://', '') };
    }
    // Let dockerode handle tcp:// etc via default constructor
    return {};
  }
  // Docker Desktop on macOS uses ~/.docker/run/docker.sock
  const desktopSocket = join(homedir(), '.docker', 'run', 'docker.sock');
  if (existsSync(desktopSocket)) {
    return { socketPath: desktopSocket };
  }
  // Fall back to default (dockerode will try /var/run/docker.sock)
  return {};
}

// ── Container labels ─────────────────────────────────────────────────

const LABEL_MANAGED = 'agentuse.managed';
const LABEL_SESSION = 'agentuse.session';
const LABEL_PID = 'agentuse.pid';
const LABEL_OWNER_STARTED_AT = 'agentuse.ownerStartedAt';

let currentProcessStartTime: string | undefined;
let linuxBootId: string | undefined;

function parsePid(label: string | undefined): number | null {
  if (!label) return null;
  const pid = Number(label);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function getLinuxBootId(): string | null {
  if (linuxBootId === undefined) {
    try {
      linuxBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      linuxBootId = '';
    }
  }
  return linuxBootId || null;
}

function getLinuxProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    if (endOfCommand === -1) return null;

    // /proc/<pid>/stat field 22 is starttime. After the command field,
    // the remaining fields begin at field 3, so index 19 maps to field 22.
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) return null;

    const bootId = getLinuxBootId();
    return bootId ? `linux:${bootId}:${startTicks}` : `linux:${startTicks}`;
  } catch {
    return null;
  }
}

function getProcessStartTime(pid: number): string | null {
  const linuxStartTime = getLinuxProcessStartTime(pid);
  if (linuxStartTime) return linuxStartTime;

  try {
    const startTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return startTime ? `ps:${startTime}` : null;
  } catch {
    return null;
  }
}

function getCurrentProcessStartTime(): string | null {
  if (currentProcessStartTime === undefined) {
    currentProcessStartTime = getProcessStartTime(process.pid) ?? '';
  }
  return currentProcessStartTime || null;
}

/**
 * Remove orphaned agentuse containers left behind by force-quit or crash.
 * Called before creating a new container. Containers whose owner agentuse
 * process is still alive, with the same process start time, are skipped so
 * concurrent runs don't kill each other's sandboxes even if a PID is reused.
 */
export async function cleanupOrphanedContainers(): Promise<void> {
  try {
    const Docker = (await import('dockerode')).default;
    const docker = new Docker(resolveDockerOpts());

    const containers = await docker.listContainers({
      all: true,
      filters: { label: [LABEL_MANAGED] },
    });

    for (const info of containers) {
      const isRunning = info.State === 'running';
      if (isRunning) {
        const pid = parsePid(info.Labels?.[LABEL_PID]);
        const ownerStartedAt = info.Labels?.[LABEL_OWNER_STARTED_AT];
        if (pid && ownerStartedAt && isProcessAlive(pid)) {
          const currentStartedAt = getProcessStartTime(pid);
          if (currentStartedAt === ownerStartedAt) {
            // Owner agentuse process is still alive — leave its sandbox alone
            continue;
          }
        }
      }

      try {
        const container = docker.getContainer(info.Id);
        if (isRunning) {
          await container.stop({ t: 2 });
        }
        await container.remove({ force: true });
        logger.info(`[Sandbox] Cleaned up orphaned container: ${info.Id.slice(0, 12)}`);
      } catch {
        // container may have been removed between list and cleanup
      }
    }
  } catch {
    // Docker not available or other error — skip cleanup silently
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────

export interface SandboxInstance {
  container: Container;
  kill: () => Promise<void>;
}

export interface CreateSandboxOptions {
  config: SandboxConfig;
  projectRoot: string;
  sessionId?: string | undefined;
  /** Resolved filesystem mounts — each mounted at its real host path */
  filesystemMounts?: ResolvedMount[] | undefined;
}

class SandboxExecTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`[Sandbox] Command timed out after ${Math.ceil(timeoutMs / 1000)}s: ${cmd}`);
    this.name = 'SandboxExecTimeoutError';
  }
}

async function stopAndRemoveContainer(container: Container): Promise<void> {
  try {
    await container.stop({ t: 2 });
  } catch {
    // Container may already be stopped or removed.
  }

  try {
    await container.remove({ force: true });
  } catch {
    // Container may already be removed.
  }
}

export async function createSandbox(options: CreateSandboxOptions): Promise<SandboxInstance> {
  const { config, projectRoot, sessionId, filesystemMounts } = options;
  const Docker = (await import('dockerode')).default;
  const docker = new Docker(resolveDockerOpts());

  // Clean up any orphaned containers from previous force-quit/crash
  await cleanupOrphanedContainers();

  const image = config.image ?? 'node:22-slim';
  const timeout = config.timeout ?? 300;

  // Refuse to silently bind-mount $HOME (or any of its ancestors) as the
  // implicit project root. If a marker like .git/.agentuse/package.json
  // lives at $HOME (claude-code config, dotfile repos), an upstream
  // mis-resolution can otherwise expose ~/.ssh, ~/.aws, browser profiles,
  // and the rest of the home directory to the sandbox.
  const resolvedHome = resolve(homedir());
  const resolvedProjectRoot = resolve(projectRoot);
  const isHomeOrAbove = (p: string) => {
    const r = resolve(p);
    return r === resolvedHome || resolvedHome.startsWith(r + sep) || r === sep;
  };
  if (isHomeOrAbove(resolvedProjectRoot)) {
    throw new Error(
      `[Sandbox] Refusing to mount '${projectRoot}' into the sandbox — it is $HOME or an ancestor. ` +
      `This usually means a project marker (.git, .agentuse, package.json) was found at $HOME. ` +
      `Run the agent from inside a real project directory, or declare an explicit \`filesystem\` mount.`
    );
  }

  // Ensure per-session sandbox output directory exists
  const sandboxDir = join(projectRoot, '.agentuse', 'sandbox', ...(sessionId ? [sessionId] : []));
  mkdirSync(sandboxDir, { recursive: true });

  // Build bind mounts — each filesystem path mounted at its real host path
  const binds: string[] = [`${sandboxDir}:/output:rw`];

  if (filesystemMounts && filesystemMounts.length > 0) {
    // Mount each resolved path at its real host path
    for (const mount of filesystemMounts) {
      const mode = mount.writable ? 'rw' : 'ro';
      binds.push(`${mount.hostPath}:${mount.hostPath}:${mode}`);
      logger.debug(`[Sandbox] Mount: ${mount.hostPath} (${mode})`);
    }
    // Ensure projectRoot is always mounted (add as ro if not already covered)
    const projectCovered = filesystemMounts.some(m =>
      projectRoot === m.hostPath || projectRoot.startsWith(m.hostPath + '/')
    );
    if (!projectCovered) {
      binds.push(`${projectRoot}:${projectRoot}:ro`);
      logger.debug(`[Sandbox] Mount: ${projectRoot} (ro, implicit project root)`);
    }
  } else {
    // Backward compat: no mounts provided, mount projectRoot as ro
    binds.push(`${projectRoot}:${projectRoot}:ro`);
    logger.debug(`[Sandbox] Mount: ${projectRoot} (ro, default)`);
  }

  // Mount global skill directories if they exist
  const home = homedir();
  const globalSkillDirs = [
    join(home, '.agentuse', 'skills'),
    join(home, '.claude', 'skills'),
  ];
  for (const dir of globalSkillDirs) {
    if (existsSync(dir)) {
      binds.push(`${dir}:${dir}:ro`);
    }
  }

  // Auto-pull image if not available locally
  try {
    await docker.getImage(image).inspect();
  } catch {
    logger.info(`[Sandbox] Image '${image}' not found locally, pulling...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
    logger.info(`[Sandbox] Image '${image}' pulled successfully`);
  }

  // Build env var allowlist — only forward explicitly declared vars
  const envVars: string[] = [];
  if (config.env) {
    for (const name of config.env) {
      const value = process.env[name];
      if (value !== undefined) {
        envVars.push(`${name}=${value}`);
      } else {
        logger.debug(`[Sandbox] Env var '${name}' declared but not set on host, skipping`);
      }
    }
    if (envVars.length > 0) {
      logger.debug(`[Sandbox] Forwarding ${envVars.length} env var(s): ${config.env.filter(n => process.env[n] !== undefined).join(', ')}`);
    }
  }

  logger.debug(`[Sandbox] Creating Docker container (image=${image}, timeout=${timeout}s${sessionId ? `, session=${sessionId}` : ''})`);

  const ownerStartedAt = getCurrentProcessStartTime();

  const container: Container = await docker.createContainer({
    Image: image,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: projectRoot,
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_PID]: String(process.pid),
      ...(ownerStartedAt && { [LABEL_OWNER_STARTED_AT]: ownerStartedAt }),
      ...(sessionId && { [LABEL_SESSION]: sessionId }),
    },
    Env: envVars.length > 0 ? envVars : undefined,
    HostConfig: { Binds: binds },
  });

  await container.start();
  logger.debug(`[Sandbox] Container started: ${container.id}`);

  // Start the lifetime timer immediately so image setup is bounded too. The
  // previous behavior only started this after setup, so a hanging setup command
  // could leave the session running forever before the first model call.
  const timer = setTimeout(async () => {
    logger.warn(`[Sandbox] Container ${container.id} timed out after ${timeout}s, killing`);
    await stopAndRemoveContainer(container);
  }, timeout * 1000);

  // Signal handlers for graceful cleanup on SIGINT/SIGTERM
  const signalHandler = () => {
    stopAndRemoveContainer(container)
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  // Run setup commands if configured
  try {
    if (config.setup) {
      const cmds = Array.isArray(config.setup) ? config.setup : [config.setup];
      for (const cmd of cmds) {
        logger.info(`[Sandbox] Running setup: ${cmd}`);
        const result = await execInContainer(container, cmd, {
          timeoutMs: timeout * 1000,
          onTimeout: () => stopAndRemoveContainer(container),
        });
        if (result.exitCode !== 0) {
          const stderr = result.stderr || result.stdout;
          throw new Error(`Sandbox setup command failed (exit ${result.exitCode}): ${stderr.trim()}`);
        }
      }
      logger.debug(`[Sandbox] Setup complete (${cmds.length} command(s))`);
    }
  } catch (error) {
    clearTimeout(timer);
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    await stopAndRemoveContainer(container);
    throw error;
  }

  return {
    container,
    kill: async () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
      try {
        await stopAndRemoveContainer(container);
        logger.debug(`[Sandbox] Container removed: ${container.id}`);
      } catch (error) {
        logger.warn(`[Sandbox] Failed to remove container: ${(error as Error).message}`);
      }
      // Clean up empty sandbox output directory
      try {
        if (existsSync(sandboxDir) && readdirSync(sandboxDir).length === 0) {
          rmdirSync(sandboxDir);
          logger.debug(`[Sandbox] Removed empty output directory: ${sandboxDir}`);
        }
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

// ── Exec helper ─────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execInContainer(
  container: Container,
  cmd: string,
  options?: { cwd?: string; timeoutMs?: number; onTimeout?: () => Promise<void> },
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
    ...(options?.cwd && { WorkingDir: options.cwd }),
  });

  const stream = await exec.start({});

  // Collect stdout/stderr via demux
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const { PassThrough } = await import('stream');
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  stdoutStream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrStream.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  container.modem.demuxStream(stream, stdoutStream, stderrStream);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timeoutError: Error | undefined;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };

    const onEnd = () => settle(timeoutError);
    const onClose = () => settle(timeoutError);
    // After a timeout fires, onTimeout tears the container down, which can make
    // the stream emit its own 'error' before the timeout's settle runs. Prefer
    // the timeout error so the caller reports "timed out" rather than a stray
    // Docker teardown error.
    const onError = (error: Error) => settle(timeoutError ?? error);

    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);

    if (options?.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timeoutError = new SandboxExecTimeoutError(cmd, options.timeoutMs!);
        void Promise.resolve(options.onTimeout?.())
          .catch(() => {})
          .finally(() => settle(timeoutError));
      }, options.timeoutMs);
    }
  });

  const { ExitCode } = await exec.inspect();

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode: ExitCode ?? 1,
  };
}

// ── Tools ───────────────────────────────────────────────────────────

export function createSandboxTools(
  container: Container,
  projectRoot: string,
  commandTimeoutSeconds: number = 300,
): Record<string, Tool> {
  return {
    sandbox__exec: {
      description:
        'Execute a shell command in the Docker sandbox. Returns stdout, stderr, and exit code. ' +
        `Working directory defaults to ${projectRoot}. Filesystem paths inside the container mirror the host. ` +
        `Commands time out after ${commandTimeoutSeconds}s by default. ` +
        'Use the filesystem tool for reading/writing project files on the host.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe(`Working directory (default: ${projectRoot})`),
        timeout: z.number().positive().optional().describe(`Optional command timeout in seconds (default: ${commandTimeoutSeconds})`),
      }),
      execute: async ({ command, cwd, timeout }: { command: string; cwd?: string; timeout?: number }) => {
        try {
          const timeoutSeconds = timeout ?? commandTimeoutSeconds;
          const result = await execInContainer(container, command, {
            ...(cwd && { cwd }),
            timeoutMs: timeoutSeconds * 1000,
            onTimeout: () => stopAndRemoveContainer(container),
          });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          };
        } catch (error) {
          return {
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 124,
          };
        }
      },
    },
  };
}
