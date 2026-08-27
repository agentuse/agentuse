import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProcessRefAlive } from "../../../src/utils/process-info";

/** Public shape written by `agentuse serve` to its process registry. */
export interface RegisteredServer {
  pid: number;
  port: number;
  host: string;
  projectRoot: string;
  startTime: number;
  version: string;
  publicUrl?: string;
  logFile?: string;
  procStartedAt?: string;
}

export function serverRegistryDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentuse", "servers");
}

export function isLocalServer(server: Pick<RegisteredServer, "host" | "port">): boolean {
  return Number.isInteger(server.port) && server.port > 0 && server.port <= 65_535
    && ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(server.host);
}

export function serverUrl(server: Pick<RegisteredServer, "host" | "port">): string {
  // A daemon may listen on every interface, but the desktop shell must only
  // connect over loopback. This avoids treating a LAN address as trusted.
  const connectHost = server.host === "0.0.0.0" ? "127.0.0.1" : server.host === "::" ? "::1" : server.host;
  const host = connectHost.includes(":") && !connectHost.startsWith("[") ? `[${connectHost}]` : connectHost;
  return `http://${host}:${server.port}`;
}

/**
 * Read the CLI's registry without importing server code into the Electron main
 * bundle. Invalid and stale entries are ignored; the CLI remains its owner.
 */
export function listRegisteredServers(
  dir = serverRegistryDirectory(),
  alive: (server: RegisteredServer) => boolean = isProcessRefAlive,
): RegisteredServer[] {
  if (!existsSync(dir)) return [];
  const entries: RegisteredServer[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), "utf8")) as RegisteredServer;
      if (isLocalServer(entry) && alive(entry)) entries.push(entry);
    } catch {
      // A CLI process can replace its registry entry while we read it.
    }
  }
  return entries.sort((left, right) => left.startTime - right.startTime);
}

export function selectServer(servers: readonly RegisteredServer[]): RegisteredServer | undefined {
  return servers.filter(isLocalServer).sort((left, right) => left.startTime - right.startTime)[0];
}

export function isDashboardNavigation(target: string, dashboardUrl: string): boolean {
  try {
    const candidate = new URL(target);
    const dashboard = new URL(dashboardUrl);
    return candidate.protocol === dashboard.protocol && candidate.host === dashboard.host;
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(target: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(target).protocol);
  } catch {
    return false;
  }
}
