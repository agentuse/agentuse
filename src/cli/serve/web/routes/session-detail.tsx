import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { Topbar } from '../components/topbar';
import { LogEntry } from '../components/log-entry';
import { LogContent } from '../components/content';
import { DecisionDialog, type DecisionDialogMode } from '../components/comment-dialog';
import { ContinuePanel } from '../components/continue-panel';
import { DebugPromptButton } from '../components/debug-prompt-button';
import { postSessionDecision, postSessionContinue, postSessionStop, postSessionReopen, fetchSessionArtifacts, type SessionArtifact } from '../lib/api';
import { useApprovalStream } from '../hooks/use-approval-stream';
import { useTitle } from '../hooks/use-title';
import {
  formatApprovalTime,
  isDebugLog,
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

export function tokenUsageMetaItems(tokenUsage: ApprovalPageInfo['tokenUsage'] | undefined): Array<{ label: string; value: string; title?: string }> {
  if (!tokenUsage) return [];

  const items: Array<{ label: string; value: string; title?: string }> = [];
  const context = tokenUsage.context;
  if (context) {
    // Lead with "% context left" (like Codex): a stable 0-100 gauge of how much
    // working room remains, rather than a raw, ever-growing token count. The
    // absolute tokens/limit stay available on hover so the headline stays clean.
    const hasLimit = typeof context.contextLimit === 'number' && context.contextLimit > 0;
    const leftPercent = hasLimit
      ? formatUsagePercent(Math.max(0, 100 - context.usagePercentage))
      : undefined;
    const detail = [
      formatTokenCount(context.activeTokens),
      hasLimit ? `/ ${formatTokenCount(context.contextLimit)}` : undefined,
    ].filter(Boolean).join(' ');
    items.push({
      label: 'context used',
      value: leftPercent ? `${leftPercent} left` : detail,
      ...(leftPercent ? { title: detail } : {}),
    });
  }

  const cached = Math.max(0, tokenUsage.cachedInput);
  const newInput = Math.max(0, tokenUsage.input - cached);
  const output = Math.max(0, tokenUsage.output);

  const hasProviderUsage = tokenUsage.input > 0 || cached > 0 || output > 0;
  if (!hasProviderUsage) {
    items.push({ label: 'provider usage', value: 'not reported yet' });
    return items;
  }

  // Show the real full-rate spend split: non-cached input + output. Cached reads
  // are billed ~10x cheaper and re-counted on every step, so surfacing them as a
  // primary count made spend look far scarier than it is; we show them separately
  // with a leading '+' to signal they sit on top of (not inside) the input count.
  items.push({ label: 'input', value: formatTokenCount(newInput) });
  items.push({ label: 'output', value: formatTokenCount(output) });
  if (cached > 0) {
    items.push({ label: 'cached', value: `+${formatTokenCount(cached)}` });
  }
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

export function hasActionableApproval(status: string, header: ApprovalHeader | null): boolean {
  if (!header?.currentResumeToken) return false;
  return status === 'waiting' || (status === 'loading' && header.sessionStatus === 'suspended');
}

export default function SessionDetail() {
  const { params } = useRoute();
  const location = useLocation();
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  const token = location.query.token || undefined;
  const projectId = location.query.project || undefined;
  // Arrived from a just-started detached run: tolerate a brief "not found" while
  // the worker is still writing the session to disk.
  const pending = location.query.pending === '1';

  useTitle('AgentUse / Session');

  const [approval, setApproval] = useState<ApprovalHeader | null>(null);
  const [status, setStatus] = useState<string>('loading');
  const [logsVersion, setLogsVersion] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [pendingActionable, setPendingActionable] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [submittingContinue, setSubmittingContinue] = useState(false);
  const [submittingStop, setSubmittingStop] = useState(false);
  const [submittingReopen, setSubmittingReopen] = useState(false);
  // The resume composer stays collapsed until the user clicks "Resume session";
  // clicking again collapses it.
  const [showResume, setShowResume] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  // Terminal load failures (unauthorized, not found, corrupted session data):
  // the page can't recover, so we render this instead of the live view.
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogMode | null>(null);
  const [nudge, setNudge] = useState(0);
  // Project artifacts this run produced, from the artifact manifest. Refetched as
  // the log grows so newly written artifacts appear without a page reload.
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  // Debug-level operational logs are hidden by default to keep the log readable;
  // the preference persists across sessions.
  const [showDebug, setShowDebug] = useState<boolean>(() => {
    try { return localStorage.getItem('agentuse:session:showDebug') === '1'; } catch { return false; }
  });
  // True once the page is scrolled away from the top; reveals the session bar's
  // scroll-to-top control (the bar itself stays pinned for both view types).
  const [scrolled, setScrolled] = useState(false);

  // Logs accumulate monotonically across the session; the status payload can
  // briefly return fewer entries during approval handoffs, so merge by id.
  const logsRef = useRef(new Map<string, ApprovalLogEntry>());
  const currentResumeTokenRef = useRef<string | undefined>(token);
  const followScrollRef = useRef(true);
  // First-paint scroll-to-end happens once per session. The router reuses this
  // component across /sessions/:id navigations, so this must be reset on session
  // change (see the [sessionId] effect) or a sub-agent opened from its parent
  // would inherit the parent's "already scrolled" state and land at the top.
  const hasScrolledRef = useRef(false);
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
    const approvalWaiting = hasActionableApproval(nextStatus, header);
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

  // The router reuses this component instance across /sessions/:id navigations,
  // so logsRef and the per-session state persist. Without an explicit reset, a
  // child (sub-agent) session's logs — including its own approval entry — linger
  // when you navigate back to the manager, rendering a duplicate approval box.
  // Clear accumulated state whenever the session id changes. token is excluded:
  // it tracks sessionId via the URL, and resetting on a token-only refresh would
  // wipe live logs mid-session.
  useEffect(() => {
    logsRef.current = new Map();
    currentResumeTokenRef.current = token;
    // Treat the new session as never-scrolled so its first logs jump to the end,
    // matching a fresh page load even when arriving via in-app navigation.
    hasScrolledRef.current = false;
    followScrollRef.current = true;
    setApproval(null);
    setStatus('loading');
    setPendingActionable(false);
    setExpandedIds(new Set());
    setResult({ text: '', error: false });
    setFatalError(null);
    setLogsVersion((v) => v + 1);
    setArtifacts([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Pull the run's artifacts from the manifest, refreshing as the log grows so a
  // freshly written artifact surfaces live. Best-effort: a fetch error just
  // leaves the panel empty rather than disrupting the page.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchSessionArtifacts(sessionId, token, projectId)
      .then((payload) => {
        if (cancelled) return;
        // The effect refetches on every log batch, but artifacts change rarely;
        // skip the state update (and re-render) when the list is unchanged.
        setArtifacts((prev) => {
          const next = payload.artifacts;
          const same = prev.length === next.length
            && prev.every((a, i) => a.name === next[i].name && a.updatedAt === next[i].updatedAt);
          return same ? prev : next;
        });
      })
      .catch(() => { /* leave panel empty */ });
    return () => { cancelled = true; };
  }, [sessionId, token, projectId, logsVersion]);

  useApprovalStream({
    sessionId,
    token,
    project: projectId,
    nudge,
    pending,
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
  // Operational warnings emitted about a tool call (logger.warnWithTool carries
  // its toolId) are nested under the matching tool entry instead of floating in
  // the flat stream as a confusing standalone "failed" line. Orphans (no tool
  // entry with that callId present) stay in the stream so nothing disappears.
  const { toolWarnings, nestedLogIds } = useMemo(() => {
    const callIds = new Set(
      orderedLogs.filter((e) => e.type === 'tool' && e.callId).map((e) => e.callId as string)
    );
    const byCallId = new Map<string, ApprovalLogEntry[]>();
    const seenPerCall = new Map<string, Set<string>>();
    const nested = new Set<string>();
    for (const e of orderedLogs) {
      if (e.type !== 'log' || !e.toolId || !callIds.has(e.toolId)) continue;
      nested.add(e.id); // hide from the flat stream regardless of dedup
      // The same warning is emitted more than once per call; collapse identical
      // lines so the badge count reflects distinct warnings, not retries.
      const dedupKey = `${e.title} ${e.message ?? ''}`;
      const seen = seenPerCall.get(e.toolId) ?? new Set<string>();
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      seenPerCall.set(e.toolId, seen);
      const list = byCallId.get(e.toolId) ?? [];
      list.push(e);
      byCallId.set(e.toolId, list);
    }
    return { toolWarnings: byCallId, nestedLogIds: nested };
  }, [orderedLogs]);
  // Nested warnings are surfaced inside their tool entry, so exclude them from
  // the debug-toggle count too (they aren't free-floating noise anymore).
  const debugCount = useMemo(
    () => orderedLogs.reduce((n, e) => n + (!nestedLogIds.has(e.id) && isDebugLog(e) ? 1 : 0), 0),
    [orderedLogs, nestedLogIds]
  );
  const visibleLogs = useMemo(
    () => orderedLogs.filter((e) => !nestedLogIds.has(e.id) && (showDebug || !isDebugLog(e))),
    [orderedLogs, showDebug, nestedLogIds]
  );
  const reviewerComment = useMemo(() => latestReviewerComment(orderedLogs), [orderedLogs]);

  useEffect(() => {
    try { localStorage.setItem('agentuse:session:showDebug', showDebug ? '1' : '0'); } catch { /* ignore */ }
  }, [showDebug]);

  // Initial + follow scroll: stick to the page end while the user is near it.
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

  // The sub-agent breadcrumb sticks directly below the sticky topbar, whose
  // height changes when its nav wraps to a second row on narrow screens. Measure
  // it into --topbar-h so the trail's sticky offset tracks the real height
  // instead of a brittle hard-coded value.
  useLayoutEffect(() => {
    const topbar = document.querySelector<HTMLElement>('.topbar');
    if (!topbar || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      document.documentElement.style.setProperty('--topbar-h', `${Math.round(topbar.getBoundingClientRect().height)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(topbar);
    return () => ro.disconnect();
  }, []);

  // The session bar's scroll-to-top control only makes sense once the page is
  // scrolled away from the top; track that with a cheap rAF-throttled listener.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrolled(window.scrollY > 8);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const scrollToTop = useCallback(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  const live = isLiveStatus(status, orderedLogs);
  // While the run is live, keep a persistent "working" row pinned to the end of
  // the stream so the next step always has a visible loading indicator — through
  // tool execution and the model-latency gaps between steps, right up until the
  // next entry streams in. Only suppressed while the assistant is actively typing
  // (streaming text is its own indicator, so a second one would be redundant).
  const tailEntry = visibleLogs.length > 0 ? visibleLogs[visibleLogs.length - 1] : undefined;
  const tailTyping = (tailEntry?.type === 'text' || tailEntry?.type === 'reasoning') && tailEntry?.status === 'streaming';
  const showWorking = live && !tailTyping;
  const workingLabel = 'Agent is running';
  const ended = isEndedStatus(approval?.sessionStatus);
  const expired = approval?.expiresAt !== undefined && approval.expiresAt <= Date.now();
  const displayStatus = status === 'waiting' && expired ? 'expired' : displaySessionStatus(status, approval);
  const actionable = pendingActionable && !expired;
  const continueActionable = ended && !live && Boolean(approval?.agent.filePath) && !fatalError;
  const stopActionable = approval !== null && !ended && !expired && !submittingStop && !fatalError;
  // An errored session whose resolved approval gate can be rolled back for a retry.
  const reopenActionable = ended && approval?.sessionStatus === 'error'
    && Boolean(approval?.reopenable) && !live && !submittingReopen && !fatalError;

  useEffect(() => {
    if (continueActionable) setSubmittingContinue(false);
    else setShowResume(false);
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

  const submitReopen = useCallback(async () => {
    if (submittingReopen) return;
    // Manual, warned recovery: re-running can repeat any external action the
    // failed run already took before it errored.
    const ok = typeof window === 'undefined' || window.confirm(
      'Reopen this session for retry?\n\nThis rolls the approval gate back to pending so you can re-submit your decision and resume. If the failed run already took an external action (e.g. scheduled a post), retrying may repeat it.'
    );
    if (!ok) return;
    setSubmittingReopen(true);
    setResult({ text: '⋮ reopening approval gate…', error: false });
    try {
      await postSessionReopen(sessionId, token, {
        ...(projectId ? { project: projectId } : {}),
      });
      setResult({ text: '✓ gate reopened — re-submit your decision below to resume.', error: false });
      setStatus('waiting');
      setNudge((n) => n + 1);
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
    } finally {
      setSubmittingReopen(false);
    }
  }, [sessionId, token, projectId, submittingReopen]);

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
  // The name is the headline; the description (often a full sentence with
  // implementation notes) reads as a subhead rather than a giant multi-line H1.
  const agentDescription = approval.agent.description && approval.agent.description !== agentLabel
    ? approval.agent.description
    : undefined;
  const busy = status === 'resuming' || status === 'continuing';
  const tokenUsage = headerTokenUsage(approval);
  // Resolved theme currently applied to the document (set by the theme toggle).
  // Threaded into artifact links so a new-tab markdown/text artifact renders in
  // the same theme as the app rather than the default.
  const resolvedTheme = typeof document !== 'undefined'
    ? document.documentElement.getAttribute('data-theme') ?? undefined
    : undefined;
  // A delegated child viewed directly is framed as a sub-agent run: the session bar
  // shows a breadcrumb back to its parent and the page has no decision controls of
  // its own (the gate is acted on at the parent).
  const isSubagentView = Boolean(approval.viewOnly);
  const parentLabel = approval.parentAgentName ?? 'parent run';
  const parentTarget = approval.parentSessionId ?? approval.rootSessionId;
  const parentLink = approval.parentHref
    ?? (parentTarget
      ? `/sessions/${encodeURIComponent(parentTarget)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`
      : undefined);
  // A paused sub-agent has no controls of its own — the gate is acted on at the
  // parent run. Surface a prominent jump-to-parent CTA so the reviewer isn't left
  // hunting for the (intentionally hidden) approve buttons.
  const showParentApproveCta = isSubagentView && approval.sessionStatus === 'suspended' && Boolean(parentLink);
  const eyebrow = isSubagentView
    ? 'sub-agent run'
    : actionable
      ? 'human approval requested'
      : continueActionable
        ? approval.sessionStatus === 'error' ? 'session needs attention' : 'session completed'
        : 'session log';
  const promptText = isSubagentView
    ? approval.sessionStatus === 'suspended'
      ? 'This sub-agent is paused for approval. The decision is made on its parent run — open it from the pending request at the end of the log.'
      : 'A delegated sub-agent run. Approvals and follow-ups for it are handled on the parent run.'
    : actionable
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
        <div class={`session-bar${scrolled ? ' is-scrolled' : ''}`}>
          <div class="session-bar-lead">
            {isSubagentView && parentLink && (
              <a class="session-bar-back" href={parentLink} aria-label={`Back to ${parentLabel}`} title={`Back to ${parentLabel}`}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="9 14 4 9 9 4" />
                  <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                </svg>
              </a>
            )}
            <span class={`status ${displayStatus}`}>{displayStatus}</span>
            {approval?.mock && <span class="mock-badge" title="Tool outputs were LLM-generated; no real tools ran">mock</span>}
            <span class="session-bar-name">{agentLabel}</span>
          </div>
          <button
            type="button"
            class="session-bar-top"
            onClick={scrollToTop}
            aria-label="Scroll to top"
            title="Scroll to top"
            tabIndex={scrolled ? 0 : -1}
            aria-hidden={!scrolled}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
        <header>
          <div class="eyebrow">{eyebrow}</div>
          <h1>{agentLabel}</h1>
          {agentDescription && <p class="agent-tagline">{agentDescription}</p>}
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
              <div class="cell token-cell" key={item.label}>
                <span class="label">{item.label}</span>
                <span class="value" {...(item.title ? { title: item.title } : {})}>{item.value}</span>
              </div>
            ))}
          </div>
        </header>

        {approval.additionalInstruction && (
          <div class="panel additional-instruction">
            <div class="label">additional instruction</div>
            <div class="body">{approval.additionalInstruction}</div>
          </div>
        )}

        {reviewerComment && (
          <div class="panel reviewer-comment">
            <div class="label">latest reviewer comment</div>
            <div class="body"><LogContent value={reviewerComment.comment} forceMarkdown /></div>
            {reviewerComment.reviewer && <div class="meta-line">from {reviewerComment.reviewer}</div>}
          </div>
        )}

        {artifacts.length > 0 && (
          <div class="panel session-artifacts">
            <div class="label">artifacts</div>
            <div class="artifact-tiles">
              {[...artifacts]
                .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
                .map((a) => {
                  const encoded = a.name.split('/').map(encodeURIComponent).join('/');
                  const base = `/sessions/${encodeURIComponent(sessionId)}/artifacts/${encoded}`;
                  const params = new URLSearchParams();
                  if (token) params.set('token', token);
                  if (resolvedTheme) params.set('theme', resolvedTheme);
                  const qs = params.toString();
                  const href = qs ? `${base}?${qs}` : base;
                  const label = a.title || a.name.split('/').pop() || a.name;
                  return (
                    <a
                      key={a.name}
                      class="artifact-open"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open artifact ${label} (new tab)`}
                    >
                      <span class="artifact-open-name">{label}</span>
                      <span class="artifact-open-hint">open</span>
                    </a>
                  );
                })}
            </div>
          </div>
        )}

        <div class="section-title">
          <span>session log</span>
          <span class="rule"></span>
          {debugCount > 0 && (
            <label class="log-debug-toggle" title="Show debug-level operational logs">
              <input
                type="checkbox"
                checked={showDebug}
                onChange={(e) => setShowDebug((e.target as HTMLInputElement).checked)}
              />
              <span>debug</span>
              <span class="log-debug-count">{debugCount}</span>
            </label>
          )}
        </div>
        <div class="panel">
          <ul class="logs">
            {visibleLogs.length === 0 && (
              <li class="log-empty">
                {orderedLogs.length === 0
                  ? 'No session events yet.'
                  : `${debugCount} debug ${debugCount === 1 ? 'entry' : 'entries'} hidden. Enable the debug toggle to view.`}
              </li>
            )}
            {visibleLogs.map((entry) => (
              <LogEntry
                key={entry.id}
                entry={entry}
                warnings={entry.callId ? toolWarnings.get(entry.callId) : undefined}
                expanded={expandedIds.has(entry.id)}
                showActions={actionable && entry.status === 'pending' && Boolean(entry.details) &&
                  (!currentResumeTokenRef.current || entry.details?.resumeToken === currentResumeTokenRef.current)}
                parentApproveHref={showParentApproveCta ? parentLink : undefined}
                parentApproveLabel={parentLabel}
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
            {showWorking && (
              <li class="log-item log-working" aria-live="polite">
                <span class="log-time" />
                <span class="log-marker"><span class="log-spinner" aria-label="working" /></span>
                <div class="log-main">
                  <span class="log-title">{workingLabel}<span class="log-dots" aria-hidden="true" /></span>
                </div>
              </li>
            )}
          </ul>
        </div>

        <div class="session-actions">
          {reopenActionable && (
            <button
              type="button"
              class="debug-prompt-button"
              disabled={submittingReopen}
              onClick={() => void submitReopen()}
              title="Roll the approval gate back to pending so you can re-submit your decision and retry the resume that failed"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 4v5h-5" />
              </svg>
              <span>Retry</span>
            </button>
          )}
          {continueActionable && (
            <button
              type="button"
              class={`session-action-button${showResume ? ' active' : ''}`}
              aria-expanded={showResume}
              aria-controls="continue-prompt"
              onClick={() => setShowResume((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 4v5h-5" />
              </svg>
              <span>Resume session</span>
            </button>
          )}
          <DebugPromptButton
            context={{
              sessionId: approval.sessionId,
              projectId,
              agentName: agentLabel,
              agentFilePath: approval.agent.filePath,
              model: approval.model,
              sessionStatus: approval.sessionStatus,
              errorCode: approval.errorCode,
              errorMessage: approval.errorMessage,
            }}
          />
          {stopActionable && (
            <button
              type="button"
              class="debug-prompt-button stop-session-button"
              disabled={submittingStop}
              onClick={() => void submitStop()}
              title={live
                ? 'Stop this session and any running subagents'
                : 'Discard this pending request without approving or rejecting (does not run the agent)'}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                {live
                  ? <rect x="6" y="6" width="12" height="12" rx="2" />
                  : <><path d="M18 6 6 18" /><path d="M6 6 18 18" /></>}
              </svg>
              <span>{live ? 'Stop session' : 'Discard'}</span>
            </button>
          )}
        </div>

        <ContinuePanel
          hidden={!continueActionable || !showResume}
          disabled={submittingContinue || !continueActionable}
          onSubmit={(prompt) => void submitContinue(prompt)}
        />

        <div class="inactive-banner" hidden={actionable || continueActionable || stopActionable || reopenActionable || live || busy}>
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
