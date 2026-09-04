import type { ComponentChildren } from 'preact';
import type { ApprovalRow } from '../lib/api';
import { displayAgentName, formatApprovalTime } from '../lib/format';
import { EXPIRES_SOON_MS, EXPIRES_URGENT_MS, formatCompactAge } from '../lib/approval-stats';

function formatWaiting(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Age tone: fresh is quiet, a day is a nudge, three days is overdue.
 *  Reviewers pick by staleness first, so the pill carries it. */
function waitingTone(ms: number): 'fresh' | 'aging' | 'stale' {
  const hr = ms / 3_600_000;
  if (hr >= 72) return 'stale';
  if (hr >= 24) return 'aging';
  return 'fresh';
}

/** A round-two gate: the agent is re-presenting work after the reviewer's
 *  comment. That is a quick re-check, not a fresh read, and the reviewer
 *  wants to know before opening it. Heuristic on the agent's own wording. */
const REVISED_RE = /\b(revised|re-?presented|rebuilt around your|your (comment|edit|feedback)|round 2)\b/i;
export function isRevisedGate(row: ApprovalRow): boolean {
  return REVISED_RE.test(row.summary || row.prompt || '');
}

export function approvalHref(row: ApprovalRow): string {
  const params = new URLSearchParams({ project: row.project });
  if (row.resumeToken) params.set('token', row.resumeToken);
  return `/sessions/${encodeURIComponent(row.sessionId)}?${params.toString()}`;
}

export function waitingSince(row: ApprovalRow): number | undefined {
  return row.suspendedAt ?? row.createdAt;
}

/** A gate close enough to its deadline that the reviewer needs the number, and
 *  whether it is inside the last hour (red rather than amber). */
export function expiresSoon(row: ApprovalRow, now: number): { leftMs: number; urgent: boolean } | undefined {
  if (row.expiresAt === undefined) return undefined;
  const leftMs = row.expiresAt - now;
  if (leftMs < 0 || leftMs > EXPIRES_SOON_MS) return undefined;
  return { leftMs, urgent: leftMs <= EXPIRES_URGENT_MS };
}

/** Newest gates first for surfaces where recency is the primary scan order.
 *  Missing timestamps stay at the end instead of appearing newer than a
 *  timestamped gate. */
export function pendingNewestFirst(rows: ApprovalRow[]): ApprovalRow[] {
  return [...rows].sort((a, b) =>
    (waitingSince(b) ?? Number.MIN_SAFE_INTEGER) - (waitingSince(a) ?? Number.MIN_SAFE_INTEGER)
  );
}

/** One-line scan row for a pending gate: agent, one-line summary, age pill.
 *  Shared by Home and Approvals so the reviewer learns one pattern. The risk
 *  sentence is optional supporting text in grey, one line; it is a sentence
 *  the reviewer has read many times, and the session page shows it in full. A
 *  pick-among-options gate gets a tag so the reviewer knows it needs a choice,
 *  not a tap; a revised gate gets one so it reads as a re-check. */
export function PendingApprovalRow(props: {
  row: ApprovalRow;
  now: number;
  showRisk?: boolean;
  hideAgent?: boolean;
  /** Approvals-only: a deadline inside six hours is the one thing that can
   *  reorder the reviewer's day, so it rides beside the age pill. */
  showExpiry?: boolean;
}) {
  const { row, now } = props;
  const since = waitingSince(row);
  const waited = since !== undefined ? now - since : undefined;
  const text = row.summary || row.prompt || '';
  const tip = [row.risk, text].filter(Boolean).join('\n\n');
  const risk = props.showRisk ? row.risk : undefined;
  const expiry = props.showExpiry ? expiresSoon(row, now) : undefined;

  return (
    <a
      class={`pending-row${risk ? ' has-risk' : ''}${props.hideAgent ? ' no-agent' : ''}${expiry ? ' has-expiry' : ''}`}
      href={approvalHref(row)}
      title={tip}
    >
      {!props.hideAgent && (
        <span class="pending-row-agent">{displayAgentName(row.agentName, row.agentFilePath, row.agentId)}</span>
      )}
      <span class="pending-row-text">
        {row.hasOptions && <span class="pending-row-tag">pick</span>}
        {isRevisedGate(row) && <span class="pending-row-tag revised">revised</span>}
        {text}
      </span>
      {risk && <span class="pending-row-risk">{risk}</span>}
      {expiry && (
        <span class={`pending-row-expires${expiry.urgent ? ' urgent' : ''}`} title={formatApprovalTime(row.expiresAt)}>
          expires {formatCompactAge(expiry.leftMs)}
        </span>
      )}
      {waited !== undefined && since !== undefined && (
        <span class={`pending-row-age tone-${waitingTone(waited)}`} title={formatApprovalTime(since)}>
          {formatWaiting(waited)}
        </span>
      )}
      <span class="pending-row-review">review →</span>
    </a>
  );
}

export interface AgentGroup {
  key: string;
  name: string;
  project: string;
  agentFilePath?: string;
  rows: ApprovalRow[];
  newest: number;
  /** The group's longest-waiting gate: the ordering key on the approvals page. */
  oldest: number;
}

/** Which agent the reviewer should reach first. Home leads with new activity;
 *  the approvals page leads with the agent that has been ignored longest. */
export type PendingGroupOrder = 'newest' | 'stalest';

/** Group pending gates by agent, most recent first inside and across groups.
 *  Grouping makes repeats visible (the same post re-presented twice shows up
 *  as "×2" under one name) and lets the reviewer clear one agent's queue in
 *  one sitting. A group's most recent gate determines its position, so new
 *  activity rises to the top without splitting an agent's approvals apart. */
export function groupPendingByAgent(rows: ApprovalRow[], order: PendingGroupOrder = 'newest'): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const row of rows) {
    const name = displayAgentName(row.agentName, row.agentFilePath, row.agentId);
    const key = `${row.project}:${name}`;
    const since = waitingSince(row) ?? Number.MIN_SAFE_INTEGER;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
      group.newest = Math.max(group.newest, since);
      group.oldest = Math.min(group.oldest, since);
      if (group.agentFilePath === undefined && row.agentFilePath !== undefined) group.agentFilePath = row.agentFilePath;
    } else {
      groups.set(key, {
        key, name, project: row.project,
        ...(row.agentFilePath !== undefined && { agentFilePath: row.agentFilePath }),
        rows: [row], newest: since, oldest: since,
      });
    }
  }
  const bySince = (a: ApprovalRow, b: ApprovalRow) =>
    (waitingSince(b) ?? Number.MIN_SAFE_INTEGER) - (waitingSince(a) ?? Number.MIN_SAFE_INTEGER);
  return [...groups.values()]
    .map((g) => ({ ...g, rows: [...g.rows].sort(bySince) }))
    .sort((a, b) => order === 'stalest' ? a.oldest - b.oldest : b.newest - a.newest);
}

/** A stable DOM id per group, so the jump rail and the "waiting above ↑" link
 *  can anchor to it. */
export function pendingGroupId(group: AgentGroup): string {
  return `gate-${group.key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

export function PendingApprovalGroups(props: {
  rows: ApprovalRow[];
  now: number;
  order?: PendingGroupOrder;
  /** Approvals-only extras on the group head (30-day record, agent link). */
  groupAside?: (group: AgentGroup) => ComponentChildren;
  /** Approvals-only: anchor each group and show per-row expiry pills. */
  anchored?: boolean;
  showExpiry?: boolean;
}) {
  const groups = groupPendingByAgent(props.rows, props.order);
  return (
    <div class="pending-groups">
      {groups.map((group) => (
        <section class="pending-group" key={group.key} {...(props.anchored ? { id: pendingGroupId(group) } : {})}>
          <h3 class="pending-group-head">
            <span class="pending-group-name">{group.name}</span>
            {group.rows.length > 1 && <span class="pending-group-count">×{group.rows.length}</span>}
            {props.groupAside?.(group)}
          </h3>
          {group.rows.map((row) => (
            <PendingApprovalRow
              key={`${row.project}:${row.sessionId}`}
              row={row}
              now={props.now}
              showRisk
              hideAgent
              showExpiry={props.showExpiry === true}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
