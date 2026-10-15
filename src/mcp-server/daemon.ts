import { daemonRequestHeaders, findServerForProject, serverBaseUrl } from '../utils/server-registry.js';

/** A failure the chat should repeat to the user, with a stable code it can branch on. */
export class McpToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/**
 * How the MCP tools reach a running `agentuse serve`. Every tool goes through
 * the daemon's own HTTP API, so the stdio server, a local `/mcp` route and the
 * relay tunnel all see exactly what the dashboard sees, with the same checks.
 */
export interface DaemonClient {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** The client for the daemon registered on this machine, for `agentuse mcp serve`. */
export function localDaemonClient(): DaemonClient {
  return httpDaemonClient(() => {
    const server = findServerForProject();
    if (!server) {
      throw new McpToolError('NO_SERVER', 'AgentUse is not running on this computer. Start it with `agentuse serve` or open the AgentUse app.');
    }
    return serverBaseUrl(server);
  }, daemonRequestHeaders);
}

/** A client for the daemon at `baseUrl()`, sending `headers()` on every request. */
export function httpDaemonClient(
  baseUrl: () => string,
  headers: (extra: Record<string, string>) => Record<string, string>,
): DaemonClient {
  const request = async <T>(method: 'GET' | 'POST', path: string, init: { query?: Record<string, string | undefined>; body?: unknown }): Promise<T> => {
    const url = new URL(`${baseUrl()}/api${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: headers(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new McpToolError('TIMEOUT', 'AgentUse did not answer in time. Try again in a moment.');
      }
      throw new McpToolError('NO_SERVER', 'AgentUse is not reachable on this computer. Check that `agentuse serve` is running.');
    }
    const payload = await response.json().catch(() => undefined) as
      | { success?: boolean; error?: { code?: string; message?: string } }
      | undefined;
    if (!response.ok || payload?.success === false) {
      const code = payload?.error?.code ?? (response.status === 401 ? 'UNAUTHORIZED' : `HTTP_${response.status}`);
      const message = payload?.error?.message
        ?? (response.status === 401 ? 'AgentUse refused the request. Set AGENTUSE_API_KEY to match the running server.' : `AgentUse answered ${response.status}.`);
      throw new McpToolError(code, message);
    }
    if (payload === undefined) throw new McpToolError('BAD_RESPONSE', 'AgentUse sent an answer that is not JSON.');
    return payload as T;
  };

  return {
    get: (path, query) => request('GET', path, query ? { query } : {}),
    post: (path, body) => request('POST', path, { body }),
  };
}
