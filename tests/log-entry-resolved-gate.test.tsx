import { describe, expect, it } from 'bun:test';
import render from 'preact-render-to-string';
import { LogEntry } from '../src/cli/serve/web/components/log-entry';
import type { ApprovalLogEntry } from '../src/cli/serve/types';

function renderGate(entry: ApprovalLogEntry, showActions = false): string {
  return render(<LogEntry
    entry={entry}
    expanded={undefined}
    showActions={showActions}
    actionsDisabled={false}
    projectId="project"
    sessionId="session"
    token={undefined}
    onToggle={() => {}}
    onAction={() => {}}
  />);
}

const decided: ApprovalLogEntry = {
  id: 'gate-1', type: 'tool', tool: 'await_human', status: 'completed', title: 'Rejected', time: 1_000,
  details: {
    prompt: 'Which letter should ship?',
    options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    decisionStatus: 'rejected',
    decisionReviewer: 'verify-judge',
    decisionComment: 'A: TRUST_GAP',
  },
};

describe('decided gate rows', () => {
  // A round the judge already rejected is history: it folds to its verdict so
  // the reviewer reads one line, not every candidate and critique again.
  it('folds an already-decided gate to its one-line verdict', () => {
    const html = renderGate(decided);
    expect(html).toContain('class="log-item completed expandable"');
    expect(html).toContain('rejected by verify-judge');
    expect(html).toContain('aria-expanded="false"');
  });

  it('keeps the live gate open', () => {
    const pending: ApprovalLogEntry = {
      ...decided, status: 'pending', title: 'Approval requested',
      details: { prompt: 'Which letter should ship?', options: [{ id: 'A', label: 'A' }], resumeToken: 'tok' },
    };
    const html = renderGate(pending, true);
    expect(html).not.toContain('expandable');
    expect(html).toContain('is-actionable');
  });
});
