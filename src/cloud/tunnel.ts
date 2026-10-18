import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { cloudConfigPath, readCloudConnection, type CloudConnection } from './config.js';
import { isRelayablePath, RELAY_SECRET_HEADER, relaySecret } from './relay.js';

/**
 * `agentuse serve`'s line to AgentUse Cloud. The computer dials out, so it
 * needs no open port. Two kinds of request travel down it, both answered by
 * this daemon's own handlers with the same checks a local client gets:
 *
 *   cloud → computer  { type: 'mcp', id, body }    one MCP request, answered by `/mcp`
 *   computer → cloud  { type: 'mcp_result', id, status, contentType, body }
 *
 *   cloud → computer  { type: 'http', id, method, path, headers, body? }
 *                     one dashboard request, replayed only under `/api/*`;
 *                     anything else answers 404
 *   computer → cloud  { type: 'http_start', id, status, headers }
 *                     { type: 'http_chunk', id, data }   base64, in order
 *                     { type: 'http_end', id, error? }
 *   cloud → computer  { type: 'http_cancel', id }       the browser went away
 *
 *   computer → cloud  { type: 'hello', version, apiVersion, features } on open
 *   cloud → computer  { type: 'hello_ack', features }   what this Cloud handles
 *   computer → cloud  { type: 'notify', category, title, body, url, tag?, appBadge? }
 *   cloud → computer  { type: 'update' }               install an update when idle
 */

/**
 * Bumped when the dashboard needs a daemon route or frame older daemons lack.
 * Cloud gates on it. 2: the session, approval and revision routes answer
 * under `/api`, which is all the tunnel relays.
 */
export const TUNNEL_API_VERSION = 2;
/** What this daemon understands, sent in `hello`. */
export const TUNNEL_FEATURES = ['http', 'notify', 'update'] as const;

export interface CloudNotification {
  category: 'approvals' | 'sessions';
  title: string;
  body: string;
  /** Dashboard path with its query, e.g. `/sessions/abc?project=p`. Cloud adds its origin and the machine. */
  url: string;
  tag?: string;
  appBadge?: number;
}

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
  /** Watch the connection file so a new connect or disconnect applies at once. Default true. */
  watchConfig?: boolean;
  /** This daemon's version, sent in `hello`. */
  version?: string;
  /** Cloud asked this computer to update. */
  onUpdate?: () => void;
}

const PING_MS = 25_000;
const PONG_DEADLINE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const LOCAL_MCP_TIMEOUT_MS = 55_000;
/** How long a replayed dashboard request may take to start answering. Streams then run until either side ends them. */
const LOCAL_HTTP_HEADERS_TIMEOUT_MS = 55_000;
/** Raw bytes per `http_chunk`; base64 makes the frame about a third larger. */
const HTTP_CHUNK_BYTES = 192 * 1024;
const MAX_HTTP_REQUEST_BYTES = 8 * 1024 * 1024;

/** Request headers a dashboard request may carry to this daemon. Cloud sets the X-AgentUse ones. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'accept-language', 'last-event-id', 'x-agentuse-user', 'x-agentuse-role'];
/** Response headers that mean something to the browser. Length and encoding change on the way, so they stay behind. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'content-security-policy', 'content-disposition',
  'etag', 'last-modified', 'location', 'x-content-type-options', 'retry-after',
];

interface HttpFrame {
  type: 'http';
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** base64 */
  body?: string;
}

/** The running daemon's tunnel, for the `/api/cloud` status route. */
export const activeTunnel: { current?: CloudTunnel } = {};

export class CloudTunnel {
  private socket: WebSocket | undefined;
  private stopped = false;
  private backoff = 1_000;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastPong = 0;
  private revokedToken: string | undefined;
  /** The token of the socket being opened or open now. */
  private activeToken: string | undefined;
  /** Sockets closed on purpose for a newer connection; their close is not a failure. */
  private retired = new WeakSet<WebSocket>();
  private watcher: FSWatcher | undefined;
  private recheckTimer: ReturnType<typeof setTimeout> | undefined;
  /** Dashboard requests in flight, by frame id, so `http_cancel` can stop them. */
  private httpRequests = new Map<string, AbortController>();
  /** What the Cloud on the other end said it handles; empty until its `hello_ack`. */
  private cloudFeatures = new Set<string>();
  /** The connection the open socket belongs to. */
  private connection: CloudConnection | undefined;
  state: TunnelState = { status: 'not connected', since: new Date().toISOString() };

  constructor(private readonly options: CloudTunnelOptions) {}

  start(): void {
    this.stopped = false;
    if (this.options.watchConfig !== false) this.watchConfig();
    this.tick();
  }

  /**
   * The connection file changed: use the new one now instead of at the next
   * poll, so the Mac app and the setup page turn green within a second.
   */
  recheck(): void {
    if (this.stopped) return;
    let token: string | undefined;
    try {
      token = readCloudConnection()?.machineToken;
    } catch {
      token = undefined;
    }
    if (token === this.activeToken) return;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.socket) {
      this.retired.add(this.socket);
      this.socket.close(1000, 'connection changed');
      this.socket = undefined;
    }
    this.activeToken = undefined;
    this.backoff = 1_000;
    this.tick();
  }

  private watchConfig(): void {
    const file = cloudConfigPath();
    try {
      // Watch the folder: the file is replaced by rename, which a file watch loses.
      this.watcher = watch(path.dirname(file), (_event, name) => {
        if (name && name !== path.basename(file)) return;
        if (this.recheckTimer) clearTimeout(this.recheckTimer);
        this.recheckTimer = setTimeout(() => this.recheck(), 200);
        this.recheckTimer.unref?.();
      });
      this.watcher.unref?.();
    } catch {
      // No folder yet, or no watching here: the poll still finds a new connect.
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.abortHttpRequests();
    this.socket?.close(1000, 'serve stopping');
    this.socket = undefined;
  }

  private abortHttpRequests(): void {
    for (const controller of this.httpRequests.values()) controller.abort();
    this.httpRequests.clear();
  }

  /** This computer's id on AgentUse Cloud while its line is open. */
  get machineId(): string | undefined {
    return this.state.status === 'connected' ? this.connection?.machineId : undefined;
  }

  /** The Cloud origin while connected, e.g. https://cloud.agentuse.io */
  get cloudUrl(): string | undefined {
    return this.state.status === 'connected' ? this.connection?.url.replace(/\/+$/u, '') : undefined;
  }

  /** True when the connected Cloud delivers notifications for this computer. */
  get deliversNotifications(): boolean {
    return this.state.status === 'connected' && this.cloudFeatures.has('notify');
  }

  /**
   * Hand a notification to Cloud, which sends it to the account's devices.
   * False when Cloud cannot take it (not connected, or a Cloud too old to
   * know `notify`), so the caller falls back to this daemon's own Web Push.
   */
  notify(notification: CloudNotification): boolean {
    const socket = this.socket;
    if (!this.deliversNotifications || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'notify', ...notification }));
    return true;
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
      this.activeToken = connection?.machineToken;
      if (!connection) this.setState('not connected');
      this.later(this.options.configPollMs ?? 30_000, () => this.tick());
      return;
    }
    void this.open(connection);
  }

  private async open(connection: CloudConnection): Promise<void> {
    this.activeToken = connection.machineToken;
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
    this.connection = connection;
    this.cloudFeatures = new Set();
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      this.backoff = 1_000;
      this.lastPong = Date.now();
      this.setState('connected');
      this.options.log(`Connected to AgentUse Cloud as ${connection.name}`);
      socket.send(JSON.stringify({
        type: 'hello',
        version: this.options.version ?? 'unknown',
        apiVersion: TUNNEL_API_VERSION,
        features: TUNNEL_FEATURES,
      }));
      this.heartbeat(socket);
    });

    socket.addEventListener('message', (event) => {
      void this.onFrame(socket, String(event.data));
    });

    socket.addEventListener('close', (event) => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.cloudFeatures = new Set();
        this.abortHttpRequests();
      }
      if (this.stopped || this.retired.has(socket)) return;
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
      // A newer connection took over while asking.
      if (connection.machineToken !== this.activeToken) return;
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
    let frame: { type?: string; id?: string; body?: string; features?: unknown };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === 'pong') {
      this.lastPong = Date.now();
      return;
    }
    if (frame.type === 'hello_ack') {
      if (this.socket === socket && Array.isArray(frame.features)) {
        this.cloudFeatures = new Set(frame.features.filter((feature): feature is string => typeof feature === 'string'));
      }
      return;
    }
    if (frame.type === 'update') {
      this.options.onUpdate?.();
      return;
    }
    if (frame.type === 'http_cancel' && frame.id) {
      this.httpRequests.get(frame.id)?.abort();
      this.httpRequests.delete(frame.id);
      return;
    }
    if (frame.type === 'http' && frame.id) {
      await this.onHttpFrame(socket, frame as HttpFrame);
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

  /**
   * Replay one dashboard request against this daemon and stream the answer
   * back. Only `/api/*` goes through; the request
   * carries the operator key (as `/mcp` frames do) and this process's relay
   * secret, which is what lets serve believe the X-AgentUse-User and
   * X-AgentUse-Role headers Cloud put on it.
   */
  private async onHttpFrame(socket: WebSocket, frame: HttpFrame): Promise<void> {
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...message, id: frame.id }));
    };
    const answer = (status: number, code: string, message: string) => {
      send({ type: 'http_start', status, headers: { 'content-type': 'application/json' } });
      send({ type: 'http_chunk', data: Buffer.from(JSON.stringify({ success: false, error: { code, message } })).toString('base64') });
      send({ type: 'http_end' });
    };
    const method = typeof frame.method === 'string' ? frame.method.toUpperCase() : '';
    let target: URL;
    try {
      target = new URL(frame.path, this.options.selfUrl);
    } catch {
      answer(400, 'BAD_PATH', 'This request has no valid path.');
      return;
    }
    if (target.origin !== new URL(this.options.selfUrl).origin || !isRelayablePath(target.pathname)) {
      answer(404, 'NOT_FOUND', 'AgentUse Cloud can only reach this computer\'s data routes.');
      return;
    }
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      answer(405, 'METHOD_NOT_ALLOWED', `${method || 'This method'} is not relayed.`);
      return;
    }
    const body = typeof frame.body === 'string' && frame.body ? Buffer.from(frame.body, 'base64') : undefined;
    if (body && body.length > MAX_HTTP_REQUEST_BYTES) {
      answer(413, 'TOO_LARGE', 'This request is too large to relay.');
      return;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(frame.headers ?? {})) {
      if (typeof value === 'string' && FORWARD_REQUEST_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    headers[RELAY_SECRET_HEADER] = relaySecret();

    const controller = new AbortController();
    this.httpRequests.set(frame.id, controller);
    const headersTimer = setTimeout(() => controller.abort(new Error('timed out')), LOCAL_HTTP_HEADERS_TIMEOUT_MS);
    headersTimer.unref?.();
    let started = false;
    try {
      const response = await fetch(target, {
        method,
        headers,
        ...(body && method !== 'GET' && method !== 'HEAD' && { body: new Uint8Array(body) }),
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(headersTimer);
      const responseHeaders: Record<string, string> = {};
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      send({ type: 'http_start', status: response.status, headers: responseHeaders });
      started = true;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += HTTP_CHUNK_BYTES) {
            send({ type: 'http_chunk', data: Buffer.from(value.subarray(offset, offset + HTTP_CHUNK_BYTES)).toString('base64') });
          }
        }
      }
      send({ type: 'http_end' });
    } catch (error) {
      clearTimeout(headersTimer);
      if (controller.signal.aborted && this.httpRequests.get(frame.id) !== controller) return; // cancelled by Cloud
      if (started) send({ type: 'http_end', error: (error as Error).message });
      else answer(502, 'LOCAL_UNAVAILABLE', `AgentUse on this computer did not answer: ${(error as Error).message}`);
    } finally {
      if (this.httpRequests.get(frame.id) === controller) this.httpRequests.delete(frame.id);
    }
  }
}
