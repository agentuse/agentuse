import { describe, expect, it } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { approvalFailureKind, type ApprovalActionFailure } from '../src/session/approval-action-failure';

type GatePayload = { sessionStatus: string; currentResumeToken: string; errorMessage?: string; actionFailure?: ApprovalActionFailure };
const gate = (sessionStatus: string, currentResumeToken: string): GatePayload => ({ sessionStatus, currentResumeToken });
import { classifyFailure, ResumeStateError } from '../src/runner/failure';
import { AuthenticationError } from '../src/models';
import { ProviderReconnectRequiredError } from '../src/auth/provider-health';
import { __testing } from '../src/cli/serve';
import { ApiRequestError } from '../src/cli/serve/web/lib/api';
import { ApprovalFailurePanel, approvalFailureCopy, decisionRequestFailure } from '../src/cli/serve/web/components/approval-failure';
import { LogEntry, type LogEntryProps } from '../src/cli/serve/web/components/log-entry';
import { reconcileSessionNotice } from '../src/cli/serve/web/routes/session-detail';

describe('approval failure kinds', () => {
  it('reads kinds from codes and causes, never from message text', () => {
    expect(approvalFailureKind({ code: 'PROVIDER_RECONNECT_REQUIRED', cause: 'authentication' })).toBe('reconnect');
    expect(approvalFailureKind({ code: 'AUTH_ERROR', cause: 'authentication', statusCode: 401 })).toBe('reconnect');
    // A missing credential was never rejected, so it is not a reconnect.
    expect(approvalFailureKind({ code: 'AUTH_ERROR', cause: 'authentication' })).toBe('signin');
    expect(approvalFailureKind({ code: 'EXECUTION_ERROR', cause: 'provider_overloaded' })).toBe('unavailable');
    expect(approvalFailureKind({ code: 'WORKER_DIED', cause: 'worker_interrupted' })).toBe('interrupted');
    expect(approvalFailureKind({ code: 'APPROVAL_RESUMING' })).toBe('decided');
    expect(approvalFailureKind({ code: 'CASCADE_GATE_UNRESOLVABLE', cause: 'resume_state' })).toBe('ended');
    expect(approvalFailureKind({ code: 'APPROVAL_EXPIRED' })).toBe('expired');
    expect(approvalFailureKind({ code: 'EXECUTION_ERROR', cause: 'unknown' })).toBe('other');
  });
});

describe('typed failures carry their provider and code', () => {
  it('names the provider whose saved credential was rejected', () => {
    const failure = classifyFailure(new Error('model setup failed', { cause: new ProviderReconnectRequiredError('anthropic') }));
    expect(failure).toMatchObject({ code: 'PROVIDER_RECONNECT_REQUIRED', cause: 'authentication', provider: 'anthropic' });
  });

  it('keeps a missing credential distinct from a rejected one', () => {
    const failure = classifyFailure(new AuthenticationError('openai', 'OPENAI_API_KEY', 'No authentication found for OpenAI'));
    expect(failure).toMatchObject({ code: 'AUTH_ERROR', cause: 'authentication', provider: 'openai' });
    expect(approvalFailureKind(failure)).toBe('signin');
  });

  it('keeps the resume refusal code and its existing message', () => {
    const error = new ResumeStateError('SESSION_NOT_SUSPENDED', 'completed');
    expect(error.message).toBe('SESSION_NOT_SUSPENDED: completed');
    expect(classifyFailure(error)).toMatchObject({ code: 'SESSION_NOT_SUSPENDED', cause: 'resume_state' });
  });
});

describe('background approval failure on the session payload', () => {
  const rejected = {
    status: 'approve',
    message: 'Provider credentials were rejected. Reconnect before retrying.',
    at: 1,
    code: 'PROVIDER_RECONNECT_REQUIRED',
    cause: 'authentication',
    provider: 'anthropic',
    resumeToken: 'tok-1',
  };

  it('reports a rejected sign-in as a reconnect on the same open gate, without offering a resend', () => {
    const session = __testing.applyBackgroundSessionFailure(
      gate('suspended', 'tok-1'),
      rejected,
    );
    expect(session.actionFailure).toEqual({
      action: 'approve',
      kind: 'reconnect',
      provider: 'anthropic',
      retryable: false,
      code: 'PROVIDER_RECONNECT_REQUIRED',
      message: rejected.message,
    });
    expect(session.errorMessage).toBe("Couldn't approve this request: Provider credentials were rejected. Reconnect before retrying.");
  });

  it('offers a resend only for a transient failure on the gate that is still pending', () => {
    const { provider: _provider, ...base } = rejected;
    const workerDied = { ...base, code: 'WORKER_DIED', cause: 'worker_interrupted', message: 'Worker process died unexpectedly' };
    const open = __testing.applyBackgroundSessionFailure(gate('suspended', 'tok-1'), workerDied);
    expect(open.actionFailure).toMatchObject({ kind: 'interrupted', retryable: true });

    const replaced = __testing.applyBackgroundSessionFailure(gate('suspended', 'tok-2'), workerDied);
    expect(replaced.actionFailure).toBeUndefined();

    const resumed = __testing.applyBackgroundSessionFailure(gate('running', 'tok-1'), workerDied);
    expect(resumed.actionFailure).toBeUndefined();
  });
});

describe('decision requests the server refused', () => {
  it('maps refusals by code and keeps unanswered requests from offering a resend', () => {
    expect(decisionRequestFailure(new ApiRequestError(409, 'APPROVAL_RESUMING', 'already resuming'), 'approve')).toMatchObject({ kind: 'decided', retryable: false });
    expect(decisionRequestFailure(new ApiRequestError(500, 'WORKER_UNAVAILABLE', 'No worker'), 'reject')).toMatchObject({ kind: 'interrupted', retryable: true });
    // A proxy error carries no AgentUse code: the decision may have arrived, so
    // its resend is gated on decisionStillPending rather than refused outright.
    expect(decisionRequestFailure(new ApiRequestError(502, 'REQUEST_FAILED', 'Request failed with status 502'), 'approve')).toMatchObject({ kind: 'unreachable', retryable: true });
    expect(decisionRequestFailure(new TypeError('Failed to fetch'), 'comment')).toMatchObject({ kind: 'unreachable', retryable: true, code: 'NETWORK_ERROR' });
  });
});

describe('approval failure panel', () => {
  const reconnect = { action: 'approve' as const, kind: 'reconnect' as const, provider: 'anthropic', retryable: false, code: 'PROVIDER_RECONNECT_REQUIRED', message: 'Provider credentials were rejected. Reconnect before retrying.' };

  it('names the provider and says the decision was not applied', () => {
    expect(approvalFailureCopy(reconnect, 'Claude')).toMatchObject({
      title: 'Reconnect Claude to continue',
      body: "Claude rejected the saved sign-in. Your approval wasn't applied, and this request is still waiting.",
      locksDecision: false,
    });
  });

  it('shows the kept comment and offers Retry only when the failure allows it', () => {
    const transient = { action: 'comment' as const, kind: 'interrupted' as const, retryable: true, code: 'WORKER_DIED', message: 'Worker process died unexpectedly' };
    const html = renderToString(<ApprovalFailurePanel failure={transient} comment="Mark the Fly notes as beta." onRetry={() => {}} />);
    expect(html).toContain('The agent runner stopped before resuming');
    expect(html).toContain('Mark the Fly notes as beta.');
    expect(html).toContain('Retry comment');

    const noResend = renderToString(<ApprovalFailurePanel failure={{ ...transient, retryable: false }} comment="x" onRetry={() => {}} />);
    expect(noResend).not.toContain('Retry');
  });

  it('sits directly above the decision buttons and stands them down when the gate is gone', () => {
    const entry = {
      id: 'gate-1', type: 'approval', status: 'pending', tool: 'await_human', title: 'await_human', timestamp: 1, message: 'Approve?',
      details: { prompt: 'Approve?', resumeToken: 'tok-1' },
    } as LogEntryProps['entry'];
    const props = {
      entry, expanded: true, showActions: true, actionsDisabled: false, projectId: undefined, sessionId: 's-1', token: undefined,
      onToggle: () => {}, onAction: () => {},
    } satisfies Partial<LogEntryProps>;
    const decided = { action: 'approve' as const, kind: 'decided' as const, retryable: false, code: 'APPROVAL_RESUMING', message: 'already resuming' };
    const html = renderToString(<LogEntry {...props as LogEntryProps} actionNotice={<ApprovalFailurePanel failure={decided} />} decisionLocked />);
    const actionsRow = html.slice(html.indexOf('data-actions-row'));
    expect(actionsRow.indexOf('approval-failure')).toBeLessThan(actionsRow.indexOf('log-actions-buttons'));
    expect(actionsRow.slice(actionsRow.indexOf('log-actions-buttons'))).toMatch(/<button[^>]*disabled[^>]*>Comment/);
  });

  it('keeps the page notice from repeating a failure the card shows', () => {
    const header = { sessionId: 's-1', sessionStatus: 'suspended', agent: { id: 'a', name: 'A' }, currentResumeToken: 'tok-1', errorMessage: "Couldn't approve this request: x.", actionFailure: reconnect };
    expect(reconcileSessionNotice({ text: '⋮ submitting decision…', error: false }, 'waiting', header)).toEqual({ text: '', error: false });
  });
});
