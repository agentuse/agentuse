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
  it('offers a continuation form for completed approval sessions', () => {
    expect(__testing.canContinueApprovalSession({
      approval: baseApproval
    })).toBe(true);

    const html = __testing.renderApprovalPage({
      approval: baseApproval,
      token: 'token-1',
      projectId: 'project-1'
    });

    expect(html).toContain('session completed');
    expect(html).toContain('id="continue-panel" class="continue-panel"');
    expect(html).toContain("location.pathname + '/continue'");
    expect(html).toContain('Continue session');
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

    const html = __testing.renderApprovalPage({
      approval,
      token: 'token-1',
      projectId: 'project-1'
    });

    expect(html).toContain('human approval requested');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('id="continue-panel" class="continue-panel" hidden');
  });
});
