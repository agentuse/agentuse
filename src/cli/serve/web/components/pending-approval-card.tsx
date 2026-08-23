import type { ApprovalRow } from '../lib/api';
import { displayAgentName, formatApprovalTime } from '../lib/format';

function formatWaiting(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'waiting now';
  if (min < 60) return `waiting ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `waiting ${hr}h`;
  return `waiting ${Math.floor(hr / 24)}d`;
}

/** Age tone for the compact row: fresh is quiet, a day is a nudge, three days
 *  is overdue. Reviewers pick by staleness first, so the pill carries it. */
function waitingTone(ms: number): 'fresh' | 'aging' | 'stale' {
  const hr = ms / 3_600_000;
  if (hr >= 72) return 'stale';
  if (hr >= 24) return 'aging';
  return 'fresh';
}

export function approvalHref(row: ApprovalRow): string {
  const params = new URLSearchParams({ project: row.project });
  if (row.resumeToken) params.set('token', row.resumeToken);
  return `/sessions/${encodeURIComponent(row.sessionId)}?${params.toString()}`;
}

/** Shared pending-gate card for Home and Approvals. Decisions stay on the
 * session page after the reviewer reads the full context. */
export function PendingApprovalCard(props: { row: ApprovalRow }) {
  const { row } = props;
  const since = row.suspendedAt ?? row.createdAt;

  return (
    <a class="pending-approval" href={approvalHref(row)}>
      <div class="pending-approval-head">
        <span class="pending-approval-agent">{displayAgentName(row.agentName, row.agentFilePath, row.agentId)}</span>
        <span class="pending-approval-time">
          {since !== undefined && <span title={formatApprovalTime(since)}>{formatWaiting(Date.now() - since)}</span>}
          <span class="pending-approval-review">review →</span>
        </span>
      </div>
      {row.risk && <div class="pending-approval-risk">{row.risk}</div>}
      {(row.summary || row.prompt) && <div class="pending-approval-summary">{row.summary || row.prompt}</div>}
    </a>
  );
}

/** One-line scan row for Home: agent, one-line summary, age pill. The risk
 *  sentence moves to the tooltip — it was a second blue line on every card and
 *  made twenty rows read as one block. A pick-among-options gate gets a tag so
 *  the reviewer knows it needs a choice, not a tap. */
export function PendingApprovalRow(props: { row: ApprovalRow; now: number }) {
  const { row, now } = props;
  const since = row.suspendedAt ?? row.createdAt;
  const waited = since !== undefined ? now - since : undefined;
  const text = row.summary || row.prompt || '';
  const tip = [row.risk, text].filter(Boolean).join('\n\n');

  return (
    <a class="pending-row" href={approvalHref(row)} title={tip}>
      <span class="pending-row-agent">{displayAgentName(row.agentName, row.agentFilePath, row.agentId)}</span>
      <span class="pending-row-text">
        {row.hasOptions && <span class="pending-row-tag">pick</span>}
        {text}
      </span>
      {waited !== undefined && since !== undefined && (
        <span class={`pending-row-age tone-${waitingTone(waited)}`} title={formatApprovalTime(since)}>
          {formatWaiting(waited).replace('waiting ', '')}
        </span>
      )}
      <span class="pending-row-review">review →</span>
    </a>
  );
}
