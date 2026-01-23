/**
 * Server Registry
 *
 * Tracks running `agentuse serve` instances using PID files.
 * Each server writes a JSON file to {XDG_DATA_HOME}/agentuse/servers/<pid>.json on startup,
 * which is removed on graceful shutdown. Stale entries (where PID no longer exists)
 * are cleaned up automatically.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { getXdgDataDir } from "../storage/paths";

export interface ServerEntry {
  pid: number;
  port: number;
  host: string;
  projectRoot: string;
  startTime: number;
  agentCount: number;
  scheduleCount: number;
  version: string;
}

const REGISTRY_DIR = join(getXdgDataDir(), "agentuse", "servers");

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
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
  } catch {
    return false;
  }
}

/**
 * Get the file path for a server entry.
 */
function getEntryPath(pid: number): string {
  return join(REGISTRY_DIR, `${pid}.json`);
}

/**
 * Register a running server.
 */
export function registerServer(entry: Omit<ServerEntry, "pid">): void {
  ensureRegistryDir();
  const fullEntry: ServerEntry = {
    ...entry,
    pid: process.pid,
  };
  writeFileSync(getEntryPath(process.pid), JSON.stringify(fullEntry, null, 2));
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
    writeFileSync(entryPath, JSON.stringify(updated, null, 2));
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
 * List all running servers, cleaning up stale entries.
 */
export function listServers(): ServerEntry[] {
  ensureRegistryDir();

  const entries: ServerEntry[] = [];
  const files = readdirSync(REGISTRY_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(REGISTRY_DIR, file);
    try {
      const entry = JSON.parse(readFileSync(filePath, "utf-8")) as ServerEntry;

      if (isProcessRunning(entry.pid)) {
        entries.push(entry);
      } else {
        // Clean up stale entry
        try {
          rmSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Invalid JSON or read error - try to clean up
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
