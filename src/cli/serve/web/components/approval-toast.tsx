import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { ApprovalRow } from '../lib/api';
import { useGlobalApprovals } from '../hooks/use-global-approvals';

const rowKey = (row: ApprovalRow): string => `${row.project}:${row.sessionId}`;
const sessionHref = (row: ApprovalRow): string =>
  `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;

/** Long enough to read the line, short enough that it stops nagging. */
const DISMISS_AFTER_MS = 10_000;

/**
 * Global approval-arrival notice. Watches the approvals stream from anywhere in
 * the app and slides in when a NEW gate appears. It notifies and routes — it
 * does NOT decide. Deciding needs the surrounding thread, the diff, the option
 * bodies; none of that fits here, so every path leads to the session page,
 * which already lands you on the gate itself (scrollToActionableGate). Offering
 * Approve/Reject on a strip this size only invites a blind call.
 *
 * The first stream payload only seeds the seen-set — pre-existing pending
 * approvals are the topbar badge's job, not breaking news. If the gate is
 * decided elsewhere (another tab, Slack, the phone) the notice dismisses itself
 * when the row leaves the pending bucket, and it auto-dismisses on a timer
 * regardless: the badge and /approvals hold the persistent copy.
 */
export function ApprovalToast() {
  const location = useLocation();
  const [toast, setToast] = useState<ApprovalRow | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [held, setHeld] = useState(false);
  const seenRef = useRef<Set<string> | null>(null);
  const approvals = useGlobalApprovals();

  useEffect(() => {
      const pending = approvals.data?.buckets.pending;
      if (!pending) return;
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
        // A gate decided elsewhere leaves pending; drop a stale notice for it.
        const survives = current && pending.some((row) => rowKey(row) === rowKey(current));
        if (fresh) return fresh;
        return survives ? current : null;
      });
  }, [approvals.data]);

  // The session page renders the gate inline with full context; a notice on top
  // of it would be a duplicate. Suppress while that page is open.
  const onOwnSessionPage = toast !== null && location.path === `/sessions/${toast.sessionId}`;

  // Auto-dismiss, held while the pointer is on it so it can't vanish mid-read.
  useEffect(() => {
    if (!toast || held) return;
    const timer = setTimeout(() => setToast(null), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [toast, held]);

  if (!toast || onOwnSessionPage) return null;

  const title = toast.agentName || toast.agentId;
  // `risk` is the one-line real-world consequence of approving, and it is only
  // set when the action is hard to undo — a better "is this worth stopping for"
  // signal than the opening words of the summary.
  const line = toast.risk || toast.summary || toast.prompt || '';
  const others = pendingCount - 1;

  return (
    <div
      class="approval-toast"
      role="alert"
      aria-live="assertive"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusIn={() => setHeld(true)}
      onFocusOut={() => setHeld(false)}
    >
      <a class="approval-toast-link" href={sessionHref(toast)} onClick={() => setToast(null)}>
        <span class="approval-toast-dot" aria-hidden="true"></span>
        <span class="approval-toast-body">
          <span class="approval-toast-head">
            <span class="approval-toast-agent">{title}</span>
            <span class="approval-toast-label">{toast.hasOptions ? 'wants you to pick an option' : 'wants approval'}</span>
            {others > 0 && <span class="approval-toast-more">+{others} more waiting</span>}
          </span>
          {line && <span class="approval-toast-line" title={line}>{line}</span>}
        </span>
        <span class="approval-toast-go" aria-hidden="true">Review →</span>
      </a>
      <button type="button" class="approval-toast-dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
    </div>
  );
}
