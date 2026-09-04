import { describe, it, expect } from 'bun:test';
import type { ApprovalRow } from '../src/cli/serve/web/lib/api';
import {
  agentApprovalStats,
  agentRunPathResolver,
  approvalOutcome,
  decidedThisWeek,
  decidedViaSlack,
  formatCompactAge,
  formatReplyDuration,
  median,
  pendingHeadline,
  pendingSessionIds,
  recordSentence,
  replyLatency,
  reviewerLabel,
  statsByKey,
} from '../src/cli/serve/web/lib/approval-stats';
import { expiresSoon, groupPendingByAgent, pendingGroupId } from '../src/cli/serve/web/components/pending-approval-card';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function row(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    project: 'demo',
    sessionId: 's1',
    agentId: 'agents-x-outreach',
    agentName: '',
    agentFilePath: '/root/agents/x/x-outreach.agentuse',
    status: 'pending',
    sessionStatus: 'suspended',
    ...over,
  } as ApprovalRow;
}

describe('reply latency', () => {
  it('measures from the gate, falling back to session creation', () => {
    expect(replyLatency(row({ suspendedAt: NOW - HOUR, decisionAt: NOW }))).toBe(HOUR);
    expect(replyLatency(row({ createdAt: NOW - 2 * HOUR, decisionAt: NOW }))).toBe(2 * HOUR);
  });

  it('drops rows with a missing end or a negative span rather than inventing a zero', () => {
    expect(replyLatency(row({ suspendedAt: NOW - HOUR }))).toBeUndefined();
    expect(replyLatency(row({ decisionAt: NOW }))).toBeUndefined();
    expect(replyLatency(row({ suspendedAt: NOW, decisionAt: NOW - HOUR }))).toBeUndefined();
  });

  it('takes the middle value, averaging the two middles on an even count', () => {
    expect(median([])).toBeUndefined();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('duration formatting', () => {
  it('keeps minutes visible up to a day, then switches to days', () => {
    expect(formatReplyDuration(40 * MIN)).toBe('40m');
    expect(formatReplyDuration(HOUR + 5 * MIN)).toBe('1h 05m');
    expect(formatReplyDuration(2 * HOUR)).toBe('2h');
    expect(formatReplyDuration(2 * DAY + 4 * HOUR)).toBe('2d 4h');
  });

  it('rounds ages down to one unit', () => {
    expect(formatCompactAge(3 * HOUR)).toBe('3h');
    expect(formatCompactAge(4 * DAY)).toBe('4d');
    expect(formatCompactAge(30 * MIN)).toBe('30m');
  });
});

describe('pendingHeadline', () => {
  it('counts agents, the longest wait, and gates about to lapse', () => {
    const head = pendingHeadline([
      row({ sessionId: 'a', suspendedAt: NOW - 4 * DAY, expiresAt: NOW + 3 * HOUR }),
      row({ sessionId: 'b', agentFilePath: '/root/agents/li/linkedin.agentuse', suspendedAt: NOW - 5 * HOUR }),
      row({ sessionId: 'c', agentFilePath: '/root/agents/li/linkedin.agentuse', suspendedAt: NOW - HOUR, expiresAt: NOW + 12 * HOUR }),
    ], NOW);

    expect(head.waiting).toBe(3);
    expect(head.agents).toBe(2);
    expect(head.oldestMs).toBe(4 * DAY);
    // Only the 3h deadline is inside the six-hour window.
    expect(head.expiringSoon).toBe(1);
    expect(head.soonestExpiryMs).toBe(3 * HOUR);
  });

  it('reports nothing waiting without inventing an oldest gate', () => {
    const head = pendingHeadline([], NOW);
    expect(head).toEqual({ waiting: 0, agents: 0, expiringSoon: 0 });
  });

  it('counts only decisions inside the last seven days', () => {
    expect(decidedThisWeek([
      row({ decisionAt: NOW - 2 * DAY }),
      row({ decisionAt: NOW - 10 * DAY }),
      row({}),
    ], NOW)).toBe(1);
  });
});

describe('agentApprovalStats', () => {
  const rows = [
    row({ sessionId: 'p1', status: 'pending', suspendedAt: NOW - 4 * DAY }),
    row({ sessionId: 'a1', status: 'approved', suspendedAt: NOW - 5 * DAY, decisionAt: NOW - 5 * DAY + 20 * MIN }),
    row({ sessionId: 'a2', status: 'commented', suspendedAt: NOW - 6 * DAY, decisionAt: NOW - 6 * DAY + 40 * MIN }),
    row({ sessionId: 'r1', status: 'rejected', suspendedAt: NOW - 7 * DAY, decisionAt: NOW - 7 * DAY + 60 * MIN }),
    row({ sessionId: 'x1', status: 'expired', suspendedAt: NOW - 8 * DAY, decisionAt: NOW - 8 * DAY + 5 * DAY }),
    row({ sessionId: 'o1', agentFilePath: '/root/agents/li/linkedin.agentuse', status: 'approved', suspendedAt: NOW - DAY, decisionAt: NOW - DAY + 10 * MIN }),
  ];

  it('rolls each agent up and sorts by how often it asks', () => {
    const stats = agentApprovalStats(rows);
    expect(stats.map((s) => s.name)).toEqual(['x-outreach', 'linkedin']);

    const outreach = stats[0]!;
    expect(outreach.asked).toBe(5);
    expect(outreach.approved).toBe(2);
    expect(outreach.rejected).toBe(1);
    expect(outreach.missed).toBe(1);
    expect(outreach.waitingNow).toBe(1);
    expect(outreach.lastAskedAt).toBe(NOW - 4 * DAY);
    // 20m, 40m, 60m — the expired gate's five-day "latency" is not a reply.
    expect(outreach.medianReplyMs).toBe(40 * MIN);
  });

  it('keys by project and agent so the pending groups can look a record up', () => {
    const index = statsByKey(agentApprovalStats(rows));
    const group = groupPendingByAgent(rows.filter((r) => r.status === 'pending'))[0]!;
    expect(index.get(group.key)?.asked).toBe(5);
  });

  it('writes the record sentence without the outcomes that never happened', () => {
    const [outreach, linkedin] = agentApprovalStats(rows);
    expect(recordSentence(outreach!, '30')).toBe('asked 5 this month · you approved 2, rejected 1, missed 1');
    expect(recordSentence(linkedin!, '7')).toBe('asked 1 this week · you approved 1');
  });
});

describe('approvalOutcome', () => {
  it('lets the decision speak before the session status', () => {
    expect(approvalOutcome(row({ status: 'expired', sessionStatus: 'error' }), { now: NOW })).toEqual({ kind: 'missed' });
    expect(approvalOutcome(row({ status: 'rejected', sessionStatus: 'completed' }), { now: NOW })).toEqual({ kind: 'stopped' });
  });

  it('points a commented gate at the fresh gate it produced', () => {
    expect(approvalOutcome(row({ status: 'commented', sessionStatus: 'suspended' }), { now: NOW, revisedAnchor: 'gate-demo-x' }))
      .toEqual({ kind: 'revised', anchor: 'gate-demo-x' });
    expect(approvalOutcome(row({ status: 'commented', sessionStatus: 'completed' }), { now: NOW }))
      .toEqual({ kind: 'revised' });
  });

  it('reads the run for everything else', () => {
    expect(approvalOutcome(row({ status: 'approved', sessionStatus: 'running', decisionAt: NOW - 12 * MIN }), { now: NOW }))
      .toEqual({ kind: 'running', sinceMs: 12 * MIN });
    expect(approvalOutcome(row({ status: 'approved', sessionStatus: 'completed' }), { now: NOW }))
      .toEqual({ kind: 'completed' });
    expect(approvalOutcome(row({ status: 'approved', sessionStatus: 'error', errorMessage: 'LinkedIn session expired' }), { now: NOW }))
      .toEqual({ kind: 'failed', text: 'LinkedIn session expired' });
    expect(approvalOutcome(row({ status: 'errored', sessionStatus: 'completed', errorCode: 'TIMEOUT' }), { now: NOW }))
      .toEqual({ kind: 'failed', text: 'TIMEOUT' });
  });
});

describe('pending group ordering and anchors', () => {
  const stale = row({ sessionId: 'stale', suspendedAt: NOW - 4 * DAY });
  const freshAgent = row({ sessionId: 'fresh', agentFilePath: '/root/agents/li/linkedin.agentuse', suspendedAt: NOW - MIN });
  const midAgent = row({ sessionId: 'mid', agentFilePath: '/root/agents/li/linkedin.agentuse', suspendedAt: NOW - DAY });

  it('leads with the agent ignored longest when asked for stalest order', () => {
    expect(groupPendingByAgent([freshAgent, midAgent, stale], 'stalest').map((g) => g.name))
      .toEqual(['x-outreach', 'linkedin']);
  });

  it('still leads with new activity by default, as Home expects', () => {
    expect(groupPendingByAgent([freshAgent, midAgent, stale]).map((g) => g.name))
      .toEqual(['linkedin', 'x-outreach']);
  });

  it('keeps rows newest first inside a group and tracks both ends', () => {
    const group = groupPendingByAgent([midAgent, freshAgent], 'stalest')[0]!;
    expect(group.rows.map((r) => r.sessionId)).toEqual(['fresh', 'mid']);
    expect(group.oldest).toBe(NOW - DAY);
    expect(group.newest).toBe(NOW - MIN);
    expect(group.agentFilePath).toBe('/root/agents/li/linkedin.agentuse');
  });

  it('builds a DOM-safe anchor id from the group key', () => {
    expect(pendingGroupId(groupPendingByAgent([stale])[0]!)).toBe('gate-demo-x-outreach');
  });

  it('flags only the sessions still waiting', () => {
    expect(pendingSessionIds([stale, freshAgent])).toEqual(new Set(['demo:stale', 'demo:fresh']));
  });
});

describe('expiresSoon', () => {
  it('stays quiet outside six hours and turns urgent inside the last one', () => {
    expect(expiresSoon(row({}), NOW)).toBeUndefined();
    expect(expiresSoon(row({ expiresAt: NOW + 12 * HOUR }), NOW)).toBeUndefined();
    expect(expiresSoon(row({ expiresAt: NOW - MIN }), NOW)).toBeUndefined();
    expect(expiresSoon(row({ expiresAt: NOW + 3 * HOUR }), NOW)).toEqual({ leftMs: 3 * HOUR, urgent: false });
    expect(expiresSoon(row({ expiresAt: NOW + 20 * MIN }), NOW)).toEqual({ leftMs: 20 * MIN, urgent: true });
  });
});

describe('agentRunPathResolver', () => {
  const resolve = agentRunPathResolver([
    { projectId: 'demo', runPath: 'x-outreach.agentuse' },
    { projectId: 'demo', runPath: 'agents/x/x-outreach.agentuse' },
    { projectId: 'other', runPath: 'agents/li/linkedin.agentuse' },
  ]);

  it('prefers the longest suffix match inside the same project', () => {
    expect(resolve('demo', '/root/agents/x/x-outreach.agentuse')).toBe('agents/x/x-outreach.agentuse');
  });

  it('does not cross projects, and gives up rather than guessing', () => {
    expect(resolve('demo', '/root/agents/li/linkedin.agentuse')).toBeUndefined();
    expect(resolve('demo', undefined)).toBeUndefined();
  });
});

describe('who decided, and where', () => {
  it('recognizes a Slack decision from the reviewer, the message, or the channel list', () => {
    expect(decidedViaSlack(row({ decisionReviewer: 'slack' }))).toBe(true);
    expect(decidedViaSlack(row({ channelMessage: { type: 'slack' } }))).toBe(true);
    expect(decidedViaSlack(row({ channels: { slack: [{ channel: '#ops', ts: '1', events: ['approval'] }] } }))).toBe(true);
    expect(decidedViaSlack(row({}))).toBe(false);
  });

  it('reads a surface name as the reviewer themselves, so a row cannot say "web · web"', () => {
    expect(reviewerLabel(row({}))).toBe('you');
    expect(reviewerLabel(row({ decisionReviewer: 'web' }))).toBe('you');
    expect(reviewerLabel(row({ decisionReviewer: 'Slack' }))).toBe('you');
    expect(reviewerLabel(row({ decisionReviewer: 'leon' }))).toBe('leon');
  });
});
