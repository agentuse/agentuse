/**
 * Pure computation behind the approvals page: the headline lede, the per-agent
 * 30-day record, and what happened after each decision.
 *
 * Kept out of the route so every rule here is testable without a DOM, and so
 * the same numbers can be reused by another surface later without dragging a
 * component along.
 */

import type { ApprovalRow } from './api';
import { displayAgentName } from './format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A gate is "expiring soon" once it is inside this window. */
export const EXPIRES_SOON_MS = 6 * HOUR;
/** Inside this window the expiry pill turns red rather than amber. */
export const EXPIRES_URGENT_MS = HOUR;
/** Reply latency at or above this reads as a problem, not a delay. */
export const SLOW_REPLY_MS = 24 * HOUR;

/** When the reviewer was first asked. `suspendedAt` is the gate itself; the
 *  session's creation is the fallback for older projections. */
export function askedAt(row: ApprovalRow): number | undefined {
  return row.suspendedAt ?? row.createdAt;
}

/** How long the reviewer took to answer, or undefined when either end is missing. */
export function replyLatency(row: ApprovalRow): number | undefined {
  const asked = askedAt(row);
  if (asked === undefined || row.decisionAt === undefined) return undefined;
  const diff = row.decisionAt - asked;
  return diff >= 0 ? diff : undefined;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Reply latency at reading size: "40m", "1h 05m", "2d 4h". Deliberately not
 * `formatApproximateDuration`, which rounds 1h 40m to "2h" — the difference
 * between a 20-minute and a 90-minute median is the whole point of the column.
 */
export function formatReplyDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / MINUTE));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin ? `${hr}h ${String(remMin).padStart(2, '0')}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr ? `${day}d ${remHr}h` : `${day}d`;
}

/** Compact age for the lede's "oldest 4d" and the expiry pill's "expires 3h". */
export function formatCompactAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / MINUTE));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export type ApprovalWindow = '7' | '30' | 'all';

/** How the window reads inside a sentence ("asked 6 this month"). */
export function windowLabel(window: ApprovalWindow): string {
  if (window === '7') return 'this week';
  if (window === '30') return 'this month';
  return 'all time';
}

/* ---------------- the headline lede ---------------- */

export interface PendingHeadline {
  waiting: number;
  agents: number;
  /** Age of the gate that has waited longest. */
  oldestMs?: number;
  /** Gates expiring inside EXPIRES_SOON_MS. */
  expiringSoon: number;
  /** Shortest time-to-expiry among those, so the lede can turn red under an hour. */
  soonestExpiryMs?: number;
}

export function pendingHeadline(rows: ApprovalRow[], now: number): PendingHeadline {
  const agents = new Set<string>();
  let oldestMs: number | undefined;
  let expiringSoon = 0;
  let soonestExpiryMs: number | undefined;

  for (const row of rows) {
    agents.add(`${row.project}:${displayAgentName(row.agentName, row.agentFilePath, row.agentId)}`);
    const asked = askedAt(row);
    if (asked !== undefined) {
      const age = now - asked;
      if (oldestMs === undefined || age > oldestMs) oldestMs = age;
    }
    if (row.expiresAt !== undefined) {
      const left = row.expiresAt - now;
      if (left >= 0 && left <= EXPIRES_SOON_MS) {
        expiringSoon += 1;
        if (soonestExpiryMs === undefined || left < soonestExpiryMs) soonestExpiryMs = left;
      }
    }
  }

  return {
    waiting: rows.length,
    agents: agents.size,
    ...(oldestMs !== undefined && { oldestMs }),
    expiringSoon,
    ...(soonestExpiryMs !== undefined && { soonestExpiryMs }),
  };
}

/** Decisions the reviewer made in the last seven days, for the lede's tally. */
export function decidedThisWeek(rows: ApprovalRow[], now: number): number {
  return rows.filter((row) => row.decisionAt !== undefined && now - row.decisionAt <= 7 * DAY).length;
}

/* ---------------- per-agent record ---------------- */

export interface AgentApprovalStats {
  key: string;
  name: string;
  project: string;
  agentFilePath?: string;
  asked: number;
  approved: number;
  rejected: number;
  missed: number;
  medianReplyMs?: number;
  waitingNow: number;
  lastAskedAt?: number;
}

function statusBucket(row: ApprovalRow): 'approved' | 'rejected' | 'missed' | 'pending' {
  switch (row.status) {
    case 'approved':
    case 'commented':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'expired':
    case 'errored':
      return 'missed';
    default:
      return 'pending';
  }
}

/**
 * Roll every gate in the loaded window up per agent: how often it asked, what
 * the reviewer tended to say, and how long they took. Sorted by volume, since
 * the question the table answers is "who asks most".
 */
export function agentApprovalStats(rows: ApprovalRow[]): AgentApprovalStats[] {
  const byAgent = new Map<string, AgentApprovalStats & { latencies: number[] }>();

  for (const row of rows) {
    const name = displayAgentName(row.agentName, row.agentFilePath, row.agentId);
    const key = `${row.project}:${name}`;
    let stats = byAgent.get(key);
    if (!stats) {
      stats = {
        key, name, project: row.project,
        ...(row.agentFilePath !== undefined && { agentFilePath: row.agentFilePath }),
        asked: 0, approved: 0, rejected: 0, missed: 0, waitingNow: 0, latencies: [],
      };
      byAgent.set(key, stats);
    }
    if (stats.agentFilePath === undefined && row.agentFilePath !== undefined) stats.agentFilePath = row.agentFilePath;

    stats.asked += 1;
    const bucket = statusBucket(row);
    if (bucket === 'pending') stats.waitingNow += 1;
    else stats[bucket] += 1;

    const latency = replyLatency(row);
    if (latency !== undefined && bucket !== 'missed') stats.latencies.push(latency);

    const asked = askedAt(row);
    if (asked !== undefined && (stats.lastAskedAt === undefined || asked > stats.lastAskedAt)) stats.lastAskedAt = asked;
  }

  return [...byAgent.values()]
    .map(({ latencies, ...stats }) => {
      const medianReplyMs = median(latencies);
      return medianReplyMs === undefined ? stats : { ...stats, medianReplyMs };
    })
    .sort((a, b) => b.asked - a.asked || a.name.localeCompare(b.name));
}

/** Look one agent's record up by the same key the pending groups use. */
export function statsByKey(stats: AgentApprovalStats[]): Map<string, AgentApprovalStats> {
  return new Map(stats.map((s) => [s.key, s]));
}

/** "asked 6 this month · you approved 3, rejected 2, missed 1" — omitting the
 *  outcomes that never happened, so a clean record reads clean. */
export function recordSentence(stats: AgentApprovalStats, window: ApprovalWindow): string {
  const parts: string[] = [];
  if (stats.approved > 0) parts.push(`approved ${stats.approved}`);
  if (stats.rejected > 0) parts.push(`rejected ${stats.rejected}`);
  if (stats.missed > 0) parts.push(`missed ${stats.missed}`);
  const asked = `asked ${stats.asked} ${windowLabel(window)}`;
  return parts.length > 0 ? `${asked} · you ${parts.join(', ')}` : asked;
}

/* ---------------- what happened after the call ---------------- */

export type ApprovalOutcome =
  /** The run picked straight back up and is still going. */
  | { kind: 'running'; sinceMs?: number }
  | { kind: 'completed' }
  | { kind: 'failed'; text?: string }
  /** Rejected: the agent never acted. */
  | { kind: 'stopped' }
  /** Commented, and the agent has come back with a new gate that is waiting above. */
  | { kind: 'revised'; anchor?: string }
  /** Expired: nobody answered in time. */
  | { kind: 'missed' };

const FAILED_SESSION = /^(error|failed|cancelled|canceled|timeout|timed_out)$/i;

/**
 * What the row should say under "What happened next".
 *
 * Decision-driven outcomes win over session status: a rejected gate stopped the
 * run by design, and its session ending is not news. Everything else reads the
 * run's own status.
 */
export function approvalOutcome(
  row: ApprovalRow,
  options: { now: number; revisedAnchor?: string | undefined } = { now: Date.now() },
): ApprovalOutcome {
  if (row.status === 'expired') return { kind: 'missed' };
  if (row.status === 'rejected') return { kind: 'stopped' };
  if (row.status === 'commented' && options.revisedAnchor !== undefined) {
    return { kind: 'revised', anchor: options.revisedAnchor };
  }

  const status = row.sessionStatus;
  if (status === 'running' || status === 'streaming' || status === 'executing' || status === 'active') {
    const since = row.decisionAt;
    return since === undefined ? { kind: 'running' } : { kind: 'running', sinceMs: Math.max(0, options.now - since) };
  }
  if (row.status === 'errored' || FAILED_SESSION.test(status)) {
    const text = row.errorMessage || row.errorCode;
    return text ? { kind: 'failed', text } : { kind: 'failed' };
  }
  if (row.status === 'commented') return { kind: 'revised' };
  return { kind: 'completed' };
}

/**
 * Sessions that are waiting again right now, keyed by session id, so a
 * commented gate can point at the fresh gate it produced instead of claiming
 * the run simply finished.
 */
export function pendingSessionIds(pending: ApprovalRow[]): Set<string> {
  return new Set(pending.map((row) => `${row.project}:${row.sessionId}`));
}

/**
 * Approvals name their agent by absolute file path; the agent hub and POST /run
 * both address it by the path relative to the served scope. Match by suffix
 * inside the same project, keeping the longest match when one run path is a
 * suffix of another (`x/a.agentuse` vs `a.agentuse`), the same rule the
 * schedules page uses to attach sessions to schedules.
 */
export function agentRunPathResolver(
  agents: Array<{ projectId: string; runPath: string }>,
): (projectId: string, filePath: string | undefined) => string | undefined {
  const byProject = new Map<string, string[]>();
  for (const agent of agents) {
    const list = byProject.get(agent.projectId);
    if (list) list.push(agent.runPath);
    else byProject.set(agent.projectId, [agent.runPath]);
  }
  return (projectId, filePath) => {
    if (!filePath) return undefined;
    let best: string | undefined;
    for (const runPath of byProject.get(projectId) ?? []) {
      if (filePath !== runPath && !filePath.endsWith(`/${runPath}`)) continue;
      if (!best || runPath.length > best.length) best = runPath;
    }
    return best;
  };
}

/**
 * `decisionReviewer` sometimes carries the surface the decision arrived on
 * ("web", "slack") rather than a person, which would render as "web · web".
 * Those read as the reviewer themselves; a real name is shown as given.
 */
const SURFACE_REVIEWERS = new Set(['web', 'slack', 'cli', 'api', 'ui', 'desktop', 'unknown']);

export function reviewerLabel(row: ApprovalRow): string {
  const name = row.decisionReviewer?.trim();
  if (!name || SURFACE_REVIEWERS.has(name.toLowerCase())) return 'you';
  return name;
}

/** Whether the decision came back through Slack rather than the web console. */
export function decidedViaSlack(row: ApprovalRow): boolean {
  if (row.decisionReviewer?.trim().toLowerCase() === 'slack') return true;
  if (row.channelMessage?.type?.toLowerCase().includes('slack')) return true;
  return (row.channels?.slack?.length ?? 0) > 0;
}
