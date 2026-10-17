import { type CloudConnection } from './config.js';

/**
 * The computer's half of connecting to AgentUse Cloud: ask for a code, let the
 * person approve it in a browser, and poll until the cloud hands over this
 * computer's token (RFC 8628 in shape).
 */

export interface PairingStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

const REQUEST_TIMEOUT_MS = 15_000;

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({})) as T;
  return { ok: response.ok, status: response.status, data };
}

export async function startPairing(baseUrl: string, name: string, platform: string): Promise<PairingStart> {
  const { ok, status, data } = await postJson<PairingStart>(`${baseUrl}/api/connect/start`, { name, platform });
  if (!ok) throw new Error(`AgentUse Cloud refused to start connecting (${status})`);
  return data;
}

export async function waitForApproval(
  baseUrl: string,
  start: PairingStart,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Omit<CloudConnection, 'url' | 'connectedAt'>> {
  let interval = start.interval * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const { ok, data } = await postJson<{
      error?: string;
      machine_id?: string;
      machine_token?: string;
      name?: string;
      account?: string;
      mcp_url?: string;
    }>(`${baseUrl}/api/connect/poll`, { device_code: start.device_code });
    if (ok && data.machine_id && data.machine_token && data.mcp_url) {
      return {
        machineId: data.machine_id,
        machineToken: data.machine_token,
        name: data.name ?? 'Computer',
        ...(data.account && { account: data.account }),
        mcpUrl: data.mcp_url,
      };
    }
    switch (data.error) {
      case 'authorization_pending': continue;
      case 'slow_down': interval += 2_000; continue;
      case 'access_denied': throw new Error('Connecting was cancelled in the browser.');
      case 'expired_token': throw new Error('The code expired. Run `agentuse connect` again.');
      default: throw new Error(`AgentUse Cloud stopped the connection (${data.error ?? 'unknown error'}).`);
    }
  }
  throw new Error('The code expired. Run `agentuse connect` again.');
}

/**
 * True when the cloud refuses this computer's token, e.g. after Disconnect on
 * the account page. A network failure counts as still connected, so a flaky
 * line never throws away a working connection.
 */
export async function connectionRevoked(connection: CloudConnection): Promise<boolean> {
  try {
    const response = await fetch(`${connection.url}/api/connect/me`, {
      headers: { Authorization: `Bearer ${connection.machineToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 401;
  } catch {
    return false;
  }
}

/** Tell the cloud to forget this computer's token. */
export async function revokeThisComputer(connection: CloudConnection): Promise<void> {
  const { ok, status } = await postJson(`${connection.url}/api/connect/disconnect`, {}, {
    Authorization: `Bearer ${connection.machineToken}`,
  });
  // 401: already revoked from the account page, which is the outcome we want.
  if (!ok && status !== 401) throw new Error(`AgentUse Cloud did not confirm the disconnect (${status})`);
}
