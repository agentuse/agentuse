import { describe, expect, it } from 'bun:test';
import render from 'preact-render-to-string';
import { JudgePanel, collectJudgeRows } from '../src/cli/serve/web/routes/session-detail';
import type { ApprovalLogEntry } from '../src/cli/serve/types';

const ownVerify: ApprovalLogEntry = {
  id: 'v-own', type: 'verify', status: 'error', title: 'Verification failed (attempt 1 of 3)', time: 1_000,
  message: 'C: C overclaims',
  verify: {
    verdict: 'fail', attempt: 0, maxAttempts: 3, judge: '../shared/content-reader-judge.agentuse', critique: 'C: C overclaims',
    candidates: [{ id: 'A', pass: true }, { id: 'B', pass: true }, { id: 'C', pass: false, critique: 'C overclaims' }],
  },
};

const ownPass: ApprovalLogEntry = {
  id: 'v-own-2', type: 'verify', status: 'completed', title: 'Verification passed', time: 2_000,
  verify: {
    verdict: 'pass', attempt: 1, maxAttempts: 3,
    candidates: [{ id: 'A', pass: true, settled: true }, { id: 'B', pass: true, settled: true }, { id: 'C', pass: true, critique: 'bounded now' }],
  },
};

const descendant: ApprovalLogEntry = {
  id: 'subagent-session-leaf', type: 'subagent', title: 'Leaf completed', time: 500,
  subagentSession: {
    sessionId: 'leaf', agent: { id: 'agents/leaf', name: 'Leaf' }, status: 'completed', displayStatus: 'completed',
    trigger: 'manual', createdAt: 500, updatedAt: 900, command: 'agentuse sessions show leaf',
    events: [{
      id: 'verify-event-leaf-1', sourceLogId: 'p1', type: 'verify', ownerSessionId: 'leaf', depth: 1, breadcrumb: [],
      time: 700, verdict: 'error', mode: 'inline', attempt: 0, maxAttempts: 2, attemptLabel: 'Attempt 1 of 2',
      critique: 'judge returned no parseable verdict JSON', displayStatus: 'error', href: '/s/leaf#log-p1',
    }],
  },
};

describe('collectJudgeRows', () => {
  it('gathers own verify entries and descendant verify events, oldest first', () => {
    const rows = collectJudgeRows([ownPass, descendant, ownVerify]);
    expect(rows.map((row) => [row.id, row.verdict])).toEqual([
      ['verify-event-leaf-1', 'error'], ['v-own', 'fail'], ['v-own-2', 'pass'],
    ]);
    expect(rows[0]).toMatchObject({ owner: 'Leaf', href: '/s/leaf#log-p1', attemptLabel: 'Attempt 1 of 2' });
    expect(rows[1]).toMatchObject({ href: '#log-v-own', judge: '../shared/content-reader-judge.agentuse' });
  });

  it('ignores entries without a structured verdict', () => {
    expect(collectJudgeRows([{ id: 'x', type: 'text', title: 'hi' }, { id: 'y', type: 'verify', title: 'legacy' }])).toEqual([]);
  });
});

describe('JudgePanel', () => {
  it('renders nothing without rows', () => {
    expect(render(<JudgePanel rows={[]} />)).toBe('');
  });

  it('leads with the final outcome and lists every candidate per attempt', () => {
    const html = render(<JudgePanel rows={collectJudgeRows([ownVerify, ownPass])} />);
    expect(html).toContain('passed after 1 bounce');
    expect(html).toContain('Attempt 1 of 3');
    expect(html).toContain('Attempt 2 of 3');
    expect(html).toContain('C overclaims');
    expect(html).toContain('unchanged · carried forward');
    expect(html).toContain('href="#log-v-own"');
  });

  it('says so when the judge never produced a verdict', () => {
    const html = render(<JudgePanel rows={collectJudgeRows([descendant])} />);
    expect(html).toContain('not reviewed · judge error');
    expect(html).toContain('judge returned no parseable verdict JSON');
  });
});
