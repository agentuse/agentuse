import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getGlobalConfigDir, loadGlobalConfig } from '../utils/global-config.js';

/**
 * This computer's link to AgentUse Cloud, written by `agentuse connect` and
 * read by `agentuse serve`. The machine token is a secret: it opens this
 * computer's line to the cloud, so the file is owner-only.
 */
export interface CloudConnection {
  /** Cloud origin, e.g. https://cloud.agentuse.io */
  url: string;
  machineId: string;
  machineToken: string;
  name: string;
  account?: string;
  mcpUrl: string;
  connectedAt: string;
}

export const DEFAULT_CLOUD_URL = 'https://cloud.agentuse.io';

export const cloudUrl = (override?: string): string =>
  (override ?? process.env.AGENTUSE_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, '');

export const cloudConfigPath = (): string => path.join(getGlobalConfigDir(), 'cloud.json');

/**
 * AgentUse Cloud is in preview: hidden until it is turned on with
 * AGENTUSE_CLOUD=1 (in the shell or the `env` block of ~/.agentuse/config.json),
 * or this computer is already connected. AGENTUSE_CLOUD=0 hides it either way.
 * `agentuse connect` still works when hidden, and connecting turns it on.
 */
export function cloudEnabled(): boolean {
  let flag = process.env.AGENTUSE_CLOUD;
  if (flag === undefined) {
    try {
      flag = loadGlobalConfig()?.env?.AGENTUSE_CLOUD;
    } catch {
      flag = undefined;
    }
  }
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return existsSync(cloudConfigPath());
}

export function readCloudConnection(): CloudConnection | undefined {
  let raw: string;
  try {
    raw = readFileSync(cloudConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<CloudConnection>;
  if (!parsed.url || !parsed.machineId || !parsed.machineToken || !parsed.mcpUrl) {
    throw new Error(`${cloudConfigPath()} is incomplete. Run \`agentuse disconnect\`, then \`agentuse connect\`.`);
  }
  return parsed as CloudConnection;
}

export function writeCloudConnection(connection: CloudConnection): void {
  atomicWriteFileSync(cloudConfigPath(), `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600, mkdir: true });
}

export function removeCloudConnection(): void {
  rmSync(cloudConfigPath(), { force: true });
}

/** A name a person recognises on the approve page: the Mac's own name when there is one. */
export function computerName(): string {
  if (platform() === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim();
      if (name) return name;
    } catch {
      // Fall back to the host name.
    }
  }
  return hostname().replace(/\.local$/u, '');
}

export function platformLabel(): string {
  switch (platform()) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return platform();
  }
}
