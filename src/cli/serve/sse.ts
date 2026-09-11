import type { IncomingMessage, ServerResponse } from "http";
import { logger } from "../../utils/logger";
import { toErrorMessage } from "../../utils/error-message";
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

/** Subscriber fan-out and timer bookkeeping shared by every polling hub. */
interface SseLoop {
  key: string;
  subscribers: Set<ServerResponse>;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  stopped: boolean;
}

interface SessionLoop extends SseLoop {
  sessionId: string;
  poll: SessionPoll;
  lastStatusJson: string | null;
  logSignatures: Map<string, string>;
  /** When the loop was created; bounds the not-found fast-retry window. */
  createdAt: number;
  /** True once any poll has produced a snapshot for this session. */
  everOk: boolean;
  /** Delay before the next tick, chosen by the last poll. */
  nextIntervalMs: number;
}

interface ApprovalListLoop<TSnapshot> extends SseLoop {
  eventName: string;
  poll: ApprovalListPoll<TSnapshot>;
  lastSnapshotJson: string | null;
  /** Poll at the wake cadence until this timestamp (see wake()). */
  fastUntil: number;
  /** Whether the last successful snapshot was "live" per options.isLive. */
  lastLive: boolean;
}

export interface ApprovalEventHubOptions {
  liveIntervalMs?: number;
  idleIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxSubscribersPerSession?: number;
}

export interface ApprovalListEventHubOptions<TSnapshot = unknown> {
  eventName?: string;
  intervalMs?: number;
  /** Poll cadence while isLive(snapshot) is true; defaults to intervalMs. */
  liveIntervalMs?: number;
  /** Marks a snapshot as live (e.g. any session still running) to keep the faster cadence. */
  isLive?: (snapshot: TSnapshot) => boolean;
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

/**
 * List hubs poll on a slow steady cadence, which reads as dead air on the
 * dashboard right when it matters most: a run just started. wake() switches a
 * hub to this fast cadence for a bounded window so a session-file write that
 * lands a moment after the trigger is still picked up within ~1s.
 */
export const LIST_SSE_WAKE_INTERVAL_MS = 1_000;
export const LIST_SSE_WAKE_WINDOW_MS = 10_000;

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
 * Subscriber plumbing shared by the polling hubs below.
 *
 * Both hubs keep one poll loop per key, fan its output out to every attached
 * response, heartbeat idle connections, and tear the loop down when the last
 * subscriber leaves. Only what a tick does, what it replays to a late joiner,
 * and how long it waits before the next one differ, so those are the three
 * abstract members; everything else lives here once.
 */
abstract class PollingSseHub<TLoop extends SseLoop> {
  protected readonly loops = new Map<string, TLoop>();
  protected readonly heartbeatIntervalMs: number;
  private readonly maxSubscribersPerLoop: number;
  /** Prefix for the tick-failure debug line. */
  protected abstract readonly tickLabel: string;

  protected constructor(options: { heartbeatIntervalMs?: number | undefined; maxSubscribers?: number | undefined }) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.maxSubscribersPerLoop = options.maxSubscribers ?? 20;
  }

  /** Runs one poll and broadcasts whatever changed. Must not throw for transient poll failures. */
  protected abstract pollOnce(loop: TLoop): Promise<void>;

  /** Delay before the next tick, read after `pollOnce` settles. */
  protected abstract nextIntervalMs(loop: TLoop): number;

  /**
   * Sends cached state to a subscriber that just attached. Returns true to pull
   * a pending tick forward instead of waiting out the current interval.
   */
  protected abstract replay(loop: TLoop, res: ServerResponse): boolean;

  /**
   * Attaches one subscriber to the loop for `key`, creating the loop via
   * `createLoop` when this is the first subscriber. Returns false when the
   * per-loop subscriber cap is already reached.
   */
  protected attach(
    key: string,
    req: IncomingMessage,
    res: ServerResponse,
    createLoop: () => TLoop,
  ): boolean {
    let loop = this.loops.get(key);
    if (loop && loop.subscribers.size >= this.maxSubscribersPerLoop) {
      return false;
    }
    if (!loop) {
      loop = createLoop();
      this.loops.set(key, loop);
    }

    loop.subscribers.add(res);
    writeSseHeaders(res);
    const replayImmediately = this.replay(loop, res);

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
    req.on("close", onClose);

    if (replayImmediately && loop.timer) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }
    if (!loop.timer && !loop.ticking) {
      void this.tick(loop);
    }
    return true;
  }

  protected unsubscribe(key: string, res: ServerResponse): void {
    const loop = this.loops.get(key);
    if (!loop) return;
    loop.subscribers.delete(res);
    if (loop.subscribers.size === 0) {
      this.stopLoop(loop);
    }
  }

  protected stopLoop(loop: TLoop): void {
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

  protected broadcast(loop: TLoop, payload: string): void {
    for (const res of [...loop.subscribers]) {
      if (res.destroyed) {
        this.unsubscribe(loop.key, res);
        continue;
      }
      res.write(payload);
    }
  }

  protected async tick(loop: TLoop): Promise<void> {
    if (loop.stopped || loop.ticking) return;
    loop.ticking = true;
    try {
      await this.pollOnce(loop);
    } catch (err) {
      logger.debug(`${this.tickLabel} SSE tick failed for ${loop.key}: ${toErrorMessage(err)}`);
    } finally {
      loop.ticking = false;
      if (!loop.stopped) {
        loop.timer = setTimeout(() => {
          loop.timer = null;
          void this.tick(loop);
        }, this.nextIntervalMs(loop));
      }
    }
  }
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
export class ApprovalEventHub extends PollingSseHub<SessionLoop> {
  protected readonly tickLabel = "Session";
  private readonly liveIntervalMs: number;
  private readonly idleIntervalMs: number;

  constructor(options: ApprovalEventHubOptions = {}) {
    super({
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      maxSubscribers: options.maxSubscribersPerSession ?? 20,
    });
    this.liveIntervalMs = options.liveIntervalMs ?? SESSION_SSE_LIVE_INTERVAL_MS;
    this.idleIntervalMs = options.idleIntervalMs ?? SESSION_SSE_IDLE_INTERVAL_MS;
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
    return this.attach(options.key, options.req, options.res, () => ({
      key: options.key,
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
      nextIntervalMs: this.idleIntervalMs,
    }));
  }

  /**
   * Replay current status to the new subscriber, then reset the loop's log
   * signatures so the next tick re-emits every log entry (idempotent for
   * existing clients, which key by entry id). If the loop is currently idle,
   * pull that tick forward; otherwise a new/reloaded tab can show the approval
   * header without its actionable log card until the next 10s idle poll.
   */
  protected replay(loop: SessionLoop, res: ServerResponse): boolean {
    if (loop.lastStatusJson === null) return false;
    res.write(`event: status\ndata: ${loop.lastStatusJson}\n\n`);
    loop.logSignatures.clear();
    return true;
  }

  protected nextIntervalMs(loop: SessionLoop): number {
    return loop.nextIntervalMs;
  }

  protected async pollOnce(loop: SessionLoop): Promise<void> {
    loop.nextIntervalMs = this.idleIntervalMs;
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

      const live = status === 'preparing' || status === 'resuming' || status === 'continuing' || status === 'running' || status === 'run';
      loop.nextIntervalMs = live ? this.liveIntervalMs : this.idleIntervalMs;
    } else {
      // Transient failures should not kill streams; surface the error and
      // keep polling. A session that has never resolved yet is likely a
      // just-started detached run still being written to disk: poll it at the
      // live cadence (bounded) so it appears promptly instead of after 10s.
      this.broadcast(loop, `event: stream-error\ndata: ${JSON.stringify(result.error)}\n\n`);
      if (!loop.everOk && Date.now() - loop.createdAt < SESSION_SSE_PENDING_FAST_WINDOW_MS) {
        loop.nextIntervalMs = this.liveIntervalMs;
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
export class ApprovalListEventHub<TSnapshot> extends PollingSseHub<ApprovalListLoop<TSnapshot>> {
  protected readonly tickLabel = "Approval list";
  private readonly eventName: string;
  private readonly intervalMs: number;
  private readonly liveIntervalMs: number;
  private readonly isLive: ((snapshot: TSnapshot) => boolean) | undefined;

  constructor(options: ApprovalListEventHubOptions<TSnapshot> = {}) {
    super({
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      maxSubscribers: options.maxSubscribersPerList ?? 50,
    });
    this.eventName = options.eventName ?? 'approvals';
    this.intervalMs = options.intervalMs ?? 1000;
    this.liveIntervalMs = options.liveIntervalMs ?? options.intervalMs ?? 1000;
    this.isLive = options.isLive;
  }

  subscribe(options: {
    key: string;
    poll: ApprovalListPoll<TSnapshot>;
    req: IncomingMessage;
    res: ServerResponse;
  }): boolean {
    return this.attach(options.key, options.req, options.res, () => ({
      key: options.key,
      eventName: this.eventName,
      poll: options.poll,
      subscribers: new Set(),
      timer: null,
      ticking: false,
      stopped: false,
      lastSnapshotJson: null,
      fastUntil: 0,
      lastLive: false,
    }));
  }

  protected replay(loop: ApprovalListLoop<TSnapshot>, res: ServerResponse): boolean {
    if (loop.lastSnapshotJson === null) return false;
    res.write(`event: ${loop.eventName}\ndata: ${loop.lastSnapshotJson}\n\n`);
    // Unlike the session hub, a replayed list snapshot is the whole state, so
    // there is nothing to re-emit and no reason to pull the next tick forward.
    return false;
  }

  /**
   * Kicks every active loop out of its steady cadence: tick immediately, then
   * poll at the wake cadence for the next burstMs. Called by the daemon at the
   * moments the list is about to change (a run was triggered, a decision was
   * made, a runner announced completion) so subscribers see the transition in
   * ~1s instead of waiting out the steady interval.
   */
  wake(burstMs = LIST_SSE_WAKE_WINDOW_MS): void {
    const until = Date.now() + burstMs;
    for (const loop of this.loops.values()) {
      if (loop.stopped) continue;
      loop.fastUntil = Math.max(loop.fastUntil, until);
      if (loop.timer) {
        clearTimeout(loop.timer);
        loop.timer = null;
      }
      if (!loop.ticking) void this.tick(loop);
    }
  }

  protected nextIntervalMs(loop: ApprovalListLoop<TSnapshot>): number {
    if (loop.fastUntil > Date.now()) return LIST_SSE_WAKE_INTERVAL_MS;
    return loop.lastLive ? this.liveIntervalMs : this.intervalMs;
  }

  protected async pollOnce(loop: ApprovalListLoop<TSnapshot>): Promise<void> {
    const result = await loop.poll();
    if (loop.stopped) return;

    if (result.ok) {
      loop.lastLive = this.isLive ? this.isLive(result.snapshot) : false;
      const snapshotJson = JSON.stringify(result.snapshot);
      if (snapshotJson !== loop.lastSnapshotJson) {
        loop.lastSnapshotJson = snapshotJson;
        this.broadcast(loop, `event: ${loop.eventName}\ndata: ${snapshotJson}\n\n`);
      }
    } else {
      this.broadcast(loop, `event: stream-error\ndata: ${JSON.stringify(result.error)}\n\n`);
    }
  }
}

/**
 * Fans already-composed notification events out to connected native clients.
 * Unlike the snapshot hubs above, this stream deliberately has no replay:
 * opening the desktop app must not re-notify historical approvals or sessions.
 */
export class NotificationEventHub<TEvent> {
  private subscribers = new Set<ServerResponse>();
  private readonly heartbeatIntervalMs: number;
  private readonly maxSubscribers: number;

  constructor(options: { heartbeatIntervalMs?: number; maxSubscribers?: number } = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.maxSubscribers = options.maxSubscribers ?? 10;
  }

  subscribe(options: { req: IncomingMessage; res: ServerResponse }): boolean {
    if (this.subscribers.size >= this.maxSubscribers) return false;
    const { req, res } = options;
    this.subscribers.add(res);
    writeSseHeaders(res);

    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(`: hb\n\n`);
    }, this.heartbeatIntervalMs);
    const onClose = () => {
      clearInterval(heartbeat);
      this.subscribers.delete(res);
    };
    res.on("close", onClose);
    req.on("close", onClose);
    return true;
  }

  publish(event: TEvent): void {
    const message = `event: notification\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of [...this.subscribers]) {
      if (res.destroyed) {
        this.subscribers.delete(res);
        continue;
      }
      res.write(message);
    }
  }

  activeSubscriberCount(): number {
    return this.subscribers.size;
  }

  shutdown(): void {
    for (const res of this.subscribers) res.end();
    this.subscribers.clear();
  }
}
