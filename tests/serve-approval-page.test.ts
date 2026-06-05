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

  it('does not show completed approvals on the approvals list', () => {
    const row = (status: 'pending' | 'approved' | 'errored', sessionId: string, name: string) => ({
      projectId: 'project-1',
      multiProject: false,
      approval: {
        sessionId,
        agentId: `agents/${sessionId}`,
        agentName: name,
        status,
        sessionStatus: status === 'pending' ? 'suspended' : 'completed',
        prompt: `${name} prompt`,
        createdAt: Date.UTC(2026, 4, 1),
      },
    });

    const html = __testing.renderApprovalsListPage({
      buckets: {
        pending: [row('pending', 'pending-session', 'Pending agent')],
        expired: [row('errored', 'errored-session', 'Errored agent')],
      },
      errors: [],
      multiProject: false,
      daysFilter: '30',
    });

    expect(html).toContain('Pending');
    expect(html).toContain('Pending agent');
    expect(html).toContain('href="/sessions?approval=completed&amp;days=30"');
    expect(html).toContain('href="/sessions?approval=errored&amp;days=30"');
    expect(html).toContain('Completed approvals');
    expect(html).toContain('Errored approvals');
    expect(html).not.toContain('Completed approvals in Sessions');
    expect(html).not.toContain('Errored approvals in Sessions');
    expect(html).not.toContain('Expired / Errored');
    expect(html).not.toContain('Errored agent');
    expect(html).not.toContain('<span>Completed</span>');
    expect(html).not.toContain('No completed approvals yet.');
    expect(html).not.toContain('Approved agent');
  });

  it('carries the approvals list window into sessions history links', () => {
    const html = __testing.renderApprovalsListPage({
      buckets: { pending: [], expired: [] },
      errors: [],
      multiProject: false,
      daysFilter: 'all',
    });

    expect(html).toContain('href="/sessions?approval=completed&amp;days=all"');
    expect(html).toContain('href="/sessions?approval=errored&amp;days=all"');
  });

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
    expect(html).toContain('decision recorded|resuming the session');
    expect(html).toContain("history.scrollRestoration = 'manual'");
    expect(html).toContain('scrollToPageEnd({ force: true })');
    expect(html).not.toContain('scrollToActiveApproval');
    expect(html).not.toContain("scrollIntoView({ behavior: 'smooth'");
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

  it('surfaces session-level continuation errors on the approval page', () => {
    const approval = {
      ...baseApproval,
      sessionStatus: 'error',
      errorCode: 'EXECUTION_ERROR',
      errorMessage: 'Failed after 4 attempts. Last error: Error'
    };

    const html = __testing.renderApprovalPage({
      approval,
      token: 'token-1',
      projectId: 'project-1'
    });

    expect(html).toContain('session needs attention');
    expect(html).toContain('This run stopped with an error.');
    expect(html).toContain('Session finished with an error: EXECUTION_ERROR: Failed after 4 attempts. Last error: Error');
    expect(html).toContain("payload.approval?.sessionStatus === 'error'");
  });

  it('renders running tool steps with input details before output exists', () => {
    const html = __testing.renderApprovalPage({
      approval: {
        ...baseApproval,
        sessionStatus: 'running',
        logs: [{
          id: 'tool-1',
          type: 'tool',
          tool: 'sandbox__exec',
          status: 'running',
          title: 'sandbox__exec running',
          details: {
            input: JSON.stringify({ cmd: 'pnpm test' }, null, 2)
          },
          time: Date.now()
        }]
      },
      token: 'token-1',
      projectId: 'project-1',
      continuing: true
    });

    expect(html).toContain('log-item running expandable');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('log-spinner');
    expect(html).toContain('Input');
    expect(html).toContain('pnpm test');
    expect(html).toContain("entry.status === 'streaming' || entry.status === 'running'");
  });
});
