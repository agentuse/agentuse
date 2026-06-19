import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { Topbar } from '../components/topbar';
import { LogEntry } from '../components/log-entry';
import { LogContent } from '../components/content';
import { DecisionDialog, type DecisionDialogMode } from '../components/comment-dialog';
import { ContinuePanel } from '../components/continue-panel';
import { postSessionDecision, postSessionContinue, postSessionStop } from '../lib/api';
import { useApprovalStream } from '../hooks/use-approval-stream';
import { useTitle } from '../hooks/use-title';
import {
  formatApprovalTime,
  isEndedStatus,
  isLiveStatus,
  latestReviewerComment,
  logEntrySignature,
  sessionErrorText,
} from '../lib/format';

type ApprovalHeader = Omit<ApprovalPageInfo, 'logs'>;

const tokenFmt = new Intl.NumberFormat('en-US');
function formatTokenCount(value: number | undefined): string {
  return value === undefined ? '—' : tokenFmt.format(value);
}

function formatUsagePercent(value: number | undefined): string | undefined {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : undefined;
}

export function headerTokenUsage(
  approval: Pick<ApprovalPageInfo, 'sessionStatus' | 'tokenUsage'> | null
): ApprovalPageInfo['tokenUsage'] | undefined {
  return approval?.tokenUsage;
}

export function tokenUsageMetaItems(tokenUsage: ApprovalPageInfo['tokenUsage'] | undefined): Array<{ label: string; value: string }> {
  if (!tokenUsage) return [];

  const items: Array<{ label: string; value: string }> = [];
  const context = tokenUsage.context;
  if (context) {
    const percent = formatUsagePercent(context.usagePercentage);
    items.push({
      label: 'ctx estimate',
      value: [
        formatTokenCount(context.activeTokens),
        context.contextLimit !== undefined ? `/ ${formatTokenCount(context.contextLimit)}` : undefined,
        percent ? `(${percent})` : undefined,
      ].filter(Boolean).join(' '),
    });
  }

  const hasProviderUsage = tokenUsage.input > 0 || tokenUsage.cachedInput > 0 || tokenUsage.output > 0;
  if (!hasProviderUsage) {
    items.push({ label: 'provider usage', value: 'not reported yet' });
    return items;
  }

  items.push({ label: 'provider input', value: formatTokenCount(tokenUsage.input) });

  items.push({ label: 'cached input', value: formatTokenCount(tokenUsage.cachedInput) });
  items.push({
    label: 'uncached input',
    value: formatTokenCount(Math.max(0, tokenUsage.input - tokenUsage.cachedInput)),
  });

  items.push({ label: 'output', value: formatTokenCount(tokenUsage.output) });
  return items;
}

function isNearPageEnd(): boolean {
  const page = document.documentElement;
  return window.innerHeight + window.scrollY >= page.scrollHeight - 240;
}

function scrollToPageEnd(): void {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
  });
}

// error + USER_STOPPED / TIMEOUT surface as their own pill, matching the server.
function displaySessionStatus(status: string, header: ApprovalHeader | null): string {
  if ((status === 'error' || header?.sessionStatus === 'error')) {
    if (header?.errorCode === 'USER_STOPPED') return 'stopped';
    if (header?.errorCode === 'TIMEOUT') return 'timeout';
  }
  return status;
}

export default function SessionDetail() {
  const { params } = useRoute();
  const location = useLocation();
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  const token = location.query.token || undefined;
  const projectId = location.query.project || undefined;

  useTitle('AgentUse / Session');

  const [approval, setApproval] = useState<ApprovalHeader | null>(null);
  const [status, setStatus] = useState<string>('loading');
  const [logsVersion, setLogsVersion] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [pendingActionable, setPendingActionable] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [submittingContinue, setSubmittingContinue] = useState(false);
  const [submittingStop, setSubmittingStop] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  // Terminal load failures (unauthorized, not found, corrupted session data):
  // the page can't recover, so we render this instead of the live view.
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogMode | null>(null);
  const [nudge, setNudge] = useState(0);

  // Logs accumulate monotonically across the session; the status payload can
  // briefly return fewer entries during approval handoffs, so merge by id.
  const logsRef = useRef(new Map<string, ApprovalLogEntry>());
  const currentResumeTokenRef = useRef<string | undefined>(token);
  const followScrollRef = useRef(true);
  const resultRef = useRef(result);
  resultRef.current = result;

  const mergeLog = useCallback((entry: ApprovalLogEntry): boolean => {
    if (entry?.id == null) return false;
    const key = String(entry.id);
    const prior = logsRef.current.get(key);
    if (prior && logEntrySignature(prior) === logEntrySignature(entry)) return false;
    logsRef.current.set(key, entry);
    return true;
  }, []);

  const commitLogs = useCallback(() => {
    followScrollRef.current = isNearPageEnd();
    setLogsVersion((v) => v + 1);
  }, []);

  const handleStatus = useCallback((nextStatus: string, header: ApprovalHeader) => {
    setApproval(header);
    setStatus(nextStatus);
    const nextToken = header.currentResumeToken;
    const approvalWaiting = nextStatus === 'waiting' || header.sessionStatus === 'suspended';
    if (nextToken && nextToken !== currentResumeTokenRef.current && approvalWaiting) {
      // A fresh await_human gate opened mid-session: the log keeps its
      // history, but the actionable surface resets for the new gate.
      currentResumeTokenRef.current = nextToken;
      setPendingActionable(true);
      setSubmittingDecision(false);
      setResult({ text: '', error: false });
      if (header.approvalUrl) {
        try { history.replaceState(null, '', header.approvalUrl); } catch { /* ignore */ }
      }
      followScrollRef.current = true;
      setLogsVersion((v) => v + 1);
    } else {
      setPendingActionable(Boolean(nextToken && approvalWaiting));
    }

    const transitionResult = /submitting decision|decision recorded|resuming the session|continuing session|follow-up recorded|stopping session/.test(resultRef.current.text);
    if (nextStatus === 'error' || header.sessionStatus === 'error') {
      setResult({
        text: sessionErrorText(header) || 'Session finished with an error. Check the latest log entry for details.',
        error: true,
      });
    } else if (nextStatus === 'completed' && transitionResult) {
      setResult({ text: '✓ session completed.', error: false });
    }
  }, []);

  useApprovalStream({
    sessionId,
    token,
    project: projectId,
    nudge,
    handlers: {
      onStatus: handleStatus,
      onLog: (entry) => {
        if (mergeLog(entry)) commitLogs();
      },
      onLogs: (entries) => {
        let changed = false;
        for (const entry of entries) {
          if (mergeLog(entry)) changed = true;
        }
        if (changed) commitLogs();
      },
      onFatalError: (_code, message) => setFatalError(message),
    },
  });

  const orderedLogs = useMemo(
    () => [...logsRef.current.values()].sort((a, b) => (a.time ?? 0) - (b.time ?? 0)),
    [logsVersion]
  );
  const reviewerComment = useMemo(() => latestReviewerComment(orderedLogs), [orderedLogs]);

  // Initial + follow scroll: stick to the page end while the user is near it.
  const hasScrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (orderedLogs.length === 0) return;
    if (!hasScrolledRef.current || followScrollRef.current) {
      hasScrolledRef.current = true;
      scrollToPageEnd();
    }
  }, [logsVersion, orderedLogs.length]);

  useEffect(() => {
    try {
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    } catch { /* ignore */ }
  }, []);

  const live = isLiveStatus(status, orderedLogs);
  const ended = isEndedStatus(approval?.sessionStatus);
  const expired = approval?.expiresAt !== undefined && approval.expiresAt <= Date.now();
  const displayStatus = status === 'waiting' && expired ? 'expired' : displaySessionStatus(status, approval);
  const actionable = pendingActionable && !expired;
  const continueActionable = ended && !live && Boolean(approval?.agent.filePath) && !fatalError;
  const stopActionable = approval !== null && !ended && !expired && !submittingStop && !fatalError;

  useEffect(() => {
    if (continueActionable) setSubmittingContinue(false);
  }, [continueActionable]);

  const submitDecision = useCallback(async (action: string, comment?: string) => {
    if (submittingDecision || !currentResumeTokenRef.current) return;
    setSubmittingDecision(true);
    setResult({ text: '⋮ submitting decision…', error: false });
    try {
      await postSessionDecision(sessionId, token, {
        status: action,
        ...(comment ? { comment } : {}),
        resumeToken: currentResumeTokenRef.current,
        ...(projectId ? { project: projectId } : {}),
      });
      setResult({ text: '✓ decision recorded — agentuse is resuming the session.', error: false });
      setStatus('resuming');
      setNudge((n) => n + 1);
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingDecision(false);
    }
  }, [sessionId, token, projectId, submittingDecision]);

  const submitContinue = useCallback(async (prompt: string) => {
    if (submittingContinue || !continueActionable || !currentResumeTokenRef.current) return;
    setSubmittingContinue(true);
    setResult({ text: '⋮ continuing session…', error: false });
    try {
      const payload = await postSessionContinue(sessionId, token, {
        prompt,
        resumeToken: currentResumeTokenRef.current,
        ...(projectId ? { project: projectId } : {}),
      });
      setResult({ text: '✓ follow-up recorded — agentuse is continuing the session.', error: false });
      setStatus(payload.status || 'continuing');
      setNudge((n) => n + 1);
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingContinue(false);
    }
  }, [sessionId, token, projectId, submittingContinue, continueActionable]);

  const submitStop = useCallback(async () => {
    if (submittingStop) return;
    setSubmittingStop(true);
    setResult({ text: '⋮ stopping session…', error: false });
    try {
      await postSessionStop(sessionId, token, {
        ...(projectId ? { project: projectId } : {}),
        reason: 'Stopped from session UI',
      });
      setResult({ text: '✓ session stopped. Running subagents were stopped too.', error: false });
      setStatus('stopped');
      setNudge((n) => n + 1);
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingStop(false);
    }
  }, [sessionId, token, projectId, submittingStop]);

  const onAction = useCallback((action: 'approve' | 'reject' | 'comment') => {
    if (action === 'comment' || action === 'reject') {
      setDecisionDialog(action);
      return;
    }
    void submitDecision(action);
  }, [submitDecision]);

  // Keyboard shortcuts: cmd/ctrl+Enter approve, Esc opens reject, C comment.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (decisionDialog) return;
      const target = event.target as HTMLElement | null;
      const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
      const canAct = actionable && !submittingDecision;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (!canAct || inField) return;
        event.preventDefault();
        void submitDecision('approve');
      } else if (event.key === 'Escape' && !inField) {
        if (!canAct) return;
        setDecisionDialog('reject');
      } else if ((event.key === 'c' || event.key === 'C') && !inField && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!canAct) return;
        event.preventDefault();
        setDecisionDialog('comment');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [decisionDialog, actionable, submittingDecision, submitDecision]);

  if (fatalError) {
    return (
      <div class="page-approval-detail">
        <Topbar currentPage="sessions" />
        <main><p class="notice error">{fatalError}</p></main>
      </div>
    );
  }
  if (!approval) {
    return (
      <div class="page-approval-detail">
        <Topbar currentPage="sessions" />
        <main><p class="notice">Loading session…</p></main>
      </div>
    );
  }

  const agentLabel = approval.agent.name || approval.agent.id;
  const agentHeadline = approval.agent.description || agentLabel;
  const busy = status === 'resuming' || status === 'continuing';
  const tokenUsage = headerTokenUsage(approval);
  const eyebrow = actionable
    ? 'human approval requested'
    : continueActionable
      ? approval.sessionStatus === 'error' ? 'session needs attention' : 'session completed'
      : 'session log';
  const promptText = actionable
    ? 'Review the pending request in the session log below, then approve, reject, or send a comment back to the agent. The session is paused until you respond.'
    : continueActionable
      ? approval.sessionStatus === 'error'
        ? 'This run stopped with an error. Review the session log, then send a follow-up instruction to continue the same session with its existing context.'
        : 'This run has finished. Send a follow-up instruction to continue the same session with its existing context.'
      : busy
        ? 'AgentUse is working on this session. The session log updates as new work arrives.'
        : expired
          ? 'This approval request has expired. The session log remains available for review.'
          : 'Live view of this run. The session log updates as new work arrives.';

  return (
    <div class="page-approval-detail">
      <Topbar currentPage="sessions" />
      <main>
        <header>
          <span class={`status ${displayStatus}`}>{displayStatus}</span>
          <div class="eyebrow">{eyebrow}</div>
          <h1>{agentHeadline}</h1>
          <p class="prompt">{promptText}</p>
          <div class="meta">
            <div class="cell"><span class="label">session</span><code>{approval.sessionId}</code></div>
            <div class="cell"><span class="label">project</span><code>{projectId ?? 'default'}</code></div>
            <div class="cell"><span class="label">agent</span><span class="value">{agentLabel}</span></div>
            {approval.createdAt !== undefined && (
              <div class="cell"><span class="label">started</span><span class="value">{formatApprovalTime(approval.createdAt)}</span></div>
            )}
            {approval.model && (
              <div class="cell"><span class="label">model</span><span class="value">{approval.model}</span></div>
            )}
            {approval.expiresAt !== undefined && (
              <div class="cell"><span class="label">expires</span><span class="value">{formatApprovalTime(approval.expiresAt)}</span></div>
            )}
            {tokenUsageMetaItems(tokenUsage).map((item) => (
              <div class="cell token-cell" key={item.label}><span class="label">{item.label}</span><span class="value">{item.value}</span></div>
            ))}
          </div>
        </header>

        {reviewerComment && (
          <div class="panel reviewer-comment">
            <div class="label">latest reviewer comment</div>
            <div class="body"><LogContent value={reviewerComment.comment} forceMarkdown /></div>
            {reviewerComment.reviewer && <div class="meta-line">from {reviewerComment.reviewer}</div>}
          </div>
        )}

        <div class="section-title"><span>session log</span><span class="rule"></span></div>
        <div class="panel">
          <ul class="logs">
            {orderedLogs.length === 0 && <li class="log-empty">No session events yet.</li>}
            {orderedLogs.map((entry) => (
              <LogEntry
                key={entry.id}
                entry={entry}
                expanded={expandedIds.has(entry.id)}
                showActions={actionable && entry.status === 'pending' && Boolean(entry.details) &&
                  (!currentResumeTokenRef.current || entry.details?.resumeToken === currentResumeTokenRef.current)}
                actionsDisabled={submittingDecision}
                projectId={projectId}
                sessionId={sessionId}
                token={token}
                onToggle={(id) => {
                  setExpandedIds((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }}
                onAction={onAction}
              />
            ))}
          </ul>
        </div>

        <ContinuePanel
          hidden={!continueActionable}
          disabled={submittingContinue || !continueActionable}
          onSubmit={(prompt) => void submitContinue(prompt)}
        />

        {stopActionable && (
          <div class="stop-panel">
            <div class="stop-text">Stop this session and any running subagents.</div>
            <button class="danger" disabled={submittingStop} onClick={() => void submitStop()}>Stop session</button>
          </div>
        )}

        <div class="inactive-banner" hidden={actionable || continueActionable || stopActionable || live || busy}>
          This session is not accepting actions right now.
        </div>

        <p class={`notice${result.error ? ' error' : ''}`}>{result.text}</p>
      </main>

      <DecisionDialog
        open={decisionDialog !== null}
        mode={decisionDialog ?? 'comment'}
        onClose={() => setDecisionDialog(null)}
        onSubmit={(comment) => {
          const action = decisionDialog;
          setDecisionDialog(null);
          if (action) void submitDecision(action, comment);
        }}
      />
    </div>
  );
}
