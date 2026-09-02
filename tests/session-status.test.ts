import { describe, expect, it } from 'bun:test';
import {
  isExecutingSessionStatus,
  isLiveSessionStatus,
  isProjectedTerminalSessionStatus,
  isTerminalSessionStatus,
  sessionOutcome,
  SESSION_STATUS_FILTERS,
} from '../src/session/status';

describe('shared session status semantics', () => {
  it('exposes every durable status in the session filter', () => {
    expect(SESSION_STATUS_FILTERS).toEqual([
      '', 'preparing', 'running', 'suspended', 'completed', 'error', 'incomplete',
    ]);
  });

  it('keeps execution, operator-live, and terminal meanings distinct', () => {
    expect(isExecutingSessionStatus('preparing')).toBe(true);
    expect(isExecutingSessionStatus('continuing')).toBe(true);
    expect(isExecutingSessionStatus('resuming')).toBe(true);
    expect(isExecutingSessionStatus('suspended')).toBe(false);
    expect(isLiveSessionStatus('suspended')).toBe(true);
    expect(isTerminalSessionStatus('completed')).toBe(true);
    expect(isTerminalSessionStatus('error')).toBe(true);
    expect(isTerminalSessionStatus('running')).toBe(false);
    expect(isProjectedTerminalSessionStatus('timeout')).toBe(true);
    expect(sessionOutcome('error', 'TIMEOUT')).toBe('timeout');
    expect(sessionOutcome('error', 'USER_STOPPED')).toBe('stopped');
  });
});
