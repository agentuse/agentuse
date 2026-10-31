import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ApprovalRow, AutoPausedSchedule, DeliveryPaceAgent, SessionRow } from '../lib/api';
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

/** One broken agent: its failed runs, the newest one's reason, and, when the
 *  daemon paused its schedule after the same failure twice, why. */
export interface BrokenAgent {
  key: string;
  project: string;
  /** Project-relative agent path, when known: what Resume and links address. */
  path?: string;
  name: string;
  rows: SessionRow[];
  latest?: SessionRow;
  /** Blocker or failure label of the newest run. */
  label?: string;
  autoPause?: AutoPausedSchedule;
}

/**
 * Failed runs, one row per agent rather than per blocker: the question on Home
 * is which agents need a fix, and an agent that broke twenty times is one fix.
 * Agents whose schedule paused itself come first, even when their failed runs
 * were already dismissed: they stay off until someone resumes them.
 */
export function groupBrokenByAgent(rows: SessionRow[], autoPaused: AutoPausedSchedule[]): BrokenAgent[] {
  const agents = new Map<string, BrokenAgent>();
  const at = (row: SessionRow) => row.updatedAt || row.createdAt;
  for (const row of rows) {
    if (isHumanBlocker(row.errorCause)) continue;
    const path = row.agent.runPath;
    const key = path ? `${row.project}::${path}` : agentGroupKey(row.project, row.agent);
    const agent = agents.get(key) ?? {
      key, project: row.project, ...(path && { path }),
      name: displayAgentName(row.agent.name, row.agent.filePath, row.agent.id),
      rows: [],
    };
    agent.rows.push(row);
    if (!agent.latest || at(row) > at(agent.latest)) {
      agent.latest = row;
      agent.label = brokenIdentity(row).label;
    }
    agents.set(key, agent);
  }
  for (const pause of autoPaused) {
    const key = `${pause.project}::${pause.path}`;
    const agent = agents.get(key) ?? {
      key, project: pause.project, path: pause.path,
      name: pause.path.replace(/\.agentuse$/, '').split('/').pop() ?? pause.path,
      rows: [],
    };
    agent.autoPause = pause;
    agents.set(key, agent);
  }
  const latestAt = (a: BrokenAgent) => a.latest ? at(a.latest) : a.autoPause?.at ?? 0;
  return [...agents.values()].sort((a, b) =>
    Number(Boolean(b.autoPause)) - Number(Boolean(a.autoPause)) || b.rows.length - a.rows.length || latestAt(b) - latestAt(a));
}

export function BrokenAgentRow(props: { agent: BrokenAgent; actions?: ComponentChildren }) {
  const { agent } = props;
  const latestAt = agent.latest ? agent.latest.updatedAt || agent.latest.createdAt : agent.autoPause?.at;
  const message = agent.autoPause ? agent.autoPause.reason : errorText(agent.latest?.errorMessage);
  const source = agent.latest?.errorCauseSource;
  const runsHref = `/sessions?${new URLSearchParams({ agent: agent.name, status: 'error', who: 'all' }).toString()}`;
  return (
    <div class={`broken-row${agent.autoPause ? ' is-paused' : ''}`}>
      <span class="feed-dot failed" aria-hidden="true"></span>
      <span class="broken-count">{agent.autoPause ? 'paused' : plural(agent.rows.length, 'run')}</span>
      <div class="broken-body">
        <div class="broken-head">
          {agent.label && <span class="broken-kind">{agent.label}</span>}
          <span class="broken-subject">{agent.name}</span>
          {latestAt !== undefined && (
            <span class="broken-meta" title={formatApprovalTime(latestAt)}>
              {agent.autoPause ? `schedule paused itself ${formatRelativeTime(latestAt)}` : `last ${formatRelativeTime(latestAt)}`}
            </span>
          )}
        </div>
        {message && (
          <div class="broken-fix">
            {/* How sure the reason is: seen by the runtime, or the agent's own words. */}
            {!agent.autoPause && source && <span class={`broken-source source-${source}`}>{SOURCE_LABELS[source] ?? source}</span>}
            <span class="broken-message">{message}</span>
          </div>
        )}
      </div>
      <div class="broken-actions">
        {props.actions}
        {agent.latest && <a class="broken-review" href={sessionDestinationHref(agent.latest)}>latest run</a>}
        <a class="broken-review" href={runsHref}>see runs →</a>
      </div>
    </div>
  );
}

/** An agent on a running schedule that stopped delivering: usual pace against
 *  the current gap, with one square per day so the drop is visible. */
export function QuietAgentRow(props: { agent: DeliveryPaceAgent; now: number }) {
  const { agent, now } = props;
  const { pace } = agent;
  const href = `/sessions?${new URLSearchParams({ agent: agent.name, who: 'all' }).toString()}`;
  return (
    <div class="broken-row quiet-row">
      <span class="quiet-dot" aria-hidden="true"></span>
      <span class="broken-count quiet-count">quiet</span>
      <div class="broken-body">
        <div class="broken-head">
          <span class="broken-subject">{agent.name}</span>
          <span class="broken-meta">usually every {formatGap(pace.usualGapMs)} · last delivered {formatRelativeTime(pace.lastDeliveredAt)}</span>
        </div>
        <div class="broken-fix">
          <span class="broken-message">
            {pace.runsSinceDelivery > 0
              ? `${plural(pace.runsSinceDelivery, 'run')} since then, none delivered.`
              : `No runs since ${formatRelativeTime(pace.lastDeliveredAt, now)}.`}
          </span>
        </div>
        <span class="pace-strip" role="img" aria-label={`Deliveries per day, last ${pace.strip.length} days: ${pace.strip.join(', ')}`}>
          {pace.strip.map((n, i) => <span key={i} class={`pace-day${n > 0 ? ' on' : ''}`}></span>)}
        </span>
      </div>
      <div class="broken-actions">
        <a class="broken-review" href={href}>see runs →</a>
      </div>
    </div>
  );
}

function formatGap(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1.5) return 'hour';
  if (hours < 36) return `${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'day' : `${days} days`;
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
  return (
    <div class={`pending-agent-group${open ? ' is-open' : ''}`}>
      <PendingApprovalRow
        row={newest}
        now={now}
        {...(props.blockingRuns > 0 && { alert: `blocking ${plural(props.blockingRuns, 'run')}` })}
      />
      {older.length > 0 && (
        <div class="pending-agent-meta">
          <button type="button" class="pending-agent-toggle" aria-expanded={open} onClick={() => setOpen((on) => !on)}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
            {plural(older.length, 'older ask')}
          </button>
          {stale.length > 0 && props.rejectStale(stale)}
        </div>
      )}
      {open && (
        <div class="pending-older">
          {older.map((row) => <PendingApprovalRow key={`${row.project}:${row.sessionId}`} row={row} now={now} hideAgent />)}
        </div>
      )}
    </div>
  );
}
