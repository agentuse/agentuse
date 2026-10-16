import { reconnectCandidates, serverUrl, type RegisteredServer, type ServerEndpoint } from "./runtime";

export type ServerProbe = "ready" | "unauthorized" | "unreachable";

export async function probeServer(url: string, apiKey?: string): Promise<ServerProbe> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (response.status === 401) return "unauthorized";
    return response.ok ? "ready" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** One registry pass, so Settings never waits through the startup retry window. */
export async function findReadyExternalServer(
  servers: readonly RegisteredServer[],
  target: ServerEndpoint,
  apiKey?: string,
  probe: typeof probeServer = probeServer,
): Promise<RegisteredServer | undefined> {
  for (const candidate of reconnectCandidates(servers, target)) {
    const result = await probe(serverUrl(candidate), apiKey);
    if (result === "unauthorized") {
      throw new Error("The restarted AgentUse backend requires a different API key. Set AGENTUSE_API_KEY before opening the desktop app, or restart the backend without operator authentication on loopback.");
    }
    if (result === "ready") return candidate;
  }
  return undefined;
}
