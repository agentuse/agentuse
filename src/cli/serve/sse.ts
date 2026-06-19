import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../utils/logger";
import type { ApprovalLogEntry, ApprovalPageInfo } from "./types";

/** A single computed view of a session: the same shape `/sessions/:id/status?logs=1` returns. */
export interface SessionSnapshot {
  status: string;
  approval: Omit<ApprovalPageInfo, 'logs'>;
  logs: ApprovalLogEntry[];
}

/**
 * Produces the current snapshot for one session. serve.ts injects a closure
 * that reuses the exact `/status?logs=1` logic (findSessionInfo + status
 * computation + logsWithChildSessions), so the SSE stream and the polling
 * fallback are byte-for-byte equivalent.
 */
export type SessionPoll = () => Promise<
  | { ok: true; snapshot: SessionSnapshot }
  | { ok: false; error: { code: string; message: string } }
>;

export interface SessionStatusEvent {
  sessionId: string;
  status: string;
  approval: Omit<ApprovalPageInfo, 'logs'>;
}

export type ApprovalListPoll<TSnapshot> = () => Promise<
  | { ok: true; snapshot: TSnapshot }
  | { ok: false; error: { code: string; message: string } }
>;

interface SessionLoop {
  key: string;
  sessionId: string;
  poll: SessionPoll;
  subscribers: Set<ServerResponse>;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  stopped: boolean;
  lastStatusJson: string | null;
  logSignatures: Map<string, string>;
  /** When the loop was created; bounds the not-found fast-retry window. */
  createdAt: number;
  /** True once any poll has produced a snapshot for this session. */
  everOk: boolean;
}

interface ApprovalListLoop<TSnapshot> {
  key: string;
  eventName: string;
  poll: ApprovalListPoll<TSnapshot>;
  subscribers: Set<ServerResponse>;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  stopped: boolean;
  lastSnapshotJson: string | null;
}

export interface ApprovalEventHubOptions {
  liveIntervalMs?: number;
  idleIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxSubscribersPerSession?: number;
}

export interface ApprovalListEventHubOptions {
  eventName?: string;
  intervalMs?: number;
  heartbeatIntervalMs?: number;
  maxSubscribersPerList?: number;
}

export const SESSION_SSE_LIVE_INTERVAL_MS = 500;
export const SESSION_SSE_IDLE_INTERVAL_MS = 10_000;
/**
 * A detached run pre-assigns its session id and returns it before the worker has
 * written the session to disk, so the first polls for it come back not-found.
 * Until a session has ever resolved, retry at the live cadence (rather than the
 * 10s idle one) for this bounded window so a just-started run shows up within
 * ~1s instead of stalling on "Loading session…".
 */
export const SESSION_SSE_PENDING_FAST_WINDOW_MS = 30_000;

function logSignature(entry: ApprovalLogEntry): string {
  return JSON.stringify([entry.status ?? null, entry.level ?? null, entry.message ?? null, entry.title, entry.details ?? null, entry.subagentSession ?? null]);
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);
}

/**
 * Pushes session/approval state to SSE subscribers.
 *
 * The worker IPC is request/response only, so the hub polls the injected
 * snapshot closure on a timer and diffs snapshots: one poll loop per session
 * regardless of how many tabs are subscribed, and subscribers only receive
 * deltas (status changes and new/changed log entries). The cadence mirrors the
 * in-page polling: fast while the session is actively resuming or running,
 * slow while idle.
 */
export class ApprovalEventHub {
  private loops = new Map<string, SessionLoop>();
  private readonly liveIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxSubscribersPerSession: number;

  constructor(options: ApprovalEventHubOptions = {}) {
    this.liveIntervalMs = options.liveIntervalMs ?? SESSION_SSE_LIVE_INTERVAL_MS;
    this.idleIntervalMs = options.idleIntervalMs ?? SESSION_SSE_IDLE_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.maxSubscribersPerSession = options.maxSubscribersPerSession ?? 20;
  }

  /**
   * Attaches an SSE subscriber. The caller must have already authorized the
   * session (sessionAuthorized); the hub trusts its inputs.
   * Returns false when the per-session subscriber cap is reached.
   */
  subscribe(options: {
    key: string;
    sessionId: string;
    poll: SessionPoll;
    req: IncomingMessage;
    res: ServerResponse;
  }): boolean {
    const { key } = options;
    let loop = this.loops.get(key);
    if (loop && loop.subscribers.size >= this.maxSubscribersPerSession) {
      return false;
    }
    if (!loop) {
      loop = {
        key,
        sessionId: options.sessionId,
        poll: options.poll,
        subscribers: new Set(),
        timer: null,
        ticking: false,
        stopped: false,
        lastStatusJson: null,
        logSignatures: new Map(),
        createdAt: Date.now(),
        everOk: false,
      };
      this.loops.set(key, loop);
    }

    const { res } = options;
    loop.subscribers.add(res);

    writeSseHeaders(res);

    // Replay current status to the new subscriber, then reset the loop's log
    // signatures so the next tick re-emits every log entry (idempotent for
    // existing clients, which key by entry id). If the loop is currently idle,
    // pull that tick forward; otherwise a new/reloaded tab can show the approval
    // header without its actionable log card until the next 10s idle poll.
    let replayLogsImmediately = false;
    if (loop.lastStatusJson !== null) {
      res.write(`event: status\ndata: ${loop.lastStatusJson}\n\n`);
      loop.logSignatures.clear();
      replayLogsImmediately = true;
    }

    const heartbeat = setInterval(() => {
      if (res.destroyed) return;
      res.write(`: hb\n\n`);
    }, this.heartbeatIntervalMs);

    // Both: Node fires 'close' on the response when the client disconnects,
    // but Bun's node:http shim only fires it on the request.
    const onClose = () => {
      clearInterval(heartbeat);
      this.unsubscribe(key, res);
    };
    res.on("close", onClose);
    options.req.on("close", onClose);

    if (replayLogsImmediately && loop.timer) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }
    if (!loop.timer && !loop.ticking) {
      void this.tick(loop);
    }
    return true;
  }

  private unsubscribe(key: string, res: ServerResponse): void {
    const loop = this.loops.get(key);
    if (!loop) return;
    loop.subscribers.delete(res);
    if (loop.subscribers.size === 0) {
      this.stopLoop(loop);
    }
  }

  private stopLoop(loop: SessionLoop): void {
    loop.stopped = true;
    if (loop.timer) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }
    this.loops.delete(loop.key);
  }

  /** Number of active poll loops (exposed for tests and diagnostics). */
  activeLoopCount(): number {
    return this.loops.size;
  }

  shutdown(): void {
    for (const loop of [...this.loops.values()]) {
      for (const res of loop.subscribers) {
        res.end();
      }
      this.stopLoop(loop);
    }
  }

  private broadcast(loop: SessionLoop, payload: string): void {
    for (const res of [...loop.subscribers]) {
      if (res.destroyed) {
        this.unsubscribe(loop.key, res);
        continue;
      }
      res.write(payload);
    }
  }

  private async tick(loop: SessionLoop): Promise<void> {
    if (loop.stopped || loop.ticking) return;
    loop.ticking = true;
    let interval = this.idleIntervalMs;
    try {
      const result = await loop.poll();
      if (loop.stopped) return;

      if (result.ok) {
        loop.everOk = true;
        const { status, approval, logs } = result.snapshot;

        const statusEvent: SessionStatusEvent = { sessionId: loop.sessionId, status, approval };
        const statusJson = JSON.stringify(statusEvent);
        if (statusJson !== loop.lastStatusJson) {
          loop.lastStatusJson = statusJson;
          this.broadcast(loop, `event: status\ndata: ${statusJson}\n\n`);
        }

        const seen = new Set<string>();
        for (const entry of logs) {
          seen.add(entry.id);
          const signature = logSignature(entry);
          if (loop.logSignatures.get(entry.id) !== signature) {
            loop.logSignatures.set(entry.id, signature);
            this.broadcast(loop, `event: log\ndata: ${JSON.stringify(entry)}\n\n`);
          }
        }
        for (const id of [...loop.logSignatures.keys()]) {
          if (!seen.has(id)) loop.logSignatures.delete(id);
        }

        const live = status === 'resuming' || status === 'continuing' || status === 'running' || status === 'run';
        interval = live ? this.liveIntervalMs : this.idleIntervalMs;
      } else {
        // Transient failures should not kill streams; surface the error and
        // keep polling. A session that has never resolved yet is likely a
        // just-started detached run still being written to disk: poll it at the
        // live cadence (bounded) so it appears promptly instead of after 10s.
        this.broadcast(loop, `event: stream-error\ndata: ${JSON.stringify(result.error)}\n\n`);
        if (!loop.everOk && Date.now() - loop.createdAt < SESSION_SSE_PENDING_FAST_WINDOW_MS) {
          interval = this.liveIntervalMs;
        }
      }
    } catch (err) {
      logger.debug(`Session SSE tick failed for ${loop.key}: ${(err as Error).message}`);
    } finally {
      loop.ticking = false;
      if (!loop.stopped) {
        loop.timer = setTimeout(() => {
          loop.timer = null;
          void this.tick(loop);
        }, interval);
      }
    }
  }
}

/**
 * Streams approval-list snapshots to dashboard subscribers.
 *
 * Like the session hub, this still polls the request/response worker under the
 * hood. The improvement is where the polling happens: one server-side loop per
 * approvals filter, fanned out to all tabs, and clients receive a snapshot as
 * soon as the server observes a change instead of waiting for each tab's own
 * 10s fetch interval.
 */
export class ApprovalListEventHub<TSnapshot> {
  private loops = new Map<string, ApprovalListLoop<TSnapshot>>();
  private readonly eventName: string;
  private readonly intervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxSubscribersPerList: number;

  constructor(options: ApprovalListEventHubOptions = {}) {
    this.eventName = options.eventName ?? 'approvals';
    this.intervalMs = options.intervalMs ?? 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.maxSubscribersPerList = options.maxSubscribersPerList ?? 50;
  }

  subscribe(options: {
    key: string;
    poll: ApprovalListPoll<TSnapshot>;
    req: IncomingMessage;
    res: ServerResponse;
  }): boolean {
    const { key } = options;
    let loop = this.loops.get(key);
    if (loop && loop.subscribers.size >= this.maxSubscribersPerList) {
      return false;
    }
    if (!loop) {
      loop = {
        key,
        eventName: this.eventName,
        poll: options.poll,
        subscribers: new Set(),
        timer: null,
        ticking: false,
        stopped: false,
        lastSnapshotJson: null,
      };
      this.loops.set(key, loop);
    }

    const { res } = options;
    loop.subscribers.add(res);
    writeSseHeaders(res);

    if (loop.lastSnapshotJson !== null) {
      res.write(`event: ${loop.eventName}\ndata: ${loop.lastSnapshotJson}\n\n`);
    }

    const heartbeat = setInterval(() => {
      if (res.destroyed) return;
      res.write(`: hb\n\n`);
    }, this.heartbeatIntervalMs);

    const onClose = () => {
      clearInterval(heartbeat);
      this.unsubscribe(key, res);
    };
    res.on("close", onClose);
    options.req.on("close", onClose);

    if (!loop.timer && !loop.ticking) {
      void this.tick(loop);
    }
    return true;
  }

  private unsubscribe(key: string, res: ServerResponse): void {
    const loop = this.loops.get(key);
    if (!loop) return;
    loop.subscribers.delete(res);
    if (loop.subscribers.size === 0) {
      this.stopLoop(loop);
    }
  }

  private stopLoop(loop: ApprovalListLoop<TSnapshot>): void {
    loop.stopped = true;
    if (loop.timer) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }
    this.loops.delete(loop.key);
  }

  activeLoopCount(): number {
    return this.loops.size;
  }

  shutdown(): void {
    for (const loop of [...this.loops.values()]) {
      for (const res of loop.subscribers) {
        res.end();
      }
      this.stopLoop(loop);
    }
  }

  private broadcast(loop: ApprovalListLoop<TSnapshot>, payload: string): void {
    for (const res of [...loop.subscribers]) {
      if (res.destroyed) {
        this.unsubscribe(loop.key, res);
        continue;
      }
      res.write(payload);
    }
  }

  private async tick(loop: ApprovalListLoop<TSnapshot>): Promise<void> {
    if (loop.stopped || loop.ticking) return;
    loop.ticking = true;
    try {
      const result = await loop.poll();
      if (loop.stopped) return;

      if (result.ok) {
        const snapshotJson = JSON.stringify(result.snapshot);
        if (snapshotJson !== loop.lastSnapshotJson) {
          loop.lastSnapshotJson = snapshotJson;
          this.broadcast(loop, `event: ${loop.eventName}\ndata: ${snapshotJson}\n\n`);
        }
      } else {
        this.broadcast(loop, `event: stream-error\ndata: ${JSON.stringify(result.error)}\n\n`);
      }
    } catch (err) {
      logger.debug(`Approval list SSE tick failed for ${loop.key}: ${(err as Error).message}`);
    } finally {
      loop.ticking = false;
      if (!loop.stopped) {
        loop.timer = setTimeout(() => {
          loop.timer = null;
          void this.tick(loop);
        }, this.intervalMs);
      }
    }
  }
}
