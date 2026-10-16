import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { readCloudConnection, removeCloudConnection, writeCloudConnection, type CloudConnection } from '../src/cloud/config';
import { connectionRevoked, redeemJoinCode, waitForApproval, type PairingStart } from '../src/cloud/pairing';
import { CloudTunnel } from '../src/cloud/tunnel';

const savedConfigDir = process.env.AGENTUSE_CONFIG_DIR;
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cloud-connect-'));
  process.env.AGENTUSE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.AGENTUSE_CONFIG_DIR;
  else process.env.AGENTUSE_CONFIG_DIR = savedConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

const connection = (url: string, token = 'auc_test'): CloudConnection => ({
  url,
  machineId: 'm1',
  machineToken: token,
  name: 'Test Mac',
  account: 'you@example.com',
  mcpUrl: `${url}/mcp`,
  connectedAt: new Date().toISOString(),
});

describe('cloud connection file', () => {
  it('round-trips and is readable only by its owner', async () => {
    writeCloudConnection(connection('https://cloud.example'));
    expect(readCloudConnection()?.machineToken).toBe('auc_test');
    expect((await stat(join(configDir, 'cloud.json'))).mode & 0o777).toBe(0o600);
    removeCloudConnection();
    expect(readCloudConnection()).toBeUndefined();
  });
});

describe('waiting for approval', () => {
  const start: PairingStart = {
    device_code: 'dc', user_code: 'BCDF-GHJK', verification_uri: 'u', verification_uri_complete: 'u?c', expires_in: 600, interval: 1,
  };
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const answer = (answers: Array<Record<string, unknown>>) => {
    let call = 0;
    globalThis.fetch = (async () => {
      const body = answers[Math.min(call++, answers.length - 1)]!;
      return new Response(JSON.stringify(body), { status: 'error' in body ? 400 : 200 });
    }) as unknown as typeof fetch;
  };

  it('keeps polling while pending, slows down when told, then returns the token', async () => {
    answer([
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { machine_id: 'm1', machine_token: 'auc_x', name: 'Test Mac', account: 'you@example.com', mcp_url: 'https://c/mcp' },
    ]);
    const waits: number[] = [];
    const approved = await waitForApproval('https://c', start, async (ms) => { waits.push(ms); });
    expect(approved).toEqual({ machineId: 'm1', machineToken: 'auc_x', name: 'Test Mac', account: 'you@example.com', mcpUrl: 'https://c/mcp' });
    expect(waits).toEqual([1000, 1000, 3000]);
  });

  it('stops when the person cancels or the code expires', async () => {
    answer([{ error: 'access_denied' }]);
    await expect(waitForApproval('https://c', start, async () => {})).rejects.toThrow('cancelled');
    answer([{ error: 'expired_token' }]);
    await expect(waitForApproval('https://c', start, async () => {})).rejects.toThrow('expired');
  });
});

describe('join codes', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('links this computer with the code, sending it upper-cased', async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ machine_id: 'm2', machine_token: 'auc_j', name: 'Laptop', account: 'you@example.com', mcp_url: 'https://c/mcp' }));
    }) as unknown as typeof fetch;
    const linked = await redeemJoinCode('https://c', ' bcdf-ghjk-lmnp ', 'Laptop', 'Linux');
    expect(sent).toEqual({ code: 'BCDF-GHJK-LMNP', name: 'Laptop', platform: 'Linux' });
    expect(linked).toEqual({ machineId: 'm2', machineToken: 'auc_j', name: 'Laptop', account: 'you@example.com', mcpUrl: 'https://c/mcp' });
  });

  it('says to get a new code when it was used or expired, and to wait when rate limited', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_code' }), { status: 400 })) as unknown as typeof fetch;
    await expect(redeemJoinCode('https://c', 'X', 'n', 'p')).rejects.toThrow('not valid any more');
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 })) as unknown as typeof fetch;
    await expect(redeemJoinCode('https://c', 'X', 'n', 'p')).rejects.toThrow('Too many tries');
  });

  it('treats a refused token as disconnected, but never a network failure', async () => {
    const connection = { machineId: 'm', machineToken: 'auc_x', name: 'Mac', mcpUrl: 'https://c/mcp', url: 'https://c', connectedAt: '' };
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    expect(await connectionRevoked(connection)).toBe(true);
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect(await connectionRevoked(connection)).toBe(false);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await connectionRevoked(connection)).toBe(false);
  });
});

describe('serve tunnel', () => {
  let cloud: Server;
  let local: Server;
  let cloudSocket: ServerWebSocket<unknown> | undefined;
  let seenAuthorization: string | null = null;
  let tunnel: CloudTunnel | undefined;
  const frames: string[] = [];

  beforeEach(() => {
    frames.length = 0;
    // A stand-in for this daemon's own /mcp.
    local = Bun.serve({
      port: 0,
      fetch: async (request) => new Response(JSON.stringify({ echoed: await request.text(), auth: request.headers.get('authorization') }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    });
    // A stand-in for the relay's /connect/ws.
    cloud = Bun.serve({
      port: 0,
      fetch(request, server) {
        seenAuthorization = request.headers.get('authorization');
        return server.upgrade(request) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(socket) { cloudSocket = socket; },
        message(_socket, message) { frames.push(String(message)); },
      },
    });
  });

  afterEach(() => {
    tunnel?.stop();
    cloud.stop(true);
    local.stop(true);
  });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i += 1) await Bun.sleep(20);
    expect(check()).toBe(true);
  };

  it('dials out with the machine token and answers MCP frames from the local /mcp', async () => {
    writeCloudConnection(connection(`http://127.0.0.1:${cloud.port}`, 'auc_secret'));
    tunnel = new CloudTunnel({ selfUrl: `http://127.0.0.1:${local.port}`, apiKey: 'operator-key', log: () => {} });
    tunnel.start();
    await until(() => tunnel!.state.status === 'connected');
    expect(seenAuthorization).toBe('Bearer auc_secret');

    cloudSocket!.send(JSON.stringify({ type: 'mcp', id: 'r1', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }));
    await until(() => frames.some((frame) => frame.includes('mcp_result')));
    const result = JSON.parse(frames.find((frame) => frame.includes('mcp_result'))!);
    expect(result).toMatchObject({ type: 'mcp_result', id: 'r1', status: 200 });
    expect(JSON.parse(result.body)).toEqual({ echoed: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', auth: 'Bearer operator-key' });
  });

  it('stops retrying when the cloud disconnects this computer', async () => {
    writeCloudConnection(connection(`http://127.0.0.1:${cloud.port}`));
    tunnel = new CloudTunnel({ selfUrl: `http://127.0.0.1:${local.port}`, log: () => {}, configPollMs: 50 });
    tunnel.start();
    await until(() => tunnel!.state.status === 'connected');
    cloudSocket!.close(4001, 'This computer was disconnected');
    await until(() => tunnel!.state.status === 'disconnected from the cloud');
    await Bun.sleep(200);
    expect(tunnel.state.status).toBe('disconnected from the cloud');
  });

  it('stays idle until a connection file appears', async () => {
    tunnel = new CloudTunnel({ selfUrl: `http://127.0.0.1:${local.port}`, log: () => {}, configPollMs: 30 });
    tunnel.start();
    await Bun.sleep(60);
    expect(tunnel.state.status).toBe('not connected');
    writeCloudConnection(connection(`http://127.0.0.1:${cloud.port}`));
    await until(() => tunnel!.state.status === 'connected');
  });
});
