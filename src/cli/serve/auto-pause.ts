import { BLOCKER_LABELS, isBlockerKind, isHumanBlocker, repeatFailureKey } from '../../session/blocker';
import { failureLabel } from '../../session/failure-label';
import type { SessionSummary } from './list-payloads';

/**
 * Stop on repeat. A scheduled agent that fails the same way twice in a row
 * will fail that way again on every run until something is fixed, so each
 * further run only adds a row nobody can act on. The daemon pauses its
 * schedule instead, says why, and the person resumes it once it is fixed.
 */

/**
 * Hold on a stack. A scheduled agent that already has this many approvals
 * waiting does not start another run: each new run would only add one more
 * ask to the pile, and asks that pile up expire unread. Its schedule stays
 * on and the next run goes ahead once the stack is below this.
 */
export const APPROVAL_STACK_LIMIT = 3;

/** A schedule held because too many of its approvals are waiting. */
export interface ApprovalHold {
  at: number;
  pending: number;
}

/** How far back the run before this one is looked for: past a monthly schedule. */
export const REPEAT_FAILURE_LOOKBACK_MS = 35 * 24 * 3_600_000;

/** Why a schedule was paused by the daemon rather than by a person. */
export interface AutoPause {
  at: number;
  /** One line a person can read: what failed, twice. */
  reason: string;
  /** The run that failed the second time. */
  sessionId: string;
}

type Run = Pick<SessionSummary, 'sessionId' | 'status' | 'trigger' | 'createdAt' | 'agent' | 'errorCause' | 'errorSubject' | 'errorCode' | 'errorMessage' | 'mock'>;

/** A failure a person did not cause and that is not waiting on one. */
function isRepeatableFailure(run: Run): boolean {
  return run.status === 'error' && !isHumanBlocker(run.errorCause) && run.errorCode !== 'USER_STOPPED';
}

function describeFailure(run: Run): string {
  if (isBlockerKind(run.errorCause) && run.errorSubject) return `${BLOCKER_LABELS[run.errorCause]}: ${run.errorSubject}`;
  return failureLabel(run.errorCause) ?? run.errorMessage ?? run.errorCode ?? 'an error';
}

/**
 * Given one agent's runs: the scheduled run that started at or after
 * `startedAt`, when it and the scheduled run before it both failed the same
 * way. Manual, mock and sub-agent runs are not part of the sequence.
 */
export function findRepeatFailure(agentRuns: Run[], startedAt: number): AutoPause | undefined {
  const scheduled = agentRuns
    .filter((run) => run.trigger === 'scheduled' && !run.mock && !run.agent.isSubAgent)
    .sort((a, b) => b.createdAt - a.createdAt);
  const [latest, previous] = scheduled;
  if (!latest || !previous || latest.createdAt < startedAt) return undefined;
  if (!isRepeatableFailure(latest) || !isRepeatableFailure(previous)) return undefined;
  if (repeatFailureKey(latest) !== repeatFailureKey(previous)) return undefined;
  return {
    at: Date.now(),
    reason: `Failed the same way twice in a row: ${describeFailure(latest)}`,
    sessionId: latest.sessionId,
  };
}
