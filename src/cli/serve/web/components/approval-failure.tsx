import { useEffect, useState } from 'preact/hooks';
import type { ApprovalActionFailure, ApprovalDecisionAction } from '../../../../session/approval-action-failure';
import { approvalFailureKind } from '../../../../session/approval-action-failure';
import { ApiRequestError, fetchProviderSetup, fetchSessionStatus } from '../lib/api';
import { toErrorMessage } from '../../../../utils/error-message';
import { ProviderSetupDialog, providerConnectionTarget } from './provider-setup';

/**
 * A decision request the server refused (or never answered). The server checks
 * every precondition before it starts a resume, so a refusal applied nothing;
 * only a worker that was not ready is worth resending as-is. A request with no
 * AgentUse answer may or may not have arrived: its resend first asks the server
 * (decisionStillPending) and goes out only if nothing took effect.
 */
export function decisionRequestFailure(error: unknown, action: ApprovalDecisionAction): ApprovalActionFailure {
  if (error instanceof ApiRequestError && error.code !== 'REQUEST_FAILED') {
    const kind = approvalFailureKind({ code: error.code });
    return { action, kind, retryable: kind === 'interrupted', code: error.code, message: error.message };
  }
  return {
    action,
    kind: 'unreachable',
    retryable: true,
    code: error instanceof ApiRequestError ? error.code : 'NETWORK_ERROR',
    message: toErrorMessage(error),
  };
}

/**
 * Whether an unanswered decision can be resent: the server still shows the gate
 * it was made on as waiting, with no resume running and no recorded failure.
 * Anything else means the first request (or another reviewer) already acted.
 */
export async function decisionStillPending(sessionId: string, token: string | undefined, project: string | undefined, resumeToken: string): Promise<boolean> {
  const payload = await fetchSessionStatus(sessionId, token, project, 1);
  return payload.status === 'waiting'
    && payload.approval.currentResumeToken === resumeToken
    && !payload.approval.actionFailure;
}

export interface ApprovalFailureCopy {
  tone: 'warn' | 'error' | 'info' | 'muted';
  title: string;
  body: string;
  /** The gate cannot take a decision any more; the decision buttons stand down. */
  locksDecision: boolean;
}

const NOUN: Record<ApprovalDecisionAction, string> = { approve: 'approval', reject: 'rejection', comment: 'comment' };
const VERB: Record<ApprovalDecisionAction, string> = { approve: 'approve', reject: 'reject', comment: 'send your comment on' };

export function approvalFailureCopy(failure: ApprovalActionFailure, providerName: string | undefined): ApprovalFailureCopy {
  const noun = NOUN[failure.action];
  const notApplied = `Your ${noun} wasn't applied, and this request is still waiting.`;
  const provider = providerName ?? 'your AI provider';
  const Provider = providerName ?? 'Your AI provider';
  switch (failure.kind) {
    case 'reconnect':
      return { tone: 'warn', title: `Reconnect ${provider} to continue`, body: `${Provider} rejected the saved sign-in. ${notApplied}`, locksDecision: false };
    case 'signin':
      return { tone: 'warn', title: `Connect ${provider} to continue`, body: `AgentUse has no saved sign-in for ${provider}. ${notApplied}`, locksDecision: false };
    case 'unavailable':
      return { tone: 'error', title: 'The model provider had a temporary problem', body: notApplied, locksDecision: false };
    case 'interrupted':
      return { tone: 'error', title: 'The agent runner stopped before resuming', body: notApplied, locksDecision: false };
    case 'unreachable':
      return { tone: 'error', title: "Couldn't reach AgentUse", body: `The connection dropped before AgentUse answered, so your ${noun} may not have arrived. Retry checks first and resends only if this request is still waiting.`, locksDecision: false };
    case 'decided':
      return { tone: 'info', title: 'This request was already answered', body: `It was answered elsewhere or is already resuming. Your ${noun} wasn't sent.`, locksDecision: true };
    case 'stale':
      return { tone: 'info', title: 'This request changed', body: 'The agent replaced it after you opened the page. Nothing was applied. Review the new request, then decide again.', locksDecision: true };
    case 'ended':
      return { tone: 'muted', title: "This request can't continue", body: 'The run it belongs to has ended, so no decision can resume it. Nothing was applied.', locksDecision: true };
    case 'expired':
      return { tone: 'muted', title: 'This request expired', body: 'It can no longer be approved or rejected. Nothing was applied.', locksDecision: true };
    case 'other':
      return { tone: 'error', title: `Couldn't ${VERB[failure.action]} this request`, body: `Your ${noun} wasn't applied. Check the details before trying again.`, locksDecision: false };
  }
}

/** Provider name and reconnect target from the same metadata the settings page uses. */
function useProviderTarget(provider: string | undefined): { name: string; initialProvider: string } | undefined {
  const [target, setTarget] = useState<{ name: string; initialProvider: string } | undefined>(undefined);
  useEffect(() => {
    setTarget(undefined);
    if (!provider) return;
    let cancelled = false;
    // A capability-scoped viewer cannot read provider setup; the card then
    // falls back to generic wording and the settings link.
    fetchProviderSetup({ deferReadiness: true })
      .then((payload) => { if (!cancelled) setTarget(providerConnectionTarget(payload, provider)); })
      .catch(() => { /* generic wording is still accurate */ });
    return () => { cancelled = true; };
  }, [provider]);
  return target;
}

/**
 * Why the last decision on this gate did not take effect, and the one next
 * step. Rendered by every approval entry point directly above its decision
 * buttons; the page shows no second copy of the same failure.
 */
export function ApprovalFailurePanel(props: {
  failure: ApprovalActionFailure;
  /** The comment that went with the failed decision; kept for the next attempt. */
  comment?: string | undefined;
  retrying?: boolean;
  onRetry?: (() => void) | undefined;
}) {
  const { failure } = props;
  const credentialKind = failure.kind === 'reconnect' || failure.kind === 'signin';
  const target = useProviderTarget(credentialKind ? failure.provider : undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);

  const comment = props.comment?.trim();
  // Mounted in both states so a finished reconnect keeps its own "done" step.
  const dialog = credentialKind && target && (
    <ProviderSetupDialog
      open={dialogOpen}
      scope="provider"
      initialProvider={target.initialProvider}
      reconnect={failure.kind === 'reconnect'}
      title={`${failure.kind === 'reconnect' ? 'reconnect' : 'connect'} ${target.name}`}
      onComplete={() => setConnected(true)}
      onClose={() => setDialogOpen(false)}
    />
  );
  if (connected && target) {
    return (
      <div class="approval-failure is-ok" role="status">
        <div class="approval-failure-copy">
          <strong class="approval-failure-title">{target.name} is connected again</strong>
          <span>Nothing was sent. {comment ? 'Your comment is kept. ' : ''}Choose your decision again when you're ready.</span>
        </div>
        {dialog}
      </div>
    );
  }

  const copy = approvalFailureCopy(failure, target?.name);
  const settingsHref = `/settings?tab=providers${failure.provider ? `&provider=${encodeURIComponent(failure.provider)}` : ''}`;
  return (
    <div class={`approval-failure is-${copy.tone}`} role="alert">
      <div class="approval-failure-copy">
        <strong class="approval-failure-title">{copy.title}</strong>
        <span>{copy.body}</span>
        {comment && (
          <span class="approval-failure-comment">
            {copy.locksDecision ? 'Your comment' : `Your comment is kept${failure.retryable ? ' and goes with Retry' : ''}`}: <q>{comment}</q>
          </span>
        )}
        <details class="approval-failure-details">
          <summary>Details</summary>
          <code>{failure.code}: {failure.message}</code>
        </details>
      </div>
      <div class="approval-failure-actions">
        {credentialKind && (target
          ? <button type="button" class="primary" onClick={() => setDialogOpen(true)}>{failure.kind === 'reconnect' ? 'Reconnect' : 'Connect'} {target.name}</button>
          : <a class="approval-failure-link" href={settingsHref}>Open AI connections</a>)}
        {failure.retryable && props.onRetry && (
          <button type="button" class="primary" disabled={props.retrying} onClick={props.onRetry}>
            {props.retrying ? 'Retrying…' : `Retry ${failure.action}`}
          </button>
        )}
        {copy.locksDecision && comment && (
          <button type="button" onClick={() => {
            void navigator.clipboard?.writeText(comment).then(() => setCopied(true), () => { /* the comment stays visible */ });
          }}>{copied ? 'Copied' : 'Copy comment'}</button>
        )}
      </div>
      {dialog}
    </div>
  );
}
