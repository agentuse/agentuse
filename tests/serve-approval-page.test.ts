import { describe, expect, it } from 'bun:test';
import { __testing } from '../src/cli/serve';

const baseApproval = {
  sessionId: 'session-1',
  sessionStatus: 'completed',
  agent: {
    id: 'agent-1',
    name: 'Approval test',
    filePath: '/tmp/approval-test.agentuse'
  },
  prompt: 'Approve the draft?',
  approvalUrl: 'http://127.0.0.1:12233/approvals/session-1?token=token-1',
  decision: { status: 'approve' },
  logs: []
};

describe('approval web page', () => {
  it('defaults approval list scans to 30 days and allows all history', () => {
    const now = Date.UTC(2026, 4, 6);

    expect(__testing.approvalListCreatedAfter(new URL('http://127.0.0.1:12233/approvals'), now))
      .toBe(now - 30 * 24 * 60 * 60 * 1000);
    expect(__testing.approvalListCreatedAfter(new URL('http://127.0.0.1:12233/approvals?days=7'), now))
      .toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(__testing.approvalListCreatedAfter(new URL('http://127.0.0.1:12233/approvals?days=all'), now))
      .toBeUndefined();
  });

  it('keeps the approvals SSE list refresh at the dashboard polling cadence', () => {
    expect(__testing.APPROVAL_LIST_SSE_INTERVAL_MS).toBe(10_000);
  });

  it('offers a continuation form for completed approval sessions', () => {
    expect(__testing.canContinueApprovalSession({
      approval: baseApproval
    })).toBe(true);
  });

  it('keeps suspended approvals on the decision flow', () => {
    const approval = {
      ...baseApproval,
      sessionStatus: 'suspended',
      currentResumeToken: 'token-1',
      decision: undefined,
      logs: [{
        id: 'part-1',
        type: 'tool',
        tool: 'await_human',
        status: 'pending',
        title: 'Pending for approval',
        details: {
          resumeToken: 'token-1',
          prompt: 'Approve the draft?'
        }
      }]
    };

    expect(__testing.canContinueApprovalSession({ approval })).toBe(false);
  });
});
