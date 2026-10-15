import { readCloudConnection, type CloudConnection } from './config.js';

/**
 * `agentuse serve`'s line to AgentUse Cloud. The computer dials out, so it
 * needs no open port. Each frame the cloud sends is one MCP request, which is
 * answered by this daemon's own `/mcp` (the same handler and checks a local
 * client gets); nothing else can travel down this line.
 */

export type TunnelStatus = 'not connected' | 'connecting' | 'connected' | 'retrying' | 'disconnected from the cloud';

export interface TunnelState {
  status: TunnelStatus;
  since: string;
  lastError?: string;
}

export interface CloudTunnelOptions {
  /** This daemon's base URL, e.g. http://127.0.0.1:12233 */
  selfUrl: string;
  apiKey?: string | undefined;
  log: (message: string) => void;
  /** How often to look for a new `agentuse connect` while not connected. */
  configPollMs?: number;
}

const PING_MS = 25_000;
const PONG_DEADLINE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const LOCAL_MCP_TIMEOUT_MS = 55_000;

/** The running daemon's tunnel, for the `/api/cloud` status route. */
export const activeTunnel: { current?: CloudTunnel } = {};

export class CloudTunnel {
  private socket: WebSocket | undefined;
  private stopped = false;
  private backoff = 1_000;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastPong = 0;
  private revokedToken: string | undefined;
  state: TunnelState = { status: 'not connected', since: new Date().toISOString() };

  constructor(private readonly options: CloudTunnelOptions) {}

  start(): void {
    this.stopped = false;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.socket?.close(1000, 'serve stopping');
    this.socket = undefined;
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private setState(status: TunnelStatus, lastError?: string): void {
    if (this.state.status === status && this.state.lastError === lastError) return;
    this.state = { status, since: new Date().toISOString(), ...(lastError && { lastError }) };
  }

  /** Read the connection file and connect, or check again later. */
  private tick(): void {
    if (this.stopped) return;
    let connection: CloudConnection | undefined;
    try {
      connection = readCloudConnection();
    } catch (error) {
      this.setState('not connected', (error as Error).message);
    }
    // A token the cloud refused stays refused; wait for a new `agentuse connect`.
    if (!connection || connection.machineToken === this.revokedToken) {
      if (!connection) this.setState('not connected');
      this.later(this.options.configPollMs ?? 30_000, () => this.tick());
      return;
    }
    void this.open(connection);
  }

  private async open(connection: CloudConnection): Promise<void> {
    this.setState(this.state.status === 'connected' ? 'retrying' : 'connecting');
    const wsUrl = `${connection.url.replace(/^http/u, 'ws')}/connect/ws`;
    let socket: WebSocket;
    try {
      // Node's WebSocket (undici) accepts request headers here; the browser API does not.
      socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${connection.machineToken}` } } as unknown as string[]);
    } catch (error) {
      this.retry(connection, (error as Error).message);
      return;
    }
    this.socket = socket;
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      this.backoff = 1_000;
      this.lastPong = Date.now();
      this.setState('connected');
      this.options.log(`Connected to AgentUse Cloud as ${connection.name}`);
      this.heartbeat(socket);
    });

    socket.addEventListener('message', (event) => {
      void this.onFrame(socket, String(event.data));
    });

    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      if (event.code === 4001) {
        this.revokedToken = connection.machineToken;
        this.setState('disconnected from the cloud', 'This computer was disconnected from your account. Run `agentuse connect` to connect it again.');
        this.options.log('AgentUse Cloud disconnected this computer');
        this.tick();
        return;
      }
      if (!opened) {
        void this.checkRefused(connection);
        return;
      }
      this.retry(connection, `closed (${event.code})`);
    });
  }

  /** A socket that never opened is a network problem or a refused token; ask which. */
  private async checkRefused(connection: CloudConnection): Promise<void> {
    try {
      const response = await fetch(`${connection.url}/api/connect/me`, {
        headers: { Authorization: `Bearer ${connection.machineToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        this.revokedToken = connection.machineToken;
        this.setState('disconnected from the cloud', 'AgentUse Cloud no longer accepts this computer. Run `agentuse disconnect`, then `agentuse connect`.');
        this.tick();
        return;
      }
    } catch {
      // Unreachable: a plain retry below.
    }
    this.retry(connection, 'could not reach AgentUse Cloud');
  }

  private retry(connection: CloudConnection, reason: string): void {
    this.setState('retrying', reason);
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.later(wait + Math.floor(Math.random() * 500), () => {
      // The file may have changed (disconnect or a new connect) while waiting.
      const current = (() => { try { return readCloudConnection(); } catch { return undefined; } })();
      if (current?.machineToken === connection.machineToken) void this.open(connection);
      else this.tick();
    });
  }

  private heartbeat(socket: WebSocket): void {
    this.later(PING_MS, () => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > PONG_DEADLINE_MS) {
        socket.close(4000, 'No answer from AgentUse Cloud');
        return;
      }
      socket.send(JSON.stringify({ type: 'ping' }));
      this.heartbeat(socket);
    });
  }

  private async onFrame(socket: WebSocket, text: string): Promise<void> {
    let frame: { type?: string; id?: string; body?: string };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === 'pong') {
      this.lastPong = Date.now();
      return;
    }
    if (frame.type !== 'mcp' || !frame.id || typeof frame.body !== 'string') return;
    const reply = (status: number, contentType: string, body: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'mcp_result', id: frame.id, status, contentType, body }));
      }
    };
    try {
      const response = await fetch(`${this.options.selfUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.options.apiKey && { Authorization: `Bearer ${this.options.apiKey}` }),
        },
        body: frame.body,
        signal: AbortSignal.timeout(LOCAL_MCP_TIMEOUT_MS),
      });
      reply(response.status, response.headers.get('content-type') ?? 'application/json', await response.text());
    } catch (error) {
      reply(502, 'application/json', JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: `AgentUse on this computer did not answer: ${(error as Error).message}` },
      }));
    }
  }
}
