import { describe, expect, it } from 'bun:test';
import { agentPace, isDelivery, latestRunFailed, PACE_STRIP_DAYS } from '../src/cli/serve/delivery-pace';
import type { SessionSummary } from '../src/cli/serve/list-payloads';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-30T12:00:00').getTime();

function run(at: number, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: `s${at}`,
    agent: { id: 'scout', name: 'Reddit Scout', filePath: '/p/scout.agentuse' },
    status: 'completed',
    outcome: 'complete',
    trigger: 'scheduled',
    createdAt: at - 60_000,
    updatedAt: at,
    ...over,
  } as SessionSummary;
}

/** A daily delivery for `days` days, ending `lastDaysAgo` days before NOW. */
function daily(days: number, lastDaysAgo: number): SessionSummary[] {
  return Array.from({ length: days }, (_, i) => run(NOW - (lastDaysAgo + i) * DAY));
}

describe('delivery pace', () => {
  it('counts only completed runs that produced something as deliveries', () => {
    expect(isDelivery(run(NOW))).toBe(true);
    expect(isDelivery(run(NOW, { outcome: 'idle' }))).toBe(false);
    expect(isDelivery(run(NOW, { status: 'error' }))).toBe(false);
  });

  it('is quiet once the current gap is more than three usual gaps', () => {
    expect(agentPace(daily(10, 2), NOW)?.quiet).toBe(false);
    const pace = agentPace(daily(10, 4), NOW)!;
    expect(pace.quiet).toBe(true);
    expect(pace.usualGapMs).toBe(DAY);
    expect(pace.lastDeliveredAt).toBe(NOW - 4 * DAY);
  });

  it('counts runs since the last delivery, including empty and failed ones', () => {
    const runs = [
      ...daily(10, 4),
      run(NOW - 3 * DAY, { outcome: 'idle' }),
      run(NOW - 2 * DAY, { status: 'error' }),
      run(NOW - DAY, { outcome: 'idle' }),
    ];
    const pace = agentPace(runs, NOW)!;
    expect(pace.runsSinceDelivery).toBe(3);
    expect(pace.quiet).toBe(true);
  });

  it('has no pace without a few deliveries to learn it from', () => {
    expect(agentPace(daily(2, 0), NOW)).toBeUndefined();
    expect(agentPace([run(NOW, { outcome: 'idle' }), run(NOW - DAY, { outcome: 'idle' })], NOW)).toBeUndefined();
  });

  it('ignores mock and sub-agent runs', () => {
    expect(agentPace(daily(5, 0).map((r) => ({ ...r, mock: true })), NOW)).toBeUndefined();
  });

  it('draws one count per day for the strip, oldest first', () => {
    const pace = agentPace(daily(10, 4), NOW)!;
    expect(pace.strip).toHaveLength(PACE_STRIP_DAYS);
    expect(pace.strip.slice(-4)).toEqual([0, 0, 0, 0]);
    expect(pace.strip.slice(-14, -4)).toEqual(Array(10).fill(1));
  });
});

describe('latest run failed', () => {
  it('looks only at the newest finished run, so a recovered agent is not broken', () => {
    expect(latestRunFailed([run(NOW - DAY, { status: 'error' }), run(NOW)])).toEqual({ at: NOW, failed: false });
    expect(latestRunFailed([run(NOW - DAY), run(NOW, { status: 'error' })])?.failed).toBe(true);
    expect(latestRunFailed([run(NOW, { status: 'running' })])).toBeUndefined();
  });

  it('does not call a run that stopped on a person a failure', () => {
    for (const person of [
      { errorCause: 'waiting_on_human' },
      { errorCause: 'rejected_by_human' },
      { errorCode: 'USER_STOPPED' },
      { errorCode: 'APPROVAL_TIMEOUT' },
    ]) {
      expect(latestRunFailed([run(NOW, { status: 'error', ...person })])?.failed).toBe(false);
    }
  });
});
