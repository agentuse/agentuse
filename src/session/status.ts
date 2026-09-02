import type { SessionStatus } from './types.js';

/** Durable statuses exposed as exact session-list filters. */
export const SESSION_STATUS_FILTERS: readonly ('' | SessionStatus | 'incomplete')[] = [
  '',
  'preparing',
  'running',
  'suspended',
  'completed',
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

export type SessionOutcome = 'completed' | 'error' | 'stopped' | 'timeout' | 'incomplete';

/** Normalize durable status plus error code before each transport chooses its wording. */
export function sessionOutcome(
  status: string | undefined,
  errorCode?: string | undefined,
): SessionOutcome | undefined {
  if (status === 'completed') return 'completed';
  if (status !== 'error') return undefined;
  if (errorCode === 'USER_STOPPED') return 'stopped';
  if (errorCode === 'TIMEOUT') return 'timeout';
  if (errorCode === 'INCOMPLETE') return 'incomplete';
  return 'error';
}
