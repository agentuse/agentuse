/**
 * Server Registry
 *
 * Tracks running `agentuse serve` instances using PID files.
 * Each server writes a JSON file to {AGENTUSE_DATA_DIR}/servers/<pid>.json on startup,
 * which is removed on graceful shutdown. Stale entries (where PID no longer exists)
 * are cleaned up automatically.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { atomicWriteFileSync } from "./atomic-write";
import { getAgentuseDataDir } from "./data-dir";
import { isPathInside } from "./path-policy";
import { getProcessStartTime, getCurrentProcessStartTime } from "./process-info";
import { readApiKey } from "./session-token";
import type { DesktopServerSupervisor } from "./desktop-supervisor";

export interface ServerProjectEntry {
  id: string;
  root: string;
  scopeRoot?: string;
  agentCount: number;
  scheduleCount: number;
}

export interface ServerEntry {
  pid: number;
  port: number;
  host: string;
  /** Deprecated mirror of projects[0].root; kept for older `ps` output and upgrades. */
  projectRoot: string;
  startTime: number;
  /**
   * OS process-start-time token for `pid`, used to reject a recycled PID as a
   * live daemon. Optional so entries written by older versions still load.
   */
  procStartedAt?: string;
  /** Sum of projects[].agentCount. */
  agentCount: number;
  /** Sum of projects[].scheduleCount. */
  scheduleCount: number;
  version: string;
  /** Base URL used for generated resume and approval links. */
  publicUrl?: string;
  /** One entry per project served by this instance. Present from v0.11.0 onward. */
  projects?: ServerProjectEntry[];
  /** Flat log file path (stdout/stderr tee). Absent when --no-log-file was passed. */
  logFile?: string;
  /** Present when a desktop app process owns this daemon's lifecycle. */
  supervisor?: DesktopServerSupervisor;
}

function getRegistryDir(): string {
  return join(getAgentuseDataDir(), "servers");
}

/**
 * Default flat-log path for a given PID (no rotation, one file per process).
 */
export function getDefaultLogFilePath(pid: number): string {
  return join(getRegistryDir(), `${pid}.log`);
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(): void {
  const registryDir = getRegistryDir();
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true });
  }
}

/**
 * Check if a process with the given PID is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * True when the registry entry still points at the same live daemon. A bare PID
 * check treats a recycled PID (some unrelated process now holding the dead
 * daemon's PID) as alive, mis-routing approval/resume links to it and leaving
 * its log file un-swept. When both the stored and current start-time tokens are
 * available, require them to match; otherwise fall back to the PID-only check.
 */
function isServerEntryAlive(entry: ServerEntry): boolean {
  if (!isProcessRunning(entry.pid)) return false;
  if (!entry.procStartedAt) return true;
  const current = getProcessStartTime(entry.pid);
  if (!current) return true;
  return current === entry.procStartedAt;
}

/**
 * Get the file path for a server entry.
 */
function getEntryPath(pid: number): string {
  return join(getRegistryDir(), `${pid}.json`);
}

/**
 * Register a running server.
 */
export function registerServer(entry: Omit<ServerEntry, "pid">): void {
  ensureRegistryDir();
  const procStartedAt = getCurrentProcessStartTime();
  const fullEntry: ServerEntry = {
    ...entry,
    pid: process.pid,
    ...(procStartedAt ? { procStartedAt } : {}),
  };
  // Readers run in other processes (`serve ps`, the single-daemon guard), so
  // the entry is replaced whole: a reader must never see it half-written.
  atomicWriteFileSync(getEntryPath(process.pid), JSON.stringify(fullEntry, null, 2));
}

/**
 * Update an existing server entry (e.g., when agent count changes due to hot reload).
 */
export function updateServer(updates: Partial<Omit<ServerEntry, "pid" | "startTime">>): void {
  const entryPath = getEntryPath(process.pid);
  if (!existsSync(entryPath)) {
    return;
  }

  try {
    const existing = JSON.parse(readFileSync(entryPath, "utf-8")) as ServerEntry;
    const updated: ServerEntry = { ...existing, ...updates };
    atomicWriteFileSync(entryPath, JSON.stringify(updated, null, 2));
  } catch {
    // Ignore errors - registry is best-effort
  }
}

/**
 * Unregister the current server.
 */
export function unregisterServer(): void {
  const entryPath = getEntryPath(process.pid);
  if (existsSync(entryPath)) {
    try {
      rmSync(entryPath);
    } catch {
      // Ignore errors - file might already be gone
    }
  }
}

/**
 * List all running serve daemons, cleaning up stale entries.
 */
export function listServers(): ServerEntry[] {
  ensureRegistryDir();
  const registryDir = getRegistryDir();

  const entries: ServerEntry[] = [];
  const files = readdirSync(registryDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(registryDir, file);
    try {
      const entry = JSON.parse(readFileSync(filePath, "utf-8")) as ServerEntry;

      if (isServerEntryAlive(entry)) {
        entries.push(entry);
      } else {
        // Clean up stale entry (and its log file, if any)
        try {
          rmSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
        const logPath = entry.logFile ?? getDefaultLogFilePath(entry.pid);
        if (existsSync(logPath)) {
          try {
            rmSync(logPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } catch {
      // Unreadable entry. Remove it only once the daemon named by the file is
      // gone: a live daemon's entry can be mid-rewrite (versions before atomic
      // replacement truncate it in place), and deleting it would hide that
      // daemon for good, since updateServer never re-creates a missing entry.
      const filePid = Number(file.slice(0, -".json".length));
      if (Number.isInteger(filePid) && filePid > 0 && isProcessRunning(filePid)) continue;
      try {
        rmSync(filePath);
      } catch {
        // Ignore
      }
    }
  }

  // Sort by start time (oldest first)
  return entries.sort((a, b) => a.startTime - b.startTime);
}

export function findServerForProject(projectRoot?: string): ServerEntry | undefined {
  const servers = listServers();
  if (!projectRoot) return servers[0];
  const normalizedProjectRoot = resolve(projectRoot);
  const serverRoots = (server: ServerEntry): string[] => [
    ...(server.projects?.map((project) => project.root) ?? []),
    server.projectRoot
  ].map((root) => resolve(root));

  const exact = servers.find((server) => {
    return serverRoots(server).some((root) => root === normalizedProjectRoot);
  });
  if (exact) return exact;

  const related = servers
    .map((server) => {
      const roots = serverRoots(server);
      const matchingRoots = roots.filter((root) => isPathInside(root, normalizedProjectRoot) || isPathInside(normalizedProjectRoot, root));
      const bestRootLength = matchingRoots.reduce((max, root) => Math.max(max, root.length), 0);
      return { server, bestRootLength };
    })
    .filter((entry) => entry.bestRootLength > 0)
    .sort((a, b) => b.bestRootLength - a.bestRootLength);
  if (related.length > 0) return related[0].server;

  return undefined;
}

/**
 * Format uptime from milliseconds to human-readable string.
 */
export function formatUptime(startTime: number): string {
  const ms = Date.now() - startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/** A host as it goes in a URL: IPv6 literals need brackets (`[::1]`). */
export function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Base URL a local client uses to reach a registered daemon; a wildcard bind is reached on loopback. */
export function serverBaseUrl(server: Pick<ServerEntry, "host" | "port">): string {
  const host = server.host === "0.0.0.0" || server.host === "::" ? "127.0.0.1" : server.host;
  return `http://${hostForUrl(host)}:${server.port}`;
}

/**
 * Headers for a CLI request to a registered daemon. Carries AGENTUSE_API_KEY
 * as a bearer token when one is configured, so a keyed daemon accepts it.
 */
export function daemonRequestHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const apiKey = readApiKey();
  return {
    Accept: "application/json",
    ...headers,
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
  };
}

/** The error for a non-OK daemon response: the daemon's own message, plus an auth hint on 401. */
export async function daemonResponseError(response: Response, label: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? "";
  } catch {
    // Non-JSON error body; fall back to status only.
  }
  const authHint = response.status === 401 ? " (set AGENTUSE_API_KEY to match the daemon)" : "";
  return new Error(`${label} failed: ${response.status}${detail ? ` ${detail}` : ""}${authHint}`);
}
