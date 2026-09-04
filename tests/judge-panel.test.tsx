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
  it('gathers the session own verify entries, oldest first', () => {
    const rows = collectJudgeRows([ownPass, ownVerify]);
    expect(rows.map((row) => [row.id, row.verdict])).toEqual([['v-own', 'fail'], ['v-own-2', 'pass']]);
    expect(rows[0]).toMatchObject({
      href: '#log-v-own', judge: '../shared/content-reader-judge.agentuse', attemptLabel: 'Attempt 1 of 3',
    });
  });

  // Descendant verdicts render on their own judge card in the session tree;
  // collecting them here as well printed each one twice.
  it('leaves descendant verify events to the tree that already shows them', () => {
    expect(collectJudgeRows([descendant])).toEqual([]);
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
    const errored: ApprovalLogEntry = {
      id: 'v-err', type: 'verify', status: 'error', title: 'Verification judge error', time: 500,
      verify: { verdict: 'error', attempt: 0, maxAttempts: 2, critique: 'judge returned no parseable verdict JSON' },
    };
    const html = render(<JudgePanel rows={collectJudgeRows([errored])} />);
    expect(html).toContain('not reviewed · judge error');
    expect(html).toContain('judge returned no parseable verdict JSON');
  });
});

describe('JudgePanel with a skipped final marker', () => {
  it('says the gate went to the human unjudged', () => {
    const skipped: ApprovalLogEntry = {
      id: 'v-skip', type: 'verify', status: 'skipped', title: 'Verification skipped', time: 3_000,
      verify: { verdict: 'skipped', attempt: 2, maxAttempts: 3, critique: 'Not judged: pre-review budget spent, escalated to you.' },
    };
    const html = render(<JudgePanel rows={collectJudgeRows([ownVerify, skipped])} />);
    expect(html).toContain('not judged · escalated to you');
    expect(html).toContain('judge-row is-skipped');
    expect(html).toContain('Not judged: pre-review budget spent, escalated to you.');
  });
});
