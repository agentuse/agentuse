import type { Part, SessionInfo } from './types';
import { isTerminalSessionStatus } from './status';

export interface SessionTimingSummary extends ActiveTiming {
  /** Root-session wall clock, including time parked at human gates. */
  wallMs: number;
  /** Union of human-approval intervals across the root and descendants. */
  approvalMs: number;
  approvalCount: number;
}

type SessionEvidence = {
  session: SessionInfo;
  parts: Part[];
};

type Interval = { start: number; end: number };

function approvalInterval(part: Part, now: number): Interval | undefined {
  if (part.type !== 'tool' || part.tool !== 'await_human' || part.superseded) return undefined;
  const state = part.state;
  if (state.status === 'pending') {
    const start = state.suspendedAt;
    return typeof start === 'number' && now >= start ? { start, end: now } : undefined;
  }
  if (state.status === 'running') {
    const start = state.time.start;
    return now >= start ? { start, end: now } : undefined;
  }
  const { start, end } = state.time;
  return typeof start === 'number' && typeof end === 'number' && end >= start
    ? { start, end }
    : undefined;
}

function unionDuration(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current = sorted[0]!;
  for (const next of sorted.slice(1)) {
    if (next.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, next.end) };
      continue;
    }
    total += current.end - current.start;
    current = next;
  }
  return total + current.end - current.start;
}

/**
 * Report recorded active execution alongside wall time and human approval wait.
 * Descendant gates participate because a manager is suspended while its leaf
 * waits. Intervals are unioned so concurrent gates never double-count time.
 */
export function summarizeSessionTiming(
  root: SessionInfo,
  evidence: SessionEvidence[],
  now = Date.now()
): SessionTimingSummary {
  const start = root.time.created;
  const terminal = isTerminalSessionStatus(root.status);
  const end = Math.max(start, terminal ? root.time.updated : now);
  const intervals: Interval[] = [];
  let approvalCount = 0;

  for (const item of evidence) {
    for (const part of item.parts) {
      const interval = approvalInterval(part, now);
      if (!interval) continue;
      const clamped = {
        start: Math.max(start, interval.start),
        end: Math.min(end, interval.end),
      };
      if (clamped.end < clamped.start) continue;
      intervals.push(clamped);
      approvalCount++;
    }
  }

  const wallMs = end - start;
  const approvalMs = Math.min(wallMs, unionDuration(intervals));
  return {
    wallMs,
    ...activeTimingForTree(root.id, [sessionTimingRow(root), ...evidence.filter(item => item.session.id !== root.id).map(item => sessionTimingRow(item.session))], now),
    approvalMs,
    approvalCount,
  };
}

export interface ActiveTiming {
  calculatedAt: number;
  /** Union of recorded execution intervals, or null for historical sessions. */
  activeMs: number | null;
  running: boolean;
}

type TimingRow = {
  sessionId: string;
  parentSessionId?: string | undefined;
  status: string;
  createdAt: number;
  updatedAt: number;
  execution?: Array<{ start: number; end?: number }> | undefined;
};

/** Persist only status transitions. Metadata writes never restart the clock. */
export function transitionExecution(session: SessionInfo, status: SessionInfo['status'] | undefined, now: number): void {
  if (!status || status === session.status || !session.time.execution) return;
  const last = session.time.execution.at(-1);
  if (last && last.end === undefined) last.end = Math.max(last.start, now);
  if (status === 'running') session.time.execution.push({ start: now });
}

/** One clock for lists, details and CLI. Parallel descendants count once. */
export function activeTimingForTree(rootId: string, rows: TimingRow[], now = Date.now()): ActiveTiming {
  const byId = new Map(rows.map(row => [row.sessionId, row]));
  const root = byId.get(rootId);
  if (!root) return { calculatedAt: now, activeMs: null, running: false };
  const end = isTerminalSessionStatus(root.status) ? root.updatedAt : now;
  const intervals: Interval[] = [];
  let known = true;
  let running = false;
  for (const row of rows) {
    let current: TimingRow | undefined = row;
    const seen = new Set<string>();
    while (current && current.sessionId !== rootId && !seen.has(current.sessionId)) {
      seen.add(current.sessionId);
      current = current.parentSessionId ? byId.get(current.parentSessionId) : undefined;
    }
    if (current?.sessionId !== rootId) continue;
    if (!row.execution) known = false;
    for (const interval of row.execution ?? []) {
      const open = interval.end === undefined && row.status === 'running';
      const start = Math.max(root.createdAt, interval.start);
      const stop = Math.min(end, interval.end ?? (open ? now : row.updatedAt));
      if (stop >= start) intervals.push({ start, end: stop });
      if (open && !isTerminalSessionStatus(root.status)) running = true;
    }
  }
  return { calculatedAt: now, activeMs: known ? unionDuration(intervals) : null, running };
}

export function sessionTimingRow(session: SessionInfo): TimingRow {
  return { sessionId: session.id, parentSessionId: session.parentSessionID, status: session.status,
    createdAt: session.time.created, updatedAt: session.time.updated, execution: session.time.execution };
}

/** Advance a server snapshot only while execution is active. Never infer from age. */
export function activeDuration(timing: ActiveTiming | undefined, now = Date.now()): number | null {
  if (timing?.activeMs == null) return null;
  return timing.activeMs + (timing.running ? Math.max(0, now - timing.calculatedAt) : 0);
}

/** Group descendants before calculating, avoiding a full-history scan per list row. */
export function activeTimingsForForest(rows: TimingRow[], now = Date.now()): Map<string, ActiveTiming> {
  const byId = new Map(rows.map(row => [row.sessionId, row]));
  const groups = new Map<string, TimingRow[]>();
  for (const row of rows) {
    let current: TimingRow | undefined = row;
    const seen = new Set<string>();
    while (current && !seen.has(current.sessionId)) {
      seen.add(current.sessionId);
      const group = groups.get(current.sessionId) ?? [];
      group.push(row);
      groups.set(current.sessionId, group);
      current = current.parentSessionId ? byId.get(current.parentSessionId) : undefined;
    }
  }
  return new Map(rows.map(row => [row.sessionId, activeTimingForTree(row.sessionId, groups.get(row.sessionId)!, now)]));
}
