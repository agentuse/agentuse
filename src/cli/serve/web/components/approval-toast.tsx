import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { ApprovalRow, ApprovalsListPayload } from '../lib/api';
import { postSessionDecision } from '../lib/api';
import { useApprovalsStream } from '../hooks/use-approvals-stream';

const rowKey = (row: ApprovalRow): string => `${row.project}:${row.sessionId}`;
const sessionHref = (row: ApprovalRow): string =>
  `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;

/**
 * Global approval-arrival banner. Watches the approvals stream from anywhere
 * in the app and slides in when a NEW gate appears, with inline Approve /
 * Reject that call the decision endpoint directly. The first stream payload
 * only seeds the seen-set — pre-existing pending approvals are the topbar
 * badge's job, not breaking news. If the gate is decided elsewhere (another
 * tab, Slack, the phone) the banner dismisses itself when the row leaves the
 * pending bucket. Goes inert if the stream falls back; this surface is an
 * accelerator, not the only path to a decision.
 */
export function ApprovalToast() {
  const location = useLocation();
  const [toast, setToast] = useState<ApprovalRow | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'rejected' | null>(null);
  const [fallback, setFallback] = useState(false);
  const seenRef = useRef<Set<string> | null>(null);

  useApprovalsStream({
    days: undefined,
    project: undefined,
    enabled: !fallback,
    onData: (payload: ApprovalsListPayload) => {
      const pending = payload.buckets.pending;
      setPendingCount(pending.length);
      const seen = seenRef.current;
      if (!seen) {
        seenRef.current = new Set(pending.map(rowKey));
        return;
      }
      let fresh: ApprovalRow | null = null;
      for (const row of pending) {
        if (!seen.has(rowKey(row))) {
          seen.add(rowKey(row));
          fresh = row;
        }
      }
      setToast((current) => {
        // A gate decided elsewhere leaves pending; drop a stale banner for it.
        const survives = current && pending.some((row) => rowKey(row) === rowKey(current));
        if (fresh && fresh.resumeToken) return fresh;
        return survives ? current : null;
      });
    },
    onError: () => {},
    onFallback: () => setFallback(true),
  });

  // The session page renders the gate inline with full context; a banner on
  // top of it would be a duplicate. Suppress while that page is open.
  const onOwnSessionPage = toast !== null && location.path === `/sessions/${toast.sessionId}`;

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), 2600);
    return () => clearTimeout(timer);
  }, [outcome]);

  const decide = async (status: 'approved' | 'rejected') => {
    if (!toast?.resumeToken || busy) return;
    setBusy(true);
    try {
      await postSessionDecision(toast.sessionId, undefined, {
        status,
        resumeToken: toast.resumeToken,
        project: toast.project,
      });
      setOutcome(status);
      setToast(null);
    } catch {
      // Token-gated daemon or a raced/reopened gate: the session page has the
      // full decision surface, finish there instead of failing silently.
      location.route(sessionHref(toast));
      setToast(null);
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <div class={`approval-toast outcome ${outcome}`} role="status">
        <span class="approval-toast-dot" aria-hidden="true"></span>
        <span class="approval-toast-text">{outcome === 'approved' ? 'Approved. The agent is resuming.' : 'Rejected. The agent was told no.'}</span>
      </div>
    );
  }

  if (!toast || onOwnSessionPage) return null;

  const title = toast.agentName || toast.agentId;
  const excerpt = (toast.summary || toast.prompt || '').slice(0, 180);

  return (
    <div class="approval-toast" role="alert" aria-live="assertive">
      <span class="approval-toast-dot" aria-hidden="true"></span>
      <div class="approval-toast-body">
        <div class="approval-toast-head">
          <span class="approval-toast-agent">{title}</span>
          <span class="approval-toast-label">wants approval</span>
          {pendingCount > 1 && <a class="approval-toast-more" href="/approvals">+{pendingCount - 1} more</a>}
        </div>
        {excerpt && <div class="approval-toast-excerpt">{excerpt}</div>}
      </div>
      <div class="approval-toast-actions">
        <button type="button" class="approve" disabled={busy} onClick={() => void decide('approved')}>Approve</button>
        <button type="button" class="reject" disabled={busy} onClick={() => void decide('rejected')}>Reject</button>
        <a class="open" href={sessionHref(toast)} onClick={() => setToast(null)}>Open</a>
        <button type="button" class="dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
      </div>
    </div>
  );
}
