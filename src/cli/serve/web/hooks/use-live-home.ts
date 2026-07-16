import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApiRequestError, ApprovalRow, SessionRow, SessionsPayload, ApprovalsListPayload } from '../lib/api';
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
  if (label === 'awaiting approval' || label === 'approval expired' || label === 'suspended') return 'waiting';
  if (label === 'completed') return 'done';
  return 'failed';
}

/** Suspended sessions bucketed by why they wait, keyed `${project}:${sessionId}`.
 *  A suspended session with no live pending gate is mid-flight, not blocked: its
 *  gate was decided and the run is being carried forward (a delegated leaf
 *  running under a cascaded approval, or a resume worker picking it back up). */
export interface SuspendedGateKinds {
  loaded: boolean;
  pending: Set<string>;
  expired: Set<string>;
}

export function sessionRowKey(row: Pick<SessionRow, 'project' | 'sessionId'>): string {
  return `${row.project}:${row.sessionId}`;
}

export function suspendedGateKinds(approvals: ApprovalsListPayload | null): SuspendedGateKinds {
  return {
    loaded: approvals !== null,
    pending: new Set((approvals?.buckets.pending ?? []).map(sessionRowKey)),
    expired: new Set((approvals?.buckets.expired ?? []).map(sessionRowKey)),
  };
}

export function labelFor(row: SessionRow, isNew: boolean, gates: SuspendedGateKinds): string {
  const status = displayStatusLabel(row.status, row.errorCode);
  if (status === 'suspended') {
    // Until the approvals snapshot arrives, keep the historical default.
    if (!gates.loaded || gates.pending.has(sessionRowKey(row))) return 'awaiting approval';
    if (gates.expired.has(sessionRowKey(row))) return 'approval expired';
    return 'resuming';
  }
  if (isNew && (status === 'running' || status === 'resuming' || status === 'continuing')) return 'started';
  return status;
}

function eventFor(row: SessionRow, opts: { isNew: boolean; fresh: boolean; seq: number; gates: SuspendedGateKinds }): ActivityEvent {
  const label = labelFor(row, opts.isNew, opts.gates);
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
  /** Pending approval gates, newest first (drives "Needs your attention"). */
  pendingRows: ApprovalRow[];
  /** Why each suspended session waits (pending gate vs. mid-flight resume). */
  suspendedGates: SuspendedGateKinds;
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

  // detail: 'feed' attaches each ended session's cached finalResponse, which
  // powers the outcome-first "Latest results" section on Home.
  const fetchedSessions = useFetch(
    'home-sessions',
    () => fetchSessions({ window: '24h', detail: 'feed' }),
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
    detail: 'feed',
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
  const prevLabels = useRef<Map<string, string> | null>(null);
  const seq = useRef(0);
  const gates = suspendedGateKinds(approvalsData);

  useEffect(() => {
    if (!sessionsData) return;
    // Diff by rendered label, not raw status: an approval decision flips a
    // suspended row from "awaiting approval" to "resuming" without a status
    // change, and the feed should surface that transition.
    const next = new Map<string, string>();
    for (const row of sessionsData.sessions) next.set(sessionRowKey(row), labelFor(row, false, gates));
    const prev = prevLabels.current;
    prevLabels.current = next;

    if (!prev) {
      const seeded = [...sessionsData.sessions]
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .slice(0, SEED_LIMIT)
        .map((row) => eventFor(row, { isNew: false, fresh: false, seq: seq.current++, gates }));
      setFeed(seeded);
      return;
    }

    const fresh: ActivityEvent[] = [];
    for (const row of sessionsData.sessions) {
      const before = prev.get(sessionRowKey(row));
      if (before === next.get(sessionRowKey(row))) continue;
      fresh.push(eventFor(row, { isNew: before === undefined, fresh: true, seq: seq.current++, gates }));
    }
    if (fresh.length > 0) {
      fresh.sort((a, b) => b.at - a.at);
      const updated = new Set(fresh.map((event) => `${event.project}:${event.sessionId}`));
      setFeed((current) => [
        ...fresh,
        ...current.filter((event) => !updated.has(`${event.project}:${event.sessionId}`)),
      ].slice(0, FEED_LIMIT));
    }
  }, [sessionsData, approvalsData]);

  return {
    sessions: sessionsData?.sessions ?? [],
    feed,
    pendingApprovals: approvalsData?.buckets.pending.length ?? 0,
    pendingRows: [...(approvalsData?.buckets.pending ?? [])]
      .sort((a, b) => (b.suspendedAt ?? b.createdAt ?? 0) - (a.suspendedAt ?? a.createdAt ?? 0)),
    suspendedGates: gates,
    live: !sessionsFallback,
    error: fetchedSessions.error ?? (!sessionsData ? streamError : null),
    loading: fetchedSessions.loading && !sessionsData,
  };
}
