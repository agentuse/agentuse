import { useEffect, useRef } from 'preact/hooks';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { fetchSessionStatus } from '../lib/api';
import { isLiveStatus } from '../lib/format';

export interface ApprovalStreamHandlers {
  onStatus: (status: string, approval: Omit<ApprovalPageInfo, 'logs'>) => void;
  onLog: (entry: ApprovalLogEntry) => void;
  onLogs: (entries: ApprovalLogEntry[]) => void;
  onAuthError: (code: string, message: string) => void;
}

const SSE_FAILURE_WINDOW_MS = 10_000;
const SSE_FAILURES_BEFORE_FALLBACK = 2;
const SSE_RETRY_MS = 60_000;

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
}): void {
  const handlersRef = useRef(options.handlers);
  handlersRef.current = options.handlers;
  const nudgeRef = useRef<() => void>(() => {});

  const { sessionId, token, project } = options;

  useEffect(() => {
    if (!token) return;

    let closed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let errorTimes: number[] = [];

    const url = new URL(`/sessions/${encodeURIComponent(sessionId)}/events`, location.origin);
    url.searchParams.set('token', token);
    if (project) url.searchParams.set('project', project);

    const poll = async () => {
      if (closed || !polling) return;
      let delay = 1500;
      try {
        const payload = await fetchSessionStatus(sessionId, token, project);
        if (closed) return;
        const { logs, ...approval } = payload.approval;
        handlersRef.current.onStatus(payload.status, approval);
        handlersRef.current.onLogs(payload.logs ?? logs ?? []);
        delay = isLiveStatus(payload.status, payload.logs ?? []) ? 500 : 1500;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 404) {
          handlersRef.current.onAuthError((err as { code?: string }).code ?? 'REQUEST_FAILED', (err as Error).message);
          return;
        }
      }
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

    connect();

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
