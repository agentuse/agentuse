import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiRequestError, SessionRow, SessionsPayload, ApprovalsListPayload } from '../lib/api';
import { fetchSessions, fetchApprovals } from '../lib/api';
import { useFetch } from './use-fetch';
import { useSessionsStream } from './use-sessions-stream';
import { useApprovalsStream } from './use-approvals-stream';
import { displayStatusLabel } from '../lib/format';

/** One row of the home-page activity feed, derived from session transitions. */
export interface ActivityEvent {
  key: string;
  sessionId: string;
  project: string;
  agentName: string;
  /** Feed verb ("started", "completed", "awaiting approval", "stopped", …). */
  label: string;
  /** Dot/color class bucket for the label. */
  tone: 'running' | 'waiting' | 'done' | 'failed';
  at: number;
  /** Arrived over the live stream (animates in) vs. seeded from the first snapshot. */
  fresh: boolean;
  href: string;
}

const FEED_LIMIT = 20;
const SEED_LIMIT = 8;

function toneFor(label: string): ActivityEvent['tone'] {
  if (label === 'started' || label === 'running' || label === 'resuming' || label === 'continuing') return 'running';
  if (label === 'awaiting approval' || label === 'suspended') return 'waiting';
  if (label === 'completed') return 'done';
  return 'failed';
}

function labelFor(row: SessionRow, isNew: boolean): string {
  const status = displayStatusLabel(row.status, row.errorCode);
  if (status === 'suspended') return 'awaiting approval';
  if (isNew && (status === 'running' || status === 'resuming' || status === 'continuing')) return 'started';
  return status;
}

function eventFor(row: SessionRow, opts: { isNew: boolean; fresh: boolean; seq: number }): ActivityEvent {
  const label = labelFor(row, opts.isNew);
  return {
    key: `${row.project}:${row.sessionId}:${label}:${opts.seq}`,
    sessionId: row.sessionId,
    project: row.project,
    agentName: row.agent.name || row.agent.id,
    label,
    tone: toneFor(label),
    at: row.updatedAt || row.createdAt,
    fresh: opts.fresh,
    href: `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`,
  };
}

export interface LiveHome {
  sessions: SessionRow[];
  feed: ActivityEvent[];
  pendingApprovals: number;
  /** True while the SSE stream is healthy (footer copy + demo confidence). */
  live: boolean;
  error: ApiRequestError | null;
  loading: boolean;
}

/**
 * Live data spine for the home page: subscribes to the sessions and approvals
 * list streams (falling back to polling like the sessions page does) and folds
 * consecutive session snapshots into an activity feed of status transitions.
 * The first snapshot seeds the feed with recent history so the page never
 * opens empty; every later diff prepends "fresh" rows that animate in. Each
 * session keeps a single row: a new transition replaces the session's older
 * row (e.g. "running" becomes "completed") instead of stacking a duplicate.
 */
export function useLiveHome(): LiveHome {
  const [sessionsPayload, setSessionsPayload] = useState<SessionsPayload | null>(null);
  const [sessionsFallback, setSessionsFallback] = useState(false);
  const [streamError, setStreamError] = useState<ApiRequestError | null>(null);
  const [approvalsPayload, setApprovalsPayload] = useState<ApprovalsListPayload | null>(null);
  const [approvalsFallback, setApprovalsFallback] = useState(false);

  const fetchedSessions = useFetch(
    'home-sessions',
    () => fetchSessions({ window: '24h' }),
    sessionsFallback ? { refreshMs: 10_000 } : {}
  );
  const fetchedApprovals = useFetch(
    'home-approvals',
    () => fetchApprovals(),
    approvalsFallback ? { refreshMs: 15_000 } : {}
  );

  useSessionsStream({
    window: '24h',
    agent: undefined,
    status: undefined,
    trigger: undefined,
    approval: undefined,
    enabled: !sessionsFallback,
    onData: (payload) => {
      setSessionsPayload(payload);
      setStreamError(null);
    },
    onError: setStreamError,
    onFallback: () => setSessionsFallback(true),
  });

  useApprovalsStream({
    days: undefined,
    project: undefined,
    enabled: !approvalsFallback,
    onData: setApprovalsPayload,
    onError: () => {},
    onFallback: () => setApprovalsFallback(true),
  });

  const sessionsData = sessionsFallback
    ? (fetchedSessions.data ?? sessionsPayload)
    : (sessionsPayload ?? fetchedSessions.data);
  const approvalsData = approvalsFallback
    ? (fetchedApprovals.data ?? approvalsPayload)
    : (approvalsPayload ?? fetchedApprovals.data);

  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const prevStatuses = useRef<Map<string, string> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!sessionsData) return;
    const next = new Map<string, string>();
    for (const row of sessionsData.sessions) next.set(`${row.project}:${row.sessionId}`, row.status);
    const prev = prevStatuses.current;
    prevStatuses.current = next;

    if (!prev) {
      const seeded = [...sessionsData.sessions]
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .slice(0, SEED_LIMIT)
        .map((row) => eventFor(row, { isNew: false, fresh: false, seq: seq.current++ }));
      setFeed(seeded);
      return;
    }

    const fresh: ActivityEvent[] = [];
    for (const row of sessionsData.sessions) {
      const before = prev.get(`${row.project}:${row.sessionId}`);
      if (before === row.status) continue;
      fresh.push(eventFor(row, { isNew: before === undefined, fresh: true, seq: seq.current++ }));
    }
    if (fresh.length > 0) {
      fresh.sort((a, b) => b.at - a.at);
      const updated = new Set(fresh.map((event) => `${event.project}:${event.sessionId}`));
      setFeed((current) => [
        ...fresh,
        ...current.filter((event) => !updated.has(`${event.project}:${event.sessionId}`)),
      ].slice(0, FEED_LIMIT));
    }
  }, [sessionsData]);

  return {
    sessions: sessionsData?.sessions ?? [],
    feed,
    pendingApprovals: approvalsData?.buckets.pending.length ?? 0,
    live: !sessionsFallback,
    error: fetchedSessions.error ?? (!sessionsData ? streamError : null),
    loading: fetchedSessions.loading && !sessionsData,
  };
}
