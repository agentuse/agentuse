import type { SessionStatus } from './types.js';
import { isHumanBlocker } from './blocker.js';

/** Lifecycle statuses and derived outcomes exposed as session-list filters. */
export const SESSION_STATUS_FILTERS: readonly ('' | SessionStatus | 'idle' | 'incomplete')[] = [
  '',
  'preparing',
  'running',
  'suspended',
  'completed',
  'idle',
  'error',
  'incomplete',
];

/** Runtime and transport projections that mean model work is still active. */
export function isExecutingSessionStatus(status: string | undefined): boolean {
  return status === 'preparing'
    || status === 'running'
    || status === 'resuming'
    || status === 'continuing'
    || status === 'run';
}

/** A durable session whose result can no longer change without an explicit retry. */
export function isTerminalSessionStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'error';
}

/** Terminal labels sometimes arrive after an API/UI projection rather than as durable state. */
export function isProjectedTerminalSessionStatus(status: string | undefined): boolean {
  return isTerminalSessionStatus(status)
    || status === 'expired'
    || status === 'failed'
    || status === 'stopped'
    || status === 'timeout'
    || status === 'incomplete';
}

/** Operator-facing live work includes human gates as well as execution. */
export function isLiveSessionStatus(status: string | undefined): boolean {
  return isExecutingSessionStatus(status) || status === 'suspended' || status === 'waiting';
}

/**
 * An agent-declared non-delivery that is not an error: the run finished cleanly
 * and said it could not deliver because of a person (waiting on or rejected by
 * one). Persisted as an error carrying the INCOMPLETE code plus the blocker kind
 * in `cause`. Every other INCOMPLETE blocker (a missing tool, a bad input, no
 * access, or none recorded) means something is broken, so it reads as an error.
 * Operator surfaces separate the two through this one definition.
 */
export function isIncompleteOutcome(
  status: string | undefined,
  errorCode: string | undefined,
  errorCause: string | undefined,
): boolean {
  return status === 'error' && errorCode === 'INCOMPLETE' && isHumanBlocker(errorCause);
}

export type SessionOutcome = 'completed' | 'error' | 'stopped' | 'timeout' | 'incomplete';

/** Normalize durable status plus error code before each transport chooses its wording. */
export function sessionOutcome(
  status: string | undefined,
  errorCode: string | undefined,
  errorCause: string | undefined,
): SessionOutcome | undefined {
  if (status === 'completed') return 'completed';
  if (status !== 'error') return undefined;
  if (errorCode === 'USER_STOPPED') return 'stopped';
  if (errorCode === 'TIMEOUT') return 'timeout';
  if (isIncompleteOutcome(status, errorCode, errorCause)) return 'incomplete';
  return 'error';
}
