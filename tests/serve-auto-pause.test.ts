import { describe, expect, it } from 'bun:test';
import { findRepeatFailure } from '../src/cli/serve/auto-pause';
import type { SessionSummary } from '../src/cli/serve/list-payloads';

const START = 1_800_000_000_000;
const HOUR = 3_600_000;

function run(over: Partial<SessionSummary> & { createdAt: number }): SessionSummary {
  return {
    sessionId: `s${over.createdAt}`,
    agent: { id: 'backup', name: 'Obsidian Vault Backup', filePath: '/p/backup.agentuse' },
    status: 'error',
    trigger: 'scheduled',
    updatedAt: over.createdAt,
    ...over,
  } as SessionSummary;
}

const noAccess = { errorCause: 'no_access', errorSubject: '~/Library/Mobile Documents/vault' };

describe('stop on repeat', () => {
  it('pauses when this run and the scheduled run before it hit the same blocker', () => {
    const pause = findRepeatFailure([
      run({ createdAt: START - HOUR, ...noAccess }),
      run({ createdAt: START + 10, ...noAccess, errorSubject: ' ~/Library/Mobile Documents/VAULT ' }),
    ], START);
    expect(pause?.sessionId).toBe(`s${START + 10}`);
    expect(pause?.reason).toBe('Failed the same way twice in a row: No access:  ~/Library/Mobile Documents/VAULT ');
  });

  it('compares failures with no named blocker by cause or error code', () => {
    expect(findRepeatFailure([
      run({ createdAt: START - HOUR, errorCode: 'PROVIDER_ERROR', errorMessage: 'Bad Request' }),
      run({ createdAt: START, errorCode: 'PROVIDER_ERROR', errorMessage: 'Bad Request' }),
    ], START)).toBeDefined();
    expect(findRepeatFailure([
      run({ createdAt: START - HOUR, errorCode: 'TIMEOUT' }),
      run({ createdAt: START, errorCode: 'PROVIDER_ERROR' }),
    ], START)).toBeUndefined();
  });

  it('does not pause on one failure, on a run that worked in between, or on different blockers', () => {
    expect(findRepeatFailure([run({ createdAt: START, ...noAccess })], START)).toBeUndefined();
    expect(findRepeatFailure([
      run({ createdAt: START - 2 * HOUR, ...noAccess }),
      run({ createdAt: START - HOUR, status: 'completed' }),
      run({ createdAt: START, ...noAccess }),
    ], START)).toBeUndefined();
    expect(findRepeatFailure([
      run({ createdAt: START - HOUR, ...noAccess }),
      run({ createdAt: START, errorCause: 'service_down', errorSubject: 'arctic shift' }),
    ], START)).toBeUndefined();
  });

  it('never pauses for a person: waiting on one, rejected by one, or stopped by one', () => {
    for (const person of [
      { errorCause: 'waiting_on_human', errorSubject: 'gate' },
      { errorCause: 'rejected_by_human', errorSubject: 'gate' },
      { errorCode: 'USER_STOPPED' },
    ]) {
      expect(findRepeatFailure([
        run({ createdAt: START - HOUR, ...person }),
        run({ createdAt: START, ...person }),
      ], START)).toBeUndefined();
    }
  });

  it('counts only scheduled runs, and only when the newest one is this run', () => {
    // A manual test run in between is not part of the schedule's sequence.
    expect(findRepeatFailure([
      run({ createdAt: START - 2 * HOUR, ...noAccess }),
      run({ createdAt: START - HOUR, trigger: 'manual', status: 'completed' }),
      run({ createdAt: START, ...noAccess }),
    ], START)).toBeDefined();
    // Both failures happened before this run started: not this run's call.
    expect(findRepeatFailure([
      run({ createdAt: START - 2 * HOUR, ...noAccess }),
      run({ createdAt: START - HOUR, ...noAccess }),
    ], START)).toBeUndefined();
    expect(findRepeatFailure([
      run({ createdAt: START - HOUR, ...noAccess, mock: true }),
      run({ createdAt: START, ...noAccess, mock: true }),
    ], START)).toBeUndefined();
  });
});
