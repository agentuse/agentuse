import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ApprovalRow, SessionRow } from '../lib/api';
import { blockerGroupKey, isBlockerKind, isHumanBlocker, BLOCKER_LABELS } from '../../../../session/blocker';
import { failureLabel } from '../../../../session/failure-label';
import { displayAgentName, errorText, formatApprovalTime, formatRelativeTime, plural } from '../lib/format';
import { sessionDestinationHref } from '../lib/links';
import { PendingApprovalRow, waitingSince, type AgentGroup } from './pending-approval-card';

/** A gate older than this is past acting on for most agents (a reply to a
 *  two-day-old post), so its group offers to reject it in one go. */
export const STALE_GATE_MS = 48 * 3_600_000;

/** The same key groupPendingByAgent gives a gate, so a run and the gate it
 *  waits on land on one row. */
export function agentGroupKey(project: string, agent: SessionRow['agent']): string {
  return `${project}:${displayAgentName(agent.name, agent.filePath, agent.id)}`;
}

/** Runs that ended waiting on a person, counted per agent: the gates they are
 *  stuck behind say "blocking N runs" instead of the runs reading as failures. */
export function waitingRunsByAgent(rows: SessionRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.errorCause !== 'waiting_on_human') continue;
    const key = agentGroupKey(row.project, row.agent);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface BrokenGroup {
  key: string;
  /** Blocker kind or failure cause, for the tag. */
  kind: string;
  label: string;
  /** What is stuck; for failures with no blocker, the agent that failed. */
  subject: string;
  /** How the newest run's blocker was established, when it has one. */
  source?: string;
  rows: SessionRow[];
  agents: string[];
  latest: SessionRow;
}

function brokenIdentity(row: SessionRow): { key: string; kind: string; label: string; subject: string } {
  const agent = displayAgentName(row.agent.name, row.agent.filePath, row.agent.id);
  const cause = row.errorCause;
  if (isBlockerKind(cause) && row.errorSubject) {
    return { key: blockerGroupKey(cause, row.errorSubject), kind: cause, label: BLOCKER_LABELS[cause], subject: row.errorSubject };
  }
  // No blocker named (a crash, a timeout, or an older incomplete run): the
  // failure is the agent's own, so it groups per agent and cause.
  const kind = cause ?? row.errorCode ?? 'error';
  const label = failureLabel(cause) ?? (row.errorCode === 'INCOMPLETE' ? 'Incomplete, no blocker' : row.errorCode ?? 'Error');
  return { key: `${kind}:${row.project}:${agent}`, kind, label, subject: agent };
}

/** Failed runs, one group per stuck thing, biggest first: 16 runs blocked on
 *  one missing tool is one row, not sixteen. A person-blocked run is not a
 *  failure and never lands here. */
export function groupBrokenRuns(rows: SessionRow[]): BrokenGroup[] {
  const groups = new Map<string, BrokenGroup>();
  const at = (row: SessionRow) => row.updatedAt || row.createdAt;
  for (const row of rows) {
    if (isHumanBlocker(row.errorCause)) continue;
    const id = brokenIdentity(row);
    const agent = displayAgentName(row.agent.name, row.agent.filePath, row.agent.id);
    const group = groups.get(id.key);
    if (!group) {
      groups.set(id.key, {
        ...id,
        ...(row.errorCauseSource && { source: row.errorCauseSource }),
        rows: [row], agents: [agent], latest: row,
      });
      continue;
    }
    group.rows.push(row);
    if (!group.agents.includes(agent)) group.agents.push(agent);
    if (at(row) > at(group.latest)) {
      group.latest = row;
      if (row.errorCauseSource) group.source = row.errorCauseSource;
    }
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || at(b.latest) - at(a.latest));
}

const SOURCE_LABELS: Record<string, string> = {
  runtime: 'runtime saw',
  approval: 'approval record',
  agent: 'agent says',
  inferred: 'inferred',
};

/** One stuck thing: how many runs it broke, which agents, and the newest
 *  run's own words, tagged with how sure we are of the grouping. */
export function BrokenGroupRow(props: { group: BrokenGroup; actions?: ComponentChildren }) {
  const { group } = props;
  const latestAt = group.latest.updatedAt || group.latest.createdAt;
  const agents = group.agents.length === 1 ? group.agents[0]! : plural(group.agents.length, 'agent');
  const message = errorText(group.latest.errorMessage);
  return (
    <div class="broken-row">
      <span class="feed-dot failed" aria-hidden="true"></span>
      <span class="broken-count">{plural(group.rows.length, 'run')}</span>
      <div class="broken-body">
        <div class="broken-head">
          <span class="broken-kind">{group.label}</span>
          <span class="broken-subject">{group.subject}</span>
          <span class="broken-meta" title={formatApprovalTime(latestAt)}>{agents} · last {formatRelativeTime(latestAt)}</span>
        </div>
        {message && (
          <div class="broken-fix">
            {group.source && <span class={`broken-source source-${group.source}`}>{SOURCE_LABELS[group.source] ?? group.source}</span>}
            <span class="broken-message">{message}</span>
          </div>
        )}
      </div>
      <div class="broken-actions">
        {props.actions}
        <a class="broken-review" href={sessionDestinationHref(group.latest)}>review →</a>
      </div>
    </div>
  );
}

/** One agent's pending gates: the newest on screen, the rest folded, with the
 *  runs they block and a way to reject the stale ones together. */
export function ApprovalAgentGroup(props: {
  group: AgentGroup;
  now: number;
  blockingRuns: number;
  rejectStale: (rows: ApprovalRow[]) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const { group, now } = props;
  const [newest, ...older] = group.rows;
  if (!newest) return null;
  const stale = older.filter((row) => now - (waitingSince(row) ?? now) > STALE_GATE_MS);
  const hasMeta = older.length > 0 || props.blockingRuns > 0;
  return (
    <div class="pending-agent-group">
      <PendingApprovalRow row={newest} now={now} />
      {open && older.map((row) => <PendingApprovalRow key={`${row.project}:${row.sessionId}`} row={row} now={now} hideAgent />)}
      {hasMeta && (
        <div class="pending-agent-meta">
          {props.blockingRuns > 0 && <span class="pending-blocking">blocking {plural(props.blockingRuns, 'run')}</span>}
          {older.length > 0 && (
            <button type="button" class="attn-more" aria-expanded={open} onClick={() => setOpen((on) => !on)}>
              {open ? 'hide older' : `+${older.length} older`}
            </button>
          )}
          {stale.length > 0 && props.rejectStale(stale)}
        </div>
      )}
    </div>
  );
}
