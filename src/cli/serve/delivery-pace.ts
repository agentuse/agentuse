import { isHumanBlocker } from '../../session/blocker';
import type { SessionSummary } from './list-payloads';

/**
 * Gone quiet. An agent that used to deliver and has stopped is the failure
 * nobody sees: its runs may "succeed" with nothing to show, end incomplete,
 * or stop happening at all, and none of that lands on a failure list. So
 * watch deliveries instead of runs: learn each agent's usual gap between
 * deliveries and flag it once the current gap is several times that.
 */

const DAY = 24 * 3_600_000;

/** Current gap this many times the usual one reads as quiet. */
export const QUIET_GAP_FACTOR = 3;
/** Fewer deliveries than this in the window is no pattern to compare with. */
export const MIN_DELIVERIES_FOR_PACE = 3;
/** Days shown in a delivery strip, newest last. */
export const PACE_STRIP_DAYS = 14;

export interface AgentPace {
  lastDeliveredAt: number;
  /** Median time between deliveries in the window. */
  usualGapMs: number;
  deliveries: number;
  /** Runs that started after the last delivery. */
  runsSinceDelivery: number;
  /** Deliveries per day for the last PACE_STRIP_DAYS days, oldest first. */
  strip: number[];
  quiet: boolean;
}

type Run = Pick<SessionSummary, 'status' | 'outcome' | 'createdAt' | 'updatedAt' | 'mock' | 'agent' | 'errorCause' | 'errorCode'>;

/**
 * Whether an agent's newest run failed, as opposed to an older failure it has
 * since recovered from. A run that stopped on a person (waiting, rejected,
 * stopped by them, or a gate nobody answered) is not a failure of the agent.
 * Undefined when the agent has no finished run.
 */
export function latestRunFailed(runs: Run[]): { at: number; failed: boolean } | undefined {
  const latest = runs
    .filter((run) => !run.mock && !run.agent.isSubAgent && (run.status === 'completed' || run.status === 'error'))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest) return undefined;
  const failed = latest.status === 'error'
    && !isHumanBlocker(latest.errorCause)
    && latest.errorCode !== 'USER_STOPPED'
    && latest.errorCode !== 'APPROVAL_TIMEOUT';
  return { at: latest.updatedAt || latest.createdAt, failed };
}

/** A run that ended having produced something: complete, and not "nothing to do". */
export function isDelivery(run: Run): boolean {
  return run.status === 'completed' && run.outcome !== 'idle';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * One agent's pace from its runs, or undefined when it has not delivered
 * often enough to have one. `now` is when the gap is measured to.
 */
export function agentPace(runs: Run[], now: number): AgentPace | undefined {
  const own = runs.filter((run) => !run.mock && !run.agent.isSubAgent);
  const deliveredAt = own.filter(isDelivery).map((run) => run.updatedAt || run.createdAt).sort((a, b) => a - b);
  if (deliveredAt.length < MIN_DELIVERIES_FOR_PACE) return undefined;
  const gaps = deliveredAt.slice(1).map((at, i) => at - deliveredAt[i]!).filter((gap) => gap > 0);
  if (gaps.length === 0) return undefined;
  const usualGapMs = median(gaps);
  const lastDeliveredAt = deliveredAt[deliveredAt.length - 1]!;
  const runsSinceDelivery = own.filter((run) => run.createdAt > lastDeliveredAt).length;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const strip = Array.from({ length: PACE_STRIP_DAYS }, (_, i) => {
    const from = startOfToday - (PACE_STRIP_DAYS - 1 - i) * DAY;
    return deliveredAt.filter((at) => at >= from && at < from + DAY).length;
  });
  return {
    lastDeliveredAt,
    usualGapMs,
    deliveries: deliveredAt.length,
    runsSinceDelivery,
    strip,
    quiet: now - lastDeliveredAt > QUIET_GAP_FACTOR * usualGapMs,
  };
}
