/**
 * Docker Sandbox integration — schema, lifecycle, and tool creation
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { mkdirSync, existsSync, readdirSync, rmdirSync } from 'fs';
import { join } from 'path';
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

interface Container {
  id: string;
  start(): Promise<void>;
  stop(opts?: { t?: number }): Promise<void>;
  remove(opts?: { force?: boolean }): Promise<void>;
  exec(opts: {
    Cmd: string[];
    AttachStdout?: boolean;
    AttachStderr?: boolean;
    WorkingDir?: string;
  }): Promise<Exec>;
  modem: { demuxStream(stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void };
}

interface Exec {
  start(opts?: { hijack?: boolean }): Promise<NodeJS.ReadableStream>;
  inspect(): Promise<{ ExitCode: number }>;
}

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

/**
 * Remove orphaned agentuse containers left behind by force-quit or crash.
 * Called before creating a new container.
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
      try {
        const container = docker.getContainer(info.Id);
        if (info.State === 'running') {
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

export async function createSandbox(options: CreateSandboxOptions): Promise<SandboxInstance> {
  const { config, projectRoot, sessionId, filesystemMounts } = options;
  const Docker = (await import('dockerode')).default;
  const docker = new Docker(resolveDockerOpts());

  // Clean up any orphaned containers from previous force-quit/crash
  await cleanupOrphanedContainers();

  const image = config.image ?? 'node:22-slim';
  const timeout = config.timeout ?? 300;

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

  const container: Container = await docker.createContainer({
    Image: image,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: projectRoot,
    Labels: {
      [LABEL_MANAGED]: 'true',
      ...(sessionId && { [LABEL_SESSION]: sessionId }),
    },
    Env: envVars.length > 0 ? envVars : undefined,
    HostConfig: { Binds: binds },
  });

  await container.start();
  logger.debug(`[Sandbox] Container started: ${container.id}`);

  // Run setup commands if configured
  if (config.setup) {
    const cmds = Array.isArray(config.setup) ? config.setup : [config.setup];
    for (const cmd of cmds) {
      logger.info(`[Sandbox] Running setup: ${cmd}`);
      const result = await execInContainer(container, cmd);
      if (result.exitCode !== 0) {
        const stderr = result.stderr || result.stdout;
        throw new Error(`Sandbox setup command failed (exit ${result.exitCode}): ${stderr.trim()}`);
      }
    }
    logger.debug(`[Sandbox] Setup complete (${cmds.length} command(s))`);
  }

  // Auto-kill timer
  const timer = setTimeout(async () => {
    logger.warn(`[Sandbox] Container ${container.id} timed out after ${timeout}s, killing`);
    try {
      await container.stop({ t: 2 });
      await container.remove({ force: true });
    } catch {
      // container may already be gone
    }
  }, timeout * 1000);

  // Signal handlers for graceful cleanup on SIGINT/SIGTERM
  const signalHandler = () => {
    container.stop({ t: 2 })
      .then(() => container.remove({ force: true }))
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  return {
    container,
    kill: async () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
      try {
        await container.stop({ t: 2 });
        await container.remove({ force: true });
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
  options?: { cwd?: string },
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
    ...(options?.cwd && { WorkingDir: options.cwd }),
  });

  const stream = await exec.start();

  // Collect stdout/stderr via demux
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const { PassThrough } = await import('stream');
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  stdoutStream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrStream.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  container.modem.demuxStream(stream, stdoutStream, stderrStream);

  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
  });

  const { ExitCode } = await exec.inspect();

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode: ExitCode,
  };
}

// ── Tools ───────────────────────────────────────────────────────────

export function createSandboxTools(container: Container, projectRoot: string): Record<string, Tool> {
  return {
    sandbox__exec: {
      description:
        'Execute a shell command in the Docker sandbox. Returns stdout, stderr, and exit code. ' +
        `Working directory defaults to ${projectRoot}. Filesystem paths inside the container mirror the host. ` +
        'Use the filesystem tool for reading/writing project files on the host.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe(`Working directory (default: ${projectRoot})`),
      }),
      execute: async ({ command, cwd }: { command: string; cwd?: string }) => {
        const result = await execInContainer(container, command, cwd ? { cwd } : undefined);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
    },
  };
}
