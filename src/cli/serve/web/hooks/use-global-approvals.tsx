import { createContext, type ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { ApiRequestError, fetchApprovals, type ApprovalsListPayload } from '../lib/api';
import { useApprovalsStream } from './use-approvals-stream';

export interface PendingApprovalIdentity {
  sessionId: string;
  project?: string | undefined;
  resumeToken?: string | undefined;
}

export interface AttentionSessionIdentity {
  sessionId: string;
  project: string;
}

interface GlobalApprovalsState {
  data: ApprovalsListPayload | null;
  error: ApiRequestError | null;
  loading: boolean;
  live: boolean;
  /** Hide a decision the server accepted while SSE catches up. */
  resolvePending: (approval: PendingApprovalIdentity) => void;
  /** Hide a reviewed/stopped session while the sessions stream catches up. */
  dismissAttentionSession: (session: AttentionSessionIdentity) => void;
  /** Roll back an optimistic dismissal when its request fails. */
  restoreAttentionSession: (session: AttentionSessionIdentity) => void;
  dismissedAttentionSessions: ReadonlySet<string>;
}

const EMPTY: GlobalApprovalsState = {
  data: null,
  error: null,
  loading: false,
  live: false,
  resolvePending: () => {},
  dismissAttentionSession: () => {},
  restoreAttentionSession: () => {},
  dismissedAttentionSessions: new Set(),
};
const GlobalApprovalsContext = createContext<GlobalApprovalsState>(EMPTY);

function approvalKey(row: Pick<PendingApprovalIdentity, 'project' | 'sessionId'>): string {
  return `${row.project ?? ''}:${row.sessionId}`;
}

export function attentionSessionKey(row: AttentionSessionIdentity): string {
  return `${row.project}:${row.sessionId}`;
}

export function withDismissedAttentionSession(
  current: ReadonlySet<string>,
  session: AttentionSessionIdentity
): ReadonlySet<string> {
  const key = attentionSessionKey(session);
  if (current.has(key)) return current;
  return new Set(current).add(key);
}

export function withoutDismissedAttentionSession(
  current: ReadonlySet<string>,
  session: AttentionSessionIdentity
): ReadonlySet<string> {
  const key = attentionSessionKey(session);
  if (!current.has(key)) return current;
  const next = new Set(current);
  next.delete(key);
  return next;
}

export function isAttentionSessionDismissed(
  dismissed: ReadonlySet<string>,
  session: AttentionSessionIdentity
): boolean {
  return dismissed.has(attentionSessionKey(session));
}

function matchesApproval(row: PendingApprovalIdentity, approval: PendingApprovalIdentity): boolean {
  return row.sessionId === approval.sessionId
    && (approval.project === undefined || row.project === approval.project);
}

/** Removes only the pending representation of a gate. Decided history is left
 * untouched and arrives from the next authoritative server snapshot. */
export function withoutPendingApproval(
  payload: ApprovalsListPayload,
  approval: PendingApprovalIdentity
): ApprovalsListPayload {
  return {
    ...payload,
    approvals: payload.approvals.filter((row) => row.status !== 'pending' || !matchesApproval(row, approval)),
    buckets: {
      ...payload.buckets,
      pending: payload.buckets.pending.filter((row) => !matchesApproval(row, approval)),
    },
  };
}

/** One operator-wide approval snapshot and SSE connection shared by the shell,
 * Home, and the arrival toast. Capability-scoped session links deliberately do
 * not open this operator-only stream. */
export function GlobalApprovalsProvider(props: { children: ComponentChildren }) {
  // Consume router state so a token-scoped deep link can safely return to an
  // operator page and reconnect this stream without requiring a full reload.
  const location = useLocation();
  const scoped = location.query.token !== undefined;
  const [data, setData] = useState<ApprovalsListPayload | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [fallback, setFallback] = useState(false);
  // Session-list attention rows are independent of the approvals projection.
  // Keep a tiny app-root mask so Discard on Session Detail, Sessions, or Home
  // survives route changes and stale list snapshots.
  const [dismissedAttentionSessions, setDismissedAttentionSessions] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  // A decision POST returns 202 before the worker's durable projection and the
  // list SSE necessarily catch up. Keep the exact old gate suppressed across a
  // stale in-flight snapshot; a genuinely new gate has a different resumeToken
  // and is allowed through immediately.
  const resolvedRef = useRef<Map<string, PendingApprovalIdentity>>(new Map());
  const releaseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const acceptSnapshot = useCallback((payload: ApprovalsListPayload) => {
    let next = payload;
    for (const [key, resolved] of resolvedRef.current) {
      const serverRow = payload.buckets.pending.find((row) => matchesApproval(row, resolved));
      const isNewGate = serverRow !== undefined
        && resolved.resumeToken !== undefined
        && serverRow.resumeToken !== resolved.resumeToken;
      if (!serverRow || isNewGate) {
        resolvedRef.current.delete(key);
        const timer = releaseTimersRef.current.get(key);
        if (timer) clearTimeout(timer);
        releaseTimersRef.current.delete(key);
        continue;
      }
      next = withoutPendingApproval(next, resolved);
    }
    setData(next);
  }, []);

  const resolvePending = useCallback((approval: PendingApprovalIdentity) => {
    const key = approvalKey(approval);
    resolvedRef.current.set(key, approval);
    setData((current) => current ? withoutPendingApproval(current, approval) : current);

    const existing = releaseTimersRef.current.get(key);
    if (existing) clearTimeout(existing);
    // If the resume fails, the server restores the same gate to pending. Stop
    // suppressing it after a bounded window so the next snapshot can surface
    // that failure instead of hiding actionable work indefinitely.
    releaseTimersRef.current.set(key, setTimeout(() => {
      resolvedRef.current.delete(key);
      releaseTimersRef.current.delete(key);
      // The server may have broadcast a restored pending gate while it was
      // suppressed and will not repeat an unchanged snapshot. Pull once when
      // the guard expires so a failed resume becomes visible again.
      void fetchApprovals().then(acceptSnapshot).catch(() => {});
    }, 30_000));
  }, [acceptSnapshot]);

  const dismissAttentionSession = useCallback((session: AttentionSessionIdentity) => {
    setDismissedAttentionSessions((current) => withDismissedAttentionSession(current, session));
  }, []);

  const restoreAttentionSession = useCallback((session: AttentionSessionIdentity) => {
    setDismissedAttentionSessions((current) => withoutDismissedAttentionSession(current, session));
  }, []);

  useEffect(() => () => {
    for (const timer of releaseTimersRef.current.values()) clearTimeout(timer);
    releaseTimersRef.current.clear();
  }, []);

  useApprovalsStream({
    days: undefined,
    project: undefined,
    enabled: !scoped && !fallback,
    onData: (payload) => {
      acceptSnapshot(payload);
      setError(null);
    },
    onError: setError,
    onFallback: () => setFallback(true),
  });

  useEffect(() => {
    if (scoped || !fallback) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const payload = await fetchApprovals();
        if (!cancelled) {
          acceptSnapshot(payload);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof ApiRequestError
            ? nextError
            : new ApiRequestError(0, 'REQUEST_FAILED', (nextError as Error).message));
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scoped, fallback, acceptSnapshot]);

  return (
    <GlobalApprovalsContext.Provider value={{
      data,
      error,
      loading: !scoped && data === null && error === null,
      live: !scoped && !fallback,
      resolvePending,
      dismissAttentionSession,
      restoreAttentionSession,
      dismissedAttentionSessions,
    }}>
      {props.children}
    </GlobalApprovalsContext.Provider>
  );
}

export function useGlobalApprovals(): GlobalApprovalsState {
  return useContext(GlobalApprovalsContext);
}
