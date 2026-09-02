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

/** Operator-facing live work includes human gates as well as execution. */
export function isLiveSessionStatus(status: string | undefined): boolean {
  return isExecutingSessionStatus(status) || status === 'suspended' || status === 'waiting';
}
