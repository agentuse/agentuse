import type { Part, SessionInfo } from './types';

export interface SessionTimingSummary {
  calculatedAt: number;
  /** Root-session wall clock, including time parked at human gates. */
  wallMs: number;
  /** Wall clock with all human-approval intervals removed. */
  activeMs: number;
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
 * Split one root run's wall time into active execution and human approval wait.
 * Descendant gates participate because a manager is suspended while its leaf
 * waits. Intervals are unioned so concurrent gates never double-count time.
 */
export function summarizeSessionTiming(
  root: SessionInfo,
  evidence: SessionEvidence[],
  now = Date.now()
): SessionTimingSummary {
  const start = root.time.created;
  const terminal = root.status === 'completed' || root.status === 'error';
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
    calculatedAt: now,
    wallMs,
    activeMs: Math.max(0, wallMs - approvalMs),
    approvalMs,
    approvalCount,
  };
}
