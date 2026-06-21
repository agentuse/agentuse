import { useEffect, useRef } from 'preact/hooks';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { fetchSessionStatus } from '../lib/api';
import { isLiveStatus } from '../lib/format';

export interface ApprovalStreamHandlers {
  onStatus: (status: string, approval: Omit<ApprovalPageInfo, 'logs'>) => void;
  onLog: (entry: ApprovalLogEntry) => void;
  onLogs: (entries: ApprovalLogEntry[]) => void;
  /**
   * Terminal load failures that the view should render as an error instead of
   * retrying: unauthorized (401), not found (404), and corrupted session data
   * (422 / SESSION_CORRUPTED).
   */
  onFatalError: (code: string, message: string) => void;
}

/** Codes/statuses that mean "stop trying, show the error" rather than retry. */
const TERMINAL_STATUSES = new Set([401, 404, 422]);
const TERMINAL_CODES = new Set(['SESSION_CORRUPTED']);

const SSE_FAILURE_WINDOW_MS = 10_000;
const SSE_FAILURES_BEFORE_FALLBACK = 2;
const SSE_RETRY_MS = 60_000;
/**
 * When arriving from a just-started detached run (?pending=1), the session may
 * not be on disk yet, so the polling fallback can 404 briefly. Tolerate that as
 * non-fatal for this window (until the session first resolves) instead of
 * showing "not found". Mirrors the server SSE fast-retry window.
 */
const PENDING_NOT_FOUND_GRACE_MS = 30_000;

/**
 * Live session updates: SSE from /sessions/{id}/events with automatic fallback
 * to /sessions/{id}/status polling (500ms live / 1500ms idle) when the stream
 * keeps failing, and a periodic attempt to return to SSE.
 */
export function useApprovalStream(options: {
  sessionId: string;
  token: string | undefined;
  project: string | undefined;
  handlers: ApprovalStreamHandlers;
  /** Bumped to force an immediate refresh (e.g. right after posting a decision). */
  nudge: number;
  /**
   * Set when navigating from a just-started detached run: a brief 404 in the
   * polling fallback is expected (the session is still being written) and must
   * not be treated as a fatal "not found".
   */
  pending?: boolean;
}): void {
  const handlersRef = useRef(options.handlers);
  handlersRef.current = options.handlers;
  const nudgeRef = useRef<() => void>(() => {});

  const { sessionId, token, project, pending } = options;

  useEffect(() => {
    // Grace window for a just-started session that 404s in the polling fallback.
    const mountedAt = Date.now();
    let seenOk = false;
    // No token is valid on a local (no-api-key) daemon, where the session
    // routes are open. Only an exposed daemon needs ?token=; there the
    // token-less fetches 401 and surface via onAuthError below.
    let closed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let errorTimes: number[] = [];

    const url = new URL(`/sessions/${encodeURIComponent(sessionId)}/events`, location.origin);
    if (token) url.searchParams.set('token', token);
    if (project) url.searchParams.set('project', project);

    // One status fetch → dispatch to the view. Shared by the initial paint and
    // the polling fallback so first load / SPA navigation never waits on the SSE
    // handshake. Returns the next poll delay (ms); `fatal` is true when a
    // terminal error was surfaced and the caller should stop.
    const fetchAndDispatch = async (): Promise<{ fatal: boolean; delay: number }> => {
      try {
        const payload = await fetchSessionStatus(sessionId, token, project);
        if (closed) return { fatal: false, delay: 1500 };
        seenOk = true;
        const { logs, ...approval } = payload.approval;
        handlersRef.current.onStatus(payload.status, approval);
        handlersRef.current.onLogs(payload.logs ?? logs ?? []);
        return { fatal: false, delay: isLiveStatus(payload.status, payload.logs ?? []) ? 500 : 1500 };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const code = (err as { code?: string }).code;
        if ((status !== undefined && TERMINAL_STATUSES.has(status)) || (code !== undefined && TERMINAL_CODES.has(code))) {
          // A just-started detached run can 404 until its session is written;
          // keep retrying (faster) within the grace window instead of failing.
          const pendingNotFound = status === 404 && pending && !seenOk
            && Date.now() - mountedAt < PENDING_NOT_FOUND_GRACE_MS;
          if (!pendingNotFound) {
            handlersRef.current.onFatalError(code ?? 'REQUEST_FAILED', (err as Error).message);
            return { fatal: true, delay: 0 };
          }
          return { fatal: false, delay: 600 };
        }
        return { fatal: false, delay: 1500 };
      }
    };

    const poll = async () => {
      if (closed || !polling) return;
      const { fatal, delay } = await fetchAndDispatch();
      if (fatal) return;
      if (!closed && polling) {
        pollTimer = setTimeout(() => void poll(), delay);
      }
    };

    const startPolling = () => {
      if (polling) return;
      polling = true;
      source?.close();
      source = null;
      void poll();
      sseRetryTimer = setTimeout(() => {
        if (closed) return;
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
        errorTimes = [];
        connect();
      }, SSE_RETRY_MS);
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(url);
      source.addEventListener('status', (event) => {
        errorTimes = [];
        const payload = JSON.parse((event as MessageEvent).data);
        handlersRef.current.onStatus(payload.status, payload.approval);
      });
      source.addEventListener('log', (event) => {
        const entry = JSON.parse((event as MessageEvent).data) as ApprovalLogEntry;
        handlersRef.current.onLog(entry);
      });
      source.addEventListener('stream-error', (event) => {
        // The hub keeps the stream open on transient snapshot failures, but a
        // terminal one (corrupt session data) will never recover: surface it
        // and stop. Non-terminal errors are left to the hub's own retry.
        const payload = JSON.parse((event as MessageEvent).data) as { code?: string; message?: string };
        if (payload.code !== undefined && TERMINAL_CODES.has(payload.code)) {
          closed = true;
          source?.close();
          source = null;
          if (pollTimer) clearTimeout(pollTimer);
          if (sseRetryTimer) clearTimeout(sseRetryTimer);
          handlersRef.current.onFatalError(payload.code, payload.message ?? 'Session data is corrupted.');
        }
      });
      source.addEventListener('error', () => {
        // A CLOSED source means the browser will not retry (e.g. the endpoint
        // answered 401/404 instead of an event stream): fall back to /status
        // immediately, which surfaces auth errors. Otherwise EventSource
        // auto-reconnects; repeated failures in a short window mean the
        // endpoint is unhealthy (or proxied badly): fall back too.
        if (source?.readyState === EventSource.CLOSED) {
          startPolling();
          return;
        }
        const now = Date.now();
        errorTimes = [...errorTimes.filter((t) => now - t < SSE_FAILURE_WINDOW_MS), now];
        if (errorTimes.length >= SSE_FAILURES_BEFORE_FALLBACK) {
          startPolling();
        }
      });
    };

    nudgeRef.current = () => {
      if (closed) return;
      if (polling) {
        if (pollTimer) clearTimeout(pollTimer);
        void poll();
      }
      // With SSE the server pushes the change; nothing to do.
    };

    // Paint from the API right away (in parallel with opening the stream) so the
    // page shows the session in one round-trip instead of waiting on the SSE
    // handshake — which, on a slow/buffered stream, may never deliver its first
    // event and leaves the page stuck on "Loading session…". SSE then takes over
    // for live deltas. A terminal error on this first load tears the stream down.
    connect();
    void fetchAndDispatch().then(({ fatal }) => {
      if (!fatal) return;
      closed = true;
      source?.close();
      source = null;
      if (pollTimer) clearTimeout(pollTimer);
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
    });

    return () => {
      closed = true;
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
    };
  }, [sessionId, token, project]);

  useEffect(() => {
    if (options.nudge > 0) nudgeRef.current();
  }, [options.nudge]);
}
