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

/** Shared pending-gate card for Home and Approvals. Decisions stay on the
 * session page after the reviewer reads the full context. */
export function PendingApprovalCard(props: { row: ApprovalRow }) {
  const { row } = props;
  const since = row.suspendedAt ?? row.createdAt;
  const params = new URLSearchParams({ project: row.project });
  if (row.resumeToken) params.set('token', row.resumeToken);

  return (
    <a class="pending-approval" href={`/sessions/${encodeURIComponent(row.sessionId)}?${params.toString()}`}>
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
