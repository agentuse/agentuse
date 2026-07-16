import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { Topbar } from '../components/topbar';
import { LogEntry } from '../components/log-entry';
import { LogContent } from '../components/content';
import { DecisionDialog, type DecisionDialogMode } from '../components/comment-dialog';
import { ContinuePanel } from '../components/continue-panel';
import { LearningsPanel } from '../components/learnings-panel';
import { DebugPromptButton } from '../components/debug-prompt-button';
import { SessionMenu } from '../components/session-menu';
import { Loading } from '../components/loading';
import { postSessionDecision, postSessionContinue, postSessionStop, postSessionReopen, fetchSessionArtifacts, fetchApprovals, type SessionArtifact } from '../lib/api';
import { syncAppBadge } from '../lib/badge';
import { useApprovalStream } from '../hooks/use-approval-stream';
import { useTitle } from '../hooks/use-title';
import { useSmartBack } from '../hooks/use-smart-back';
import {
  formatApprovalTime,
  humanizeMetric,
  isDebugLog,
  isEndedStatus,
  isLiveStatus,
  latestReviewerComment,
  logEntrySignature,
  sessionErrorText,
} from '../lib/format';

type ApprovalHeader = Omit<ApprovalPageInfo, 'logs'>;

// A render-time entry that may carry a collapsed repeat count. Produced only when
// preparing entries for display; the underlying logsRef entries are never mutated.
type PreparedLogEntry = ApprovalLogEntry & { repeatCount?: number };

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

export interface TokenMetaItem {
  label: string;
  value: string;
  title?: string;
  /** Numeric value for count-up animation; the renderer formats via `format`. */
  num?: number;
  format?: (n: number) => string;
  /** Percent of context window remaining (0-100); renders the headroom gauge. */
  gaugePctLeft?: number;
}

export function tokenUsageMetaItems(tokenUsage: ApprovalPageInfo['tokenUsage'] | undefined): TokenMetaItem[] {
  if (!tokenUsage) return [];

  const items: TokenMetaItem[] = [];
  const context = tokenUsage.context;
  if (context) {
    // Lead with "% context left" (like Codex): a stable 0-100 gauge of how much
    // working room remains, rather than a raw, ever-growing token count. The
    // absolute tokens/limit stay available on hover so the headline stays clean.
    const hasLimit = typeof context.contextLimit === 'number' && context.contextLimit > 0;
    const pctLeft = hasLimit ? Math.max(0, 100 - context.usagePercentage) : undefined;
    const leftPercent = pctLeft !== undefined ? formatUsagePercent(pctLeft) : undefined;
    const detail = [
      formatTokenCount(context.activeTokens),
      hasLimit ? `/ ${formatTokenCount(context.contextLimit)}` : undefined,
    ].filter(Boolean).join(' ');
    items.push({
      label: 'context used',
      value: leftPercent ? `${leftPercent} left` : detail,
      ...(leftPercent ? { title: detail } : {}),
      ...(pctLeft !== undefined ? { gaugePctLeft: pctLeft } : {}),
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
  const wholeTokens = (n: number): string => formatTokenCount(Math.round(n));
  items.push({ label: 'input', value: formatTokenCount(newInput), num: newInput, format: wholeTokens });
  items.push({ label: 'output', value: formatTokenCount(output), num: output, format: wholeTokens });
  if (cached > 0) {
    items.push({ label: 'cached', value: `+${formatTokenCount(cached)}`, num: cached, format: (n) => `+${wholeTokens(n)}` });
  }
  return items;
}

/**
 * Animates a stat toward its latest value so live sessions read as motion:
 * counters visibly tick up on each SSE status update instead of snapping.
 */
function CountUpValue(props: { num: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(props.num);
  const fromRef = useRef(props.num);
  useEffect(() => {
    const from = fromRef.current;
    if (from === props.num) return;
    let raf = 0;
    const start = performance.now();
    const duration = 600;
    const tick = (t: number) => {
      const progress = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (props.num - from) * eased;
      setDisplay(value);
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = props.num;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.num]);
  return <>{props.format(display)}</>;
}

/** Headroom tone for the context gauge: calm green until half, then amber, then red. */
function gaugeTone(pctLeft: number): string {
  return pctLeft > 50 ? '' : pctLeft > 20 ? ' warn' : ' crit';
}

/** One business fact the run recorded via the record_metric tool. */
interface RecordedMetric {
  metric: string;
  count?: number;
  value?: number;
  unit?: string;
}

/** "$12,400" / "3,200 words" / "+2" — the amount half of a recorded-metric chip. */
function recordedMetricAmount(m: RecordedMetric): string {
  if (typeof m.value === 'number') {
    const num = m.value.toLocaleString();
    return m.unit === 'usd' ? `$${num}` : m.unit ? `${num} ${m.unit}` : num;
  }
  return typeof m.count === 'number' ? `+${m.count.toLocaleString()}` : '';
}

/** Coarse human duration for the result verdict line ("42s", "12 min", "1h 05m"). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
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

// error + USER_STOPPED / TIMEOUT / INCOMPLETE surface as their own pill, matching the server.
function displaySessionStatus(status: string, header: ApprovalHeader | null): string {
  if ((status === 'error' || header?.sessionStatus === 'error')) {
    if (header?.errorCode === 'USER_STOPPED') return 'stopped';
    if (header?.errorCode === 'TIMEOUT') return 'timeout';
    if (header?.errorCode === 'INCOMPLETE') return 'incomplete';
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
  const goBack = useSmartBack('/sessions');
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
  const [submittingDecision, setSubmittingDecision] = useState<'approve' | 'reject' | 'comment' | null>(null);
  // Reviewer's pick on a pick-among-options gate. null = no explicit pick yet;
  // the effective selection then falls back to the recommended (or first)
  // option, so approve is always well-defined on an options gate.
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [submittingContinue, setSubmittingContinue] = useState(false);
  const [submittingStop, setSubmittingStop] = useState(false);
  const [submittingReopen, setSubmittingReopen] = useState(false);
  // The resume composer stays collapsed until the user clicks "Resume session";
  // clicking again collapses it.
  const [showResume, setShowResume] = useState(false);
  // Learned instructions can be long, so they stay collapsed behind the
  // "Learnings" action until toggled open.
  const [showLearnings, setShowLearnings] = useState(false);
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
  // The models.dev pricing registry is ~400 kB of generated data, so it loads as
  // its own chunk after mount; the est. cost cell simply appears once it lands.
  const [pricing, setPricing] = useState<typeof import('../lib/pricing') | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('../lib/pricing').then((mod) => { if (!cancelled) setPricing(mod); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
  // Whether the session was ALREADY over the first time this page saw it.
  // Summary-first layout applies only then: a run watched live keeps its
  // feed-first layout after it ends, so the transcript never snaps closed
  // under the reader. Latched per session (reset in the [sessionId] effect).
  const firstViewEndedRef = useRef<boolean | null>(null);

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
      setSubmittingDecision(null);
      setSelectedChoice(null);
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
    setSelectedChoice(null);
    setExpandedIds(new Set());
    setResult({ text: '', error: false });
    setFatalError(null);
    setLogsVersion((v) => v + 1);
    setArtifacts([]);
    // Re-latch the summary-first decision, and the keyed uncontrolled
    // <details> transcript remounts closed for the new session.
    firstViewEndedRef.current = null;
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
  // Entries present in the first snapshot render without motion; anything that
  // arrives later over SSE gets the fade-in-up arrival animation. The set is
  // captured after the first non-empty render so the initial history never
  // animates as a wall of movement.
  const initialLogIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (initialLogIdsRef.current === null && orderedLogs.length > 0) {
      initialLogIdsRef.current = new Set(orderedLogs.map((e) => e.id));
    }
  }, [orderedLogs]);
  const isNewLog = (id: string): boolean =>
    initialLogIdsRef.current !== null && !initialLogIdsRef.current.has(id);
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
    // Routine learning captures (captured/none) live in the Learnings panel now,
    // so keep them out of the work log; a failed capture (status 'error') still
    // surfaces inline since it's a real problem worth seeing in the timeline.
    () => orderedLogs.filter((e) =>
      !nestedLogIds.has(e.id)
      && (showDebug || !isDebugLog(e))
      && !(e.type === 'learning' && e.status !== 'error')
    ),
    [orderedLogs, showDebug, nestedLogIds]
  );
  // Operational log lines (type 'log') can repeat identically many times in a row
  // (e.g. "Calling model: ..." or repeated MCP chatter). Collapse consecutive
  // identical ones into a single row carrying a repeat count. This runs at
  // render-preparation time on a fresh array; logsRef (the SSE merge source) is
  // never touched, so the merge-by-id logic stays intact.
  const collapsedLogs = useMemo<PreparedLogEntry[]>(() => {
    const out: PreparedLogEntry[] = [];
    for (const entry of visibleLogs) {
      const prev = out[out.length - 1];
      if (
        prev
        && entry.type === 'log' && prev.type === 'log'
        && prev.level === entry.level
        && prev.title === entry.title
        && (prev.message ?? '') === (entry.message ?? '')
      ) {
        out[out.length - 1] = { ...prev, repeatCount: (prev.repeatCount ?? 1) + 1 };
        continue;
      }
      out.push(entry);
    }
    return out;
  }, [visibleLogs]);
  const reviewerComment = useMemo(() => latestReviewerComment(orderedLogs), [orderedLogs]);
  // The outcome for the summary-first ended layout: the last completed
  // assistant text in the log is the run's final response. Derived client-side
  // from the entries already loaded (same idea as the server's feed-detail
  // finalResponse, which reads the durable transcript).
  const finalText = useMemo(() => {
    for (let i = orderedLogs.length - 1; i >= 0; i--) {
      const entry = orderedLogs[i];
      if (entry.type === 'text' && entry.status !== 'streaming' && (entry.message ?? '').trim()) {
        return entry.message as string;
      }
    }
    return undefined;
  }, [orderedLogs]);
  const toolCallCount = useMemo(
    () => orderedLogs.reduce((n, e) => n + (e.type === 'tool' ? 1 : 0), 0),
    [orderedLogs]
  );
  // Business facts the run recorded via record_metric, for the result card's
  // "recorded" chips. The tool's OUTPUT (details.output JSON) confirms the
  // write and names the metric; the call INPUT carries the recorded amounts.
  // Last write per metric wins, mirroring the tool's per-session upsert.
  const recordedMetrics = useMemo<RecordedMetric[]>(() => {
    const byMetric = new Map<string, RecordedMetric>();
    for (const entry of orderedLogs) {
      if (entry.type !== 'tool' || !entry.tool?.endsWith('record_metric')) continue;
      if (entry.status === 'error' || entry.status === 'failed' || entry.status === 'running') continue;
      let out: Record<string, unknown>;
      try { out = JSON.parse(entry.details?.output ?? entry.message ?? '') as Record<string, unknown>; } catch { continue; }
      if (out.success !== true || typeof out.metric !== 'string') continue;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(entry.details?.input ?? '') as Record<string, unknown>; } catch { /* name-only chip */ }
      byMetric.set(out.metric, {
        metric: out.metric,
        ...(typeof input.count === 'number' ? { count: input.count } : {}),
        ...(typeof input.value === 'number' ? { value: input.value } : {}),
        ...(typeof input.unit === 'string' && input.unit ? { unit: input.unit } : {}),
      });
    }
    return [...byMetric.values()];
  }, [orderedLogs]);

  useEffect(() => {
    try { localStorage.setItem('agentuse:session:showDebug', showDebug ? '1' : '0'); } catch { /* ignore */ }
  }, [showDebug]);

  // Initial + follow scroll: stick to the page end while the user is near it.
  useLayoutEffect(() => {
    if (orderedLogs.length === 0) return;
    if (!hasScrolledRef.current) {
      hasScrolledRef.current = true;
      // First paint for this session: jump to the newest entry only when there's
      // something live to follow or an actionable gate to act on. On an ended
      // session leave the reader at the top so the header orients them.
      if (isLiveStatus(status, orderedLogs) || hasActionableApproval(status, approval)) {
        scrollToPageEnd();
      }
      return;
    }
    // Past first paint: keep live-follow behavior — stick to the end while the
    // reader is already near it (followScrollRef is set in commitLogs).
    if (followScrollRef.current) scrollToPageEnd();
  }, [logsVersion, orderedLogs.length]);

  useEffect(() => {
    try {
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    } catch { /* ignore */ }
  }, []);

  // The typing reveal grows the page a few pixels per frame between log
  // commits, where the logsVersion follow effect never fires. Watch the feed's
  // size while the session is live and stick to the end — but only when the
  // reader is already near it, so scrolling up still escapes the follow.
  useEffect(() => {
    if (!isLiveStatus(status, orderedLogs) || typeof ResizeObserver === 'undefined') return;
    const feed = document.querySelector('.logs');
    if (!feed) return;
    const ro = new ResizeObserver(() => {
      if (isNearPageEnd()) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      }
    });
    ro.observe(feed);
    return () => ro.disconnect();
  }, [status, orderedLogs]);

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
  if (approval !== null && firstViewEndedRef.current === null) {
    firstViewEndedRef.current = ended;
  }
  // Summary-first (issue #150): outcome + artifacts lead, transcript collapses.
  // Only for sessions that arrived already ended; live views keep feed-first
  // behavior for their whole lifetime (see firstViewEndedRef).
  const summaryFirst = ended && firstViewEndedRef.current === true;
  const expired = approval?.expiresAt !== undefined && approval.expiresAt <= Date.now();
  const displayStatus = status === 'waiting' && expired ? 'expired' : displaySessionStatus(status, approval);
  const actionable = pendingActionable && !expired;
  // A manual "remember" rule can be saved for any agent (the reviewer's action
  // is the opt-in), so the affordance shows whenever there's an agent file to
  // attach it to. Whether the rule is injected into future runs is a separate
  // question, governed by learning.apply — surfaced as a hint in the dialog.
  const canRememberLearning = Boolean(approval?.agent.filePath);
  const rememberApplies = approval?.learning?.apply === true;
  const continueActionable = ended && !live && Boolean(approval?.agent.filePath) && !fatalError;
  // The learnings panel shows on any ended session that has an agent file to
  // read/write learnings for — independent of whether resume is available.
  const learningsVisible = ended && Boolean(approval?.agent.filePath);
  const stopActionable = approval !== null && !ended && !expired && !submittingStop && !fatalError;
  // An errored session whose resolved approval gate can be rolled back for a retry.
  const reopenActionable = ended && approval?.sessionStatus === 'error'
    && Boolean(approval?.reopenable) && !live && !submittingReopen && !fatalError;

  // Surface the actionable gate as the LAST card in the feed. Normally the pending
  // await_human entry is already last, so this is a no-op. But after a reopen —
  // which re-arms an earlier gate in place while the failed resume's later work
  // stays logged below it — the gate and its Approve/Reject/Comment buttons would
  // otherwise be buried mid-stream. Move it to the end so the reviewer finds the
  // request where they look (and where auto-scroll lands): the bottom of the feed.
  const feedLogs = useMemo(() => {
    if (!actionable) return collapsedLogs;
    const activeToken = currentResumeTokenRef.current;
    const idx = collapsedLogs.findIndex((e) =>
      e.status === 'pending' && Boolean(e.details)
      && (!activeToken || e.details?.resumeToken === activeToken));
    if (idx < 0 || idx === collapsedLogs.length - 1) return collapsedLogs;
    return [...collapsedLogs.slice(0, idx), ...collapsedLogs.slice(idx + 1), collapsedLogs[idx]];
  }, [collapsedLogs, actionable]);

  useEffect(() => {
    if (continueActionable) setSubmittingContinue(false);
    else setShowResume(false);
  }, [continueActionable]);

  // Effective pick on an options gate: the reviewer's explicit selection when it
  // still names a live option, otherwise the recommended (or first) option. A
  // ref mirrors it so submitDecision reads the latest value without re-creating
  // the callback on every radio click.
  const gateOptions = approval?.options;
  const effectiveChoice = gateOptions && gateOptions.length > 0
    ? (selectedChoice && gateOptions.some((o) => o.id === selectedChoice)
      ? selectedChoice
      : gateOptions.find((o) => o.recommended)?.id ?? gateOptions[0].id)
    : undefined;
  const effectiveChoiceRef = useRef<string | undefined>(undefined);
  effectiveChoiceRef.current = effectiveChoice;

  const submitDecision = useCallback(async (action: 'approve' | 'reject' | 'comment', comment?: string, remember?: string) => {
    if (submittingDecision || !currentResumeTokenRef.current) return;
    setSubmittingDecision(action);
    setResult({ text: '⋮ submitting decision…', error: false });
    try {
      await postSessionDecision(sessionId, token, {
        status: action,
        ...(comment ? { comment } : {}),
        ...(action === 'approve' && effectiveChoiceRef.current ? { choice: effectiveChoiceRef.current } : {}),
        ...(remember ? { remember } : {}),
        resumeToken: currentResumeTokenRef.current,
        ...(projectId ? { project: projectId } : {}),
      });
      setResult({ text: '✓ decision recorded — agentuse is resuming the session.', error: false });
      setStatus('resuming');
      setNudge((n) => n + 1);
      // A handled approval changes the app-icon badge count; resync it
      // best-effort (401s silently on key-gated daemons without the header).
      void fetchApprovals().then((p) => syncAppBadge(p.buckets.pending.length)).catch(() => {});
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingDecision(null);
      // The error notice lives at the bottom of <main>, likely off-screen on a
      // long session; bring it into view so the failure isn't silent.
      noticeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [sessionId, token, projectId, submittingDecision]);

  const submitContinue = useCallback(async (prompt: string) => {
    // Unlike an approval decision, continuing an ended session needs no resume
    // token: the /continue endpoint is authorized by the view token (absent on
    // local daemons) and a completed session never carries a currentResumeToken.
    // Gating on it here made "Resume session" silently no-op on local daemons.
    if (submittingContinue || !continueActionable) return;
    setSubmittingContinue(true);
    setResult({ text: '⋮ continuing session…', error: false });
    try {
      const payload = await postSessionContinue(sessionId, token, {
        prompt,
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
      const payload = await postSessionStop(sessionId, token, {
        ...(projectId ? { project: projectId } : {}),
        reason: 'Stopped from session UI',
      });
      if (payload.rejected) {
        // A discard on a pending gate is delivered as a reject decision so the
        // agent can record it before ending — mirror the decision flow.
        setResult({ text: '✓ pending request rejected — agentuse is resuming the session so the agent records it before ending.', error: false });
        setStatus('resuming');
        setNudge((n) => n + 1);
        void fetchApprovals().then((p) => syncAppBadge(p.buckets.pending.length)).catch(() => {});
        return;
      }
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
      // Text-entry fields own their keys; radios/checkboxes (the option picker)
      // do not, so the approve/reject/comment shortcuts keep working right
      // after the reviewer picks an option.
      const targetType = target?.tagName === 'INPUT' ? (target as HTMLInputElement).type : undefined;
      const inField = Boolean(target && (
        target.tagName === 'TEXTAREA' ||
        (target.tagName === 'INPUT' && targetType !== 'radio' && targetType !== 'checkbox')
      ));
      // Single-letter shortcuts must not steal keys from any interactive element
      // (a focused link/button/select/summary/role=button/editable) or fire while
      // any dialog is open, where the letter is likely meant for that surface.
      const active = document.activeElement as HTMLElement | null;
      const inInteractive = Boolean(active?.closest('a, button, select, summary, [role="button"], [contenteditable]'));
      const anyDialogOpen = Boolean(document.querySelector('dialog[open], [role="dialog"]'));
      const canAct = actionable && !submittingDecision;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (!canAct || inField) return;
        event.preventDefault();
        void submitDecision('approve');
      } else if (event.key === 'Escape' && !inField) {
        if (!canAct) return;
        setDecisionDialog('reject');
      } else if ((event.key === 'c' || event.key === 'C') && !inField && !inInteractive && !anyDialogOpen && !event.metaKey && !event.ctrlKey && !event.altKey) {
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
        <main><Loading wrapClass="notice" label="Loading session…" /></main>
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
  const estimatedCost = pricing ? pricing.estimateSessionCostUsd(approval.model, tokenUsage) : undefined;
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

  // Verdict line for the summary-first result card: wall-clock duration
  // (createdAt → last log entry, so approval wait time counts) + tool calls.
  const lastLogTime = orderedLogs.length > 0 ? orderedLogs[orderedLogs.length - 1].time : undefined;
  const resultMeta = [
    approval.createdAt !== undefined && lastLogTime !== undefined && lastLogTime > approval.createdAt
      ? `finished in ${formatDuration(lastLogTime - approval.createdAt)}`
      : undefined,
    toolCallCount > 0 ? `${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean).join(' · ');
  // '' unless the session ended in error; leads the result card so a failed
  // run's outcome is the failure, not a mid-thought final message.
  const resultErrorText = sessionErrorText(approval);

  // Shared between the feed-first artifacts panel and the summary-first result
  // card, so the tile markup stays single-sourced.
  const artifactTiles = artifacts.length > 0 ? (
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
  ) : null;

  const debugToggle = debugCount > 0 ? (
    <label class="log-debug-toggle" title="Show debug-level operational logs">
      <input
        type="checkbox"
        checked={showDebug}
        onChange={(e) => setShowDebug((e.target as HTMLInputElement).checked)}
      />
      <span>debug</span>
      <span class="log-debug-count">{debugCount}</span>
    </label>
  ) : null;

  // The transcript feed, shared by both layouts: inline under its section
  // title (live/feed-first) or inside the collapsed <details> (summary-first).
  const logsFeed = (
    <div class="panel">
      <ul class="logs" role="log">
        {visibleLogs.length === 0 && (
          <li class="log-empty">
            {orderedLogs.length === 0
              ? 'No session events yet.'
              : `${debugCount} debug ${debugCount === 1 ? 'entry' : 'entries'} hidden. Enable the debug toggle to view.`}
          </li>
        )}
        {feedLogs.map((entry) => {
          const entryActionable = actionable && entry.status === 'pending' && Boolean(entry.details) &&
            (!currentResumeTokenRef.current || entry.details?.resumeToken === currentResumeTokenRef.current);
          return (
            <LogEntry
              key={entry.id}
              entry={entry}
              isNew={isNewLog(entry.id)}
              repeatCount={entry.repeatCount}
              warnings={entry.callId ? toolWarnings.get(entry.callId) : undefined}
              expanded={expandedIds.has(entry.id)}
              showActions={entryActionable}
              parentApproveHref={showParentApproveCta ? parentLink : undefined}
              parentApproveLabel={parentLabel}
              actionsDisabled={submittingDecision !== null}
              pendingAction={submittingDecision}
              projectId={projectId}
              sessionId={sessionId}
              token={token}
              selectedChoice={entryActionable ? effectiveChoice : undefined}
              onSelectChoice={entryActionable ? setSelectedChoice : undefined}
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
          );
        })}
        {showWorking && (
          <li class="log-item log-working">
            <span class="log-time" />
            <span class="log-marker"><span class="log-spinner" aria-label="working" /></span>
            <div class="log-main">
              <span class="log-title">{workingLabel}<span class="log-dots" aria-hidden="true" /></span>
            </div>
          </li>
        )}
      </ul>
    </div>
  );

  return (
    <div class="page-approval-detail">
      <Topbar currentPage="sessions" />
      <main>
        <div class={`session-bar${scrolled ? ' is-scrolled' : ''}`}>
          <div class="session-bar-lead">
            {isSubagentView && parentLink ? (
              <a class="session-bar-back" href={parentLink} aria-label={`Back to ${parentLabel}`} title={`Back to ${parentLabel}`}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="9 14 4 9 9 4" />
                  <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                </svg>
              </a>
            ) : !isSubagentView ? (
              <a class="session-bar-back" href="/sessions" onClick={goBack} aria-label="Back to sessions" title="Back to sessions">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </a>
            ) : null}
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
          <div class="header-title-row">
            <h1>{agentLabel}</h1>
            {!isSubagentView && approval.agent.filePath && (
              <SessionMenu
                agentName={agentLabel}
                agentFilePath={approval.agent.filePath}
                // The URL's ?project= wins, but push links and direct session
                // URLs often omit it; the header's stamped project id keeps
                // "Run new session" working on multi-project daemons.
                {...(projectId ?? approval.project ? { projectId: projectId ?? approval.project } : {})}
              />
            )}
          </div>
          {agentDescription && <p class="agent-tagline">{agentDescription}</p>}
          <p class="prompt">{promptText}</p>
          <div class="meta">
            <div class="cell"><span class="label">session</span><code>{approval.sessionId}</code></div>
            <div class="cell"><span class="label">project</span><code>{projectId ?? approval.project ?? 'default'}</code></div>
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
                <span class="value" {...(item.title ? { title: item.title } : {})}>
                  {item.num !== undefined && item.format ? <CountUpValue num={item.num} format={item.format} /> : item.value}
                </span>
                {item.gaugePctLeft !== undefined && (
                  <span class="token-gauge" role="img" aria-label={`${item.gaugePctLeft.toFixed(1)}% of the context window left`}>
                    <span class={`token-gauge-fill${gaugeTone(item.gaugePctLeft)}`} style={{ width: `${item.gaugePctLeft}%` }}></span>
                  </span>
                )}
              </div>
            ))}
            {estimatedCost !== undefined && pricing && (
              <div class="cell token-cell" key="est-cost">
                <span class="label">est. cost</span>
                <span class="value" title="Estimated from models.dev per-token pricing; cached input billed at input/10">
                  <CountUpValue num={estimatedCost} format={pricing.formatUsd} />
                </span>
              </div>
            )}
          </div>
        </header>

        {approval.additionalInstruction && (
          <div class="panel additional-instruction">
            <div class="label">additional instruction</div>
            <div class="body">{approval.additionalInstruction}</div>
          </div>
        )}

        {summaryFirst && (
          <>
            <div class="section-title result-title">
              <span>result</span>
              <span class="rule"></span>
            </div>
            <section class="panel session-result">
              <div class="result-verdict">
                <span class={`status ${displayStatus}`}>{displayStatus}</span>
                {resultMeta && <span class="result-meta">{resultMeta}</span>}
              </div>
              {recordedMetrics.length > 0 && (
                <div class="result-recorded">
                  <span class="label">recorded</span>
                  {recordedMetrics.map((m) => {
                    const amount = recordedMetricAmount(m);
                    return (
                      <a
                        key={m.metric}
                        class="metric-chip"
                        href={`/stores/metrics${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`}
                        title={m.metric}
                      >
                        <span class="metric-chip-name">{humanizeMetric(m.metric)}</span>
                        {amount && <span class="metric-chip-amount">{amount}</span>}
                      </a>
                    );
                  })}
                </div>
              )}
              {resultErrorText && <div class="result-error">{resultErrorText}</div>}
              {finalText ? (
                <div class="result-body"><LogContent value={finalText} forceMarkdown /></div>
              ) : !resultErrorText ? (
                <div class="result-empty">This run ended without a final response; the session log below has the details.</div>
              ) : null}
              {artifactTiles && (
                <div class="result-artifacts">
                  <div class="label">artifacts</div>
                  {artifactTiles}
                </div>
              )}
            </section>
          </>
        )}

        {reviewerComment && (
          <div class="panel reviewer-comment">
            <div class="label">latest reviewer comment</div>
            <div class="body"><LogContent value={reviewerComment.comment} forceMarkdown /></div>
            {reviewerComment.reviewer && <div class="meta-line">from {reviewerComment.reviewer}</div>}
          </div>
        )}

        {!summaryFirst && artifactTiles && (
          <div class="panel session-artifacts">
            <div class="label">artifacts</div>
            {artifactTiles}
          </div>
        )}
        {summaryFirst ? (
          <details class="session-transcript" key={`transcript-${sessionId}`}>
            <summary>
              <span>session log</span>
              {visibleLogs.length > 0 && (
                <span class="count">{visibleLogs.length} {visibleLogs.length === 1 ? 'entry' : 'entries'}</span>
              )}
              <span class="rule"></span>
            </summary>
            {debugToggle && <div class="transcript-tools">{debugToggle}</div>}
            {logsFeed}
          </details>
        ) : (
          <>
            <div class="section-title">
              <span>session log</span>
              <span class="rule"></span>
              {debugToggle}
            </div>
            {logsFeed}
          </>
        )}

        <div class="session-actions">
          {reopenActionable && (
            <button
              type="button"
              class="debug-prompt-button"
              disabled={submittingReopen}
              aria-busy={submittingReopen}
              onClick={() => void submitReopen()}
              title="Roll the approval gate back to pending so you can re-submit your decision and retry the resume that failed"
            >
              {submittingReopen ? (
                <span class="btn-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-3-6.7" />
                  <path d="M21 4v5h-5" />
                </svg>
              )}
              <span>{submittingReopen ? 'Reopening…' : 'Retry'}</span>
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
          {learningsVisible && (
            <button
              type="button"
              class={`session-action-button${showLearnings ? ' active' : ''}`}
              aria-expanded={showLearnings}
              aria-controls="learnings-panel"
              onClick={() => setShowLearnings((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
              </svg>
              <span>Learnings</span>
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
              aria-busy={submittingStop}
              onClick={() => void submitStop()}
              title={live
                ? 'Stop this session and any running subagents'
                : 'Discard this pending request: it is rejected, and the session resumes briefly so the agent records the rejection before ending'}
            >
              {submittingStop ? (
                <span class="btn-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  {live
                    ? <rect x="6" y="6" width="12" height="12" rx="2" />
                    : <><path d="M18 6 6 18" /><path d="M6 6 18 18" /></>}
                </svg>
              )}
              <span>{submittingStop ? (live ? 'Stopping…' : 'Discarding…') : (live ? 'Stop session' : 'Discard')}</span>
            </button>
          )}
        </div>

        <ContinuePanel
          hidden={!continueActionable || !showResume}
          disabled={submittingContinue || !continueActionable}
          busy={submittingContinue}
          onSubmit={(prompt) => void submitContinue(prompt)}
        />

        <LearningsPanel
          hidden={!learningsVisible || !showLearnings}
          sessionId={sessionId}
          token={token}
          {...(projectId ? { project: projectId } : {})}
        />

        <div class="inactive-banner" hidden={actionable || continueActionable || stopActionable || reopenActionable || live || busy}>
          This session is not accepting actions right now.
        </div>

        <p ref={noticeRef} class={`notice${result.error ? ' error' : ''}`} role={result.error ? 'alert' : 'status'}>{result.text}</p>
      </main>

      <DecisionDialog
        open={decisionDialog !== null}
        mode={decisionDialog ?? 'comment'}
        allowRemember={canRememberLearning}
        rememberApplies={rememberApplies}
        onClose={() => setDecisionDialog(null)}
        onSubmit={({ comment, remember }) => {
          const action = decisionDialog;
          setDecisionDialog(null);
          if (action) void submitDecision(action, comment, remember);
        }}
      />
    </div>
  );
}
