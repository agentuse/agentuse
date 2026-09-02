import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessRefAlive, processRefState, type ProcessRefState } from "../../../src/utils/process-info";
import type { DesktopServerSupervisor } from "../../../src/utils/desktop-supervisor";
import { getAgentuseDataDir } from "../../../src/utils/data-dir";

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
  supervisor?: DesktopServerSupervisor;
}

export function serverRegistryDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentuseDataDir(env), "servers");
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

/**
 * Prefer a restarted daemon on the endpoint Desktop was already using. A
 * supervisor can leave the old registry entry visible while the replacement
 * is starting, so callers still need to probe every returned candidate.
 */
export function reconnectCandidates(
  servers: readonly RegisteredServer[],
  previous: Pick<RegisteredServer, "port">,
): RegisteredServer[] {
  return servers
    .filter(isLocalServer)
    .sort((left, right) => {
      const leftPortRank = left.port === previous.port ? 0 : 1;
      const rightPortRank = right.port === previous.port ? 0 : 1;
      return leftPortRank - rightPortRank || left.startTime - right.startTime;
    });
}

export function serverAcquisitionMode(
  disconnectedExternalServer: unknown,
  allowReplacingExternal = false,
): "reconnect-external" | "start-owned" {
  return disconnectedExternalServer && !allowReplacingExternal ? "reconnect-external" : "start-owned";
}

export function isAbandonedDesktopServer(
  server: RegisteredServer,
  supervisorState: (supervisor: DesktopServerSupervisor) => ProcessRefState = processRefState,
): boolean {
  return server.supervisor?.kind === "desktop" && supervisorState(server.supervisor) === "dead";
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
