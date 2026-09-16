import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { ApprovalLogEntry, ApprovalPageInfo, LogSubagentSession, LogVerifySummary } from '../../types';
import { CandidateVerdictList, LogEntry, artifactKind, toolChipLabel, type PriorReview } from '../components/log-entry';
import { InlineMarkdown, LogContent } from '../components/content';
import { DecisionDialog, type DecisionDialogMode } from '../components/comment-dialog';
import { ContinuePanel } from '../components/continue-panel';
import { LearningsPanel } from '../components/learnings-panel';
import { DebugPromptButton } from '../components/debug-prompt-button';
import { AgentRevisionLauncher, AgentRevisionSessionPanel, type AgentRevisionSessionIdentity } from '../components/agent-revision';
import { ChangesetSessionPanel } from '../components/changeset-session-panel';
import { SessionMenu } from '../components/session-menu';
import { Loading } from '../components/loading';
import { postSessionDecision, postSessionContinue, postSessionResume, postSessionStop, postSessionReopen, postSessionReviewed, fetchSessionArtifacts, fetchApprovals, type SessionArtifact } from '../lib/api';
import { syncAppBadge } from '../lib/badge';
import { writeClipboardText } from '../lib/clipboard';
import { useApprovalStream } from '../hooks/use-approval-stream';
import { useGlobalApprovals } from '../hooks/use-global-approvals';
import { useTitle } from '../hooks/use-title';
import { useSmartBack } from '../hooks/use-smart-back';
import {
  formatTokens,
  formatApprovalTime,
  formatLogTime,
  humanizeMetric,
  isDebugLog,
  isEndedStatus,
  isLiveStatus,
  isWorkingStatus,
  latestReviewerComment,
  logEntrySignature,
  sessionErrorText,
  splitOutcomeHeadline,
} from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';
import { ONBOARDING_AGENT_NAME, ONBOARDING_MODEL } from '../../../../onboarding';

type ApprovalHeader = Omit<ApprovalPageInfo, 'logs'>;

// A render-time entry that may carry a collapsed repeat count. Produced only when
// preparing entries for display; the underlying logsRef entries are never mutated.
type PreparedLogEntry = ApprovalLogEntry & { repeatCount?: number };

export function sessionResumeMode(options: {
  ended: boolean;
  live: boolean;
  cascadeRetryable?: boolean;
  hasAgentFile: boolean;
  fatal: boolean;
  revision: boolean;
}): 'cascade' | 'continue' | null {
  if (!options.ended || options.live || options.fatal || options.revision) return null;
  if (options.cascadeRetryable && options.hasAgentFile) return 'cascade';
  return options.hasAgentFile ? 'continue' : null;
}

/** The one word that says what this page is for right now. Every card, bar
 *  and menu reads it instead of re-deriving the answer from raw status
 *  strings. `idle` is a page with nothing to do: an expired gate, a stranded
 *  run, a run parked at a gate that is not this reader's to decide, an ended
 *  run with no result. A delegated child viewed directly is not a mode of its
 *  own: it takes whichever of these fits and gets the view-only overlay on
 *  top (a label, a meta note, a way back to the parent; see nowCardLabel). */
export type SessionPageMode = 'decision' | 'working' | 'error' | 'result' | 'idle';

export function sessionPageMode(options: {
  /** An actionable gate is on the page: pending, not expired, entry found. */
  gate: boolean;
  ended: boolean;
  /** The agent or a delegated sub-agent is doing work right now. Narrower
   *  than "live": a run parked at a gate is live but not working, and an
   *  expired or stranded gate must not read as progress. */
  working: boolean;
  /** Ended with an error the page can show. */
  failed: boolean;
  /** Ended with something to show: outcome, timings, artifacts. */
  hasResult: boolean;
}): SessionPageMode {
  if (options.gate) return 'decision';
  if (options.ended) return options.failed ? 'error' : options.hasResult ? 'result' : 'idle';
  return options.working ? 'working' : 'idle';
}

/** The head label of the now card. The view-only overlay wins only while the
 *  child is parked at its parent's gate; otherwise the mode names the card. */
export function nowCardLabel(options: {
  mode: SessionPageMode;
  viewOnly: boolean;
  /** Raw session status is suspended: parked at an approval gate. */
  suspended: boolean;
  ended: boolean;
  preparing: boolean;
  /** The gate is a review escalation asking for revision guidance. */
  escalation: boolean;
}): string {
  if (options.viewOnly && options.suspended) return "Paused for the parent's decision";
  switch (options.mode) {
    case 'decision': return options.escalation ? 'Revision needs your input' : 'Decision needed';
    case 'working': return options.preparing ? 'Preparing' : 'Working';
    case 'error': return 'Needs attention';
    case 'result': return 'Result';
    case 'idle': return options.ended ? 'Ended' : 'Paused';
  }
}

/** Decision and working pages fold the transcript on every visit: the card is
 *  the surface, and a log that starts open would push it off screen. Every
 *  other page follows the reader's remembered preference. */
export function transcriptFoldsPerVisit(mode: SessionPageMode): boolean {
  return mode === 'decision' || mode === 'working';
}

export function sessionTranscriptFoldedCopy(mode: SessionPageMode): string {
  if (mode === 'decision') return 'folded while a decision is pending';
  if (mode === 'working') return 'folded while the run is working';
  return 'folded, the summary is above';
}

const EXECUTING_SUBAGENT_STATUSES = new Set([
  'preparing', 'running', 'resuming', 'continuing', 'run', 'revising',
]);

const ATTENTION_SUBAGENT_STATUSES = new Set([
  'error', 'failed', 'incomplete',
]);

const ATTENTION_REPORT_STATUSES = new Set([
  'incomplete', 'fail', 'error',
]);

/** Latest activity timestamp within an executing delegated branch. A parent
 * card can be suspended or pending while a resumed child below it is actively
 * revising, so inspect the full projected tree rather than the log row status. */
function executingSubagentUpdatedAt(session: LogSubagentSession): number | undefined {
  const ownExecuting = session.activity?.running === true
    || EXECUTING_SUBAGENT_STATUSES.has(session.status)
    || EXECUTING_SUBAGENT_STATUSES.has(session.displayStatus);
  const childUpdatedAt = (session.children ?? [])
    .map(executingSubagentUpdatedAt)
    .filter((value): value is number => value !== undefined)
    .reduce<number | undefined>((latest, value) => latest === undefined || value > latest ? value : latest, undefined);
  if (!ownExecuting) return childUpdatedAt;
  return childUpdatedAt === undefined ? session.updatedAt : Math.max(session.updatedAt, childUpdatedAt);
}

/** The single row that best answers “what is working now?” Delegated activity
 * wins over raw tool state because a stale nested Code Mode call can remain
 * marked running after the parent has moved on to a resumed sub-agent. */
export function workingSessionEntry(entries: readonly ApprovalLogEntry[]): ApprovalLogEntry | undefined {
  const delegated = entries
    .flatMap((entry) => {
      const updatedAt = entry.subagentSession ? executingSubagentUpdatedAt(entry.subagentSession) : undefined;
      return updatedAt === undefined ? [] : [{ entry, updatedAt }];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || (b.entry.time ?? 0) - (a.entry.time ?? 0));
  return delegated[0]?.entry
    ?? [...entries].reverse().find((entry) =>
      entry.type === 'tool' && entry.status === 'running' && !entry.parentCallId
    );
}

/** Latest activity timestamp within a delegated branch that ended needing
 * attention. A delegated tool row can itself be `completed` even when the
 * child's terminal report is incomplete, so the report and descendants are
 * authoritative rather than the wrapper row's status. */
function attentionSubagentUpdatedAt(session: LogSubagentSession): number | undefined {
  const ownNeedsAttention = Boolean(session.errorMessage)
    || ATTENTION_SUBAGENT_STATUSES.has(session.status)
    || ATTENTION_SUBAGENT_STATUSES.has(session.displayStatus)
    || (session.report ? ATTENTION_REPORT_STATUSES.has(session.report.status) : false);
  const childUpdatedAt = (session.children ?? [])
    .map(attentionSubagentUpdatedAt)
    .filter((value): value is number => value !== undefined)
    .reduce<number | undefined>((latest, value) => latest === undefined || value > latest ? value : latest, undefined);
  if (!ownNeedsAttention) return childUpdatedAt;
  return childUpdatedAt === undefined ? session.updatedAt : Math.max(session.updatedAt, childUpdatedAt);
}

/** The row that best explains why an ended session needs attention. Prefer a
 * delegated branch with an incomplete or failed terminal report over an older
 * incidental tool error that the run continued past. */
export function failedSessionEntry(entries: readonly ApprovalLogEntry[]): ApprovalLogEntry | undefined {
  const delegated = entries
    .flatMap((entry) => {
      const updatedAt = entry.subagentSession ? attentionSubagentUpdatedAt(entry.subagentSession) : undefined;
      return updatedAt === undefined ? [] : [{ entry, updatedAt }];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || (b.entry.time ?? 0) - (a.entry.time ?? 0));
  const directFailure = [...entries].reverse().find((entry) =>
    entry.type === 'tool'
    && (entry.status === 'error' || entry.status === 'failed')
    && !entry.parentCallId
    && !entry.details?.recoveredByCallId
  );
  const delegatedFailure = delegated[0];
  if (!delegatedFailure) return directFailure;
  if (!directFailure) return delegatedFailure.entry;
  return delegatedFailure.updatedAt >= (directFailure.time ?? 0)
    ? delegatedFailure.entry
    : directFailure;
}

export type SessionRunControl = {
  id: 'retry' | 'revise' | 'resume' | 'cascade' | 'stop' | 'discard';
  label: string;
  title: string;
  icon: 'retry' | 'edit' | 'resume' | 'stop';
  busy: boolean;
  /** `bar`: pinned in the sticky session bar (the one ending control a run
   *  offers: Stop while it runs, Discard once it is parked or failed).
   *  `menu`: the header ⋯ menu, or the inline row on a page that has no menu. */
  placement: 'bar' | 'menu';
};

/** Every run-level control the page offers, in display order, from one place.
 *  The menu, the bar and the fallback row all render this list; none of them
 *  decides on its own whether a control exists. */
export function sessionRunControls(options: {
  ended: boolean;
  live: boolean;
  atGate: boolean;
  hasAgentFile: boolean;
  revision: boolean;
  reopenable: boolean;
  resume: 'cascade' | 'continue' | null;
  /** A run that has not ended can be stopped (or, parked at a gate, discarded). */
  stoppable: boolean;
  /** A failed run can be dismissed from "Needs your attention". */
  dismissable: boolean;
  busy: { reopen: boolean; resume: boolean; stop: boolean };
}): SessionRunControl[] {
  const controls: SessionRunControl[] = [];
  if (options.reopenable) {
    controls.push({
      id: 'retry',
      label: options.busy.reopen ? 'Reopening…' : 'Retry',
      title: 'Roll the approval gate back to pending so you can re-submit your decision and retry the resume that failed',
      icon: 'retry',
      busy: options.busy.reopen,
      placement: 'menu',
    });
  }
  if (options.hasAgentFile && !options.revision && (options.ended || options.atGate)) {
    controls.push({
      id: 'revise',
      label: 'Revise agent file',
      title: "Diagnose this run and propose a change to this agent's source",
      icon: 'edit',
      busy: false,
      placement: 'menu',
    });
  }
  if (options.resume === 'continue') {
    controls.push({
      id: 'resume',
      label: 'Resume session',
      title: 'Continue this run with a new instruction',
      icon: 'resume',
      busy: false,
      placement: 'menu',
    });
  } else if (options.resume === 'cascade') {
    controls.push({
      id: 'cascade',
      label: options.busy.resume ? 'Resuming…' : 'Resume',
      title: 'Resume this run where its delegated sub-agent left off',
      icon: 'resume',
      busy: options.busy.resume,
      placement: 'menu',
    });
  }
  if (options.stoppable && options.live) {
    controls.push({
      id: 'stop',
      label: options.busy.stop ? 'Stopping…' : 'Stop',
      title: 'Stop this session and any running subagents',
      icon: 'stop',
      busy: options.busy.stop,
      placement: 'bar',
    });
  } else if (options.stoppable) {
    controls.push({
      id: 'discard',
      label: options.busy.stop ? 'Discarding…' : 'Discard',
      title: 'Discard this pending request: it is rejected, and the session resumes briefly so the agent records the rejection before ending',
      icon: 'stop',
      busy: options.busy.stop,
      placement: 'bar',
    });
  } else if (options.dismissable) {
    controls.push({
      id: 'discard',
      label: options.busy.stop ? 'Discarding…' : 'Discard',
      title: 'Discard this failed run: marks it reviewed and clears it from "Needs your attention" (the run keeps its status)',
      icon: 'stop',
      busy: options.busy.stop,
      placement: 'bar',
    });
  }
  return controls;
}

export function sessionLogSearchTerms(query: string): string[] {
  return [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
}

/** Match the text carried by a rendered session-log entry. Multiple words use
 * AND semantics so a specific query narrows rather than broadens the feed. */
export function sessionLogMatches(
  entry: ApprovalLogEntry,
  query: string,
  nestedEntries: readonly ApprovalLogEntry[] = [],
): boolean {
  const terms = sessionLogSearchTerms(query);
  if (terms.length === 0) return true;
  // Sub-agent cards and their important descendants live on top-level fields
  // such as subagentSession, not only in details. Index the complete durable
  // entry so every piece of transcript text the row can render is searchable.
  const haystack = JSON.stringify([entry, ...nestedEntries]).toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** A nested Code Mode call remains grouped under its program row. Open that row
 * while a query names content inside a child, otherwise the kept search result
 * would not actually contain the matching DOM for a reader to inspect. */
export function shouldExpandForNestedSearch(
  query: string,
  nestedEntries: readonly ApprovalLogEntry[] | undefined,
): boolean {
  const terms = sessionLogSearchTerms(query);
  if (terms.length === 0 || !nestedEntries?.length) return false;
  return nestedEntries.some((entry) => {
    const text = JSON.stringify(entry).toLocaleLowerCase();
    return terms.some((term) => text.includes(term));
  });
}

/** Entry-type filter for the session log. 'agent' = the model's own spine
 *  (text/reasoning), 'tools' = tool calls, 'errors' = anything that failed. */
export type LogFilter = 'all' | 'agent' | 'tools' | 'errors';

/** Does an entry survive the type filter? The pending approval gate always
 *  does — filtering the decision you're here to make off the page is never
 *  what the reviewer meant. */
export function matchesLogFilter(
  entry: ApprovalLogEntry,
  filter: LogFilter,
  nestedEntries: readonly ApprovalLogEntry[] = [],
): boolean {
  const entries = [entry, ...nestedEntries];
  if (filter === 'all' || entry.type === 'approval') return true;
  if (filter === 'agent') return entries.some((candidate) => candidate.type === 'text' || candidate.type === 'reasoning');
  if (filter === 'tools') return entries.some((candidate) => candidate.type === 'tool');
  return entries.some((candidate) =>
    candidate.type === 'error' || candidate.status === 'error' || candidate.status === 'failed' || candidate.level === 'error');
}

/** Nested calls remain grouped, but a matching child must open with its parent
 * so the filtered error or searched text is visible rather than only counted. */
export function nestedCallIdsToExpand(
  query: string,
  filter: LogFilter,
  nestedEntries: readonly ApprovalLogEntry[] | undefined,
): ReadonlySet<string> {
  const terms = sessionLogSearchTerms(query);
  const ids = new Set<string>();
  for (const entry of nestedEntries ?? []) {
    const text = terms.length > 0 ? JSON.stringify(entry).toLocaleLowerCase() : '';
    const matchesSearch = terms.some((term) => text.includes(term));
    const matchesErrorFilter = filter === 'errors' && matchesLogFilter(entry, 'errors');
    if (matchesSearch || matchesErrorFilter) ids.add(entry.id);
  }
  return ids;
}

/** Per-session view state, kept across in-app navigations so stepping into a
 *  sub-agent and back doesn't re-collapse the parent's log, drop its search, or
 *  throw away the reader's scroll position. Module-level (not state) because the
 *  router reuses this component instance across /sessions/:id. */
interface SessionViewState {
  expandOverrides: Map<string, boolean>;
  logQuery: string;
  showLogSearch: boolean;
  logsLimit: number;
  transcriptOpen: boolean;
  scrollY: number;
}
const sessionViewState = new Map<string, SessionViewState>();

/** Transcript disclosure for a session with no banked state: the remembered
 *  preference, defaulting to open. */
export function transcriptDefaultOpen(): boolean {
  try { return localStorage.getItem('agentuse:session:transcriptOpen') !== '0'; } catch { return true; }
}
const SESSION_VIEW_STATE_CAP = 20;

export function rememberSessionViewState(id: string, next: SessionViewState): void {
  sessionViewState.delete(id);
  sessionViewState.set(id, next);
  while (sessionViewState.size > SESSION_VIEW_STATE_CAP) {
    const oldest = sessionViewState.keys().next().value;
    if (oldest === undefined) break;
    sessionViewState.delete(oldest);
  }
}

export function headerTokenUsage(
  approval: Pick<ApprovalPageInfo, 'sessionStatus' | 'tokenUsage'> | null
): ApprovalPageInfo['tokenUsage'] | undefined {
  return approval?.tokenUsage;
}

/** The ended-session Result card already owns the durable terminal error. Keep
 * the bottom notice for transient action feedback, but never repeat that same
 * error after the actions. */
export function shouldShowResultNotice(
  result: { text: string; error: boolean },
  hasResultCard: boolean,
  resultErrorText: string
): boolean {
  return Boolean(result.text)
    && !(hasResultCard && result.error && result.text === resultErrorText);
}

/** The identifier itself is the copy target, with inline confirmation so the
 * interaction stays discoverable without adding another metadata control. */
export function SessionIdCopy(props: { sessionId: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, [props.sessionId]);

  const copy = async () => {
    if (!await writeClipboardText(props.sessionId)) return;
    setCopied(true);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <button
      type="button"
      class={`session-id-copy${copied ? ' is-copied' : ''}`}
      aria-label={`Copy session ID ${props.sessionId}`}
      title={copied ? 'Session ID copied' : 'Copy session ID'}
      onClick={() => void copy()}
    >
      <code>{props.short && props.sessionId.length > 14 ? `${props.sessionId.slice(0, 8)}…${props.sessionId.slice(-4)}` : props.sessionId}</code>
      <span class="session-id-copy-status" aria-live="polite">{copied ? 'copied' : ''}</span>
    </button>
  );
}

/** One business fact the run recorded via the record_metric tool. */
interface RecordedMetric {
  metric: string;
  count?: number;
  value?: number;
  unit?: string;
}

/** One tool id's call tally for the header stat band. */
export interface ToolStat {
  /** Raw tool id, e.g. `tools__bash`. The grouping key and the row's tooltip. */
  tool: string;
  /** Chip text shown to the reader, e.g. `bash`. */
  label: string;
  count: number;
  failed: number;
}

/**
 * Roll a session's tool calls up by tool id, busiest first: which commands the
 * run leaned on, how often, and how many of those calls failed. Grouped on the
 * raw id (so `tools__bash` and `sandbox__bash` stay distinct) and labelled with
 * the same chip text the log rows use.
 */
export function aggregateToolStats(logs: ApprovalLogEntry[]): ToolStat[] {
  const byTool = new Map<string, ToolStat>();
  for (const entry of logs) {
    if (entry.type !== 'tool') continue;
    const tool = entry.tool || entry.title || 'tool';
    const stat = byTool.get(tool) ?? { tool, label: toolChipLabel(tool), count: 0, failed: 0 };
    stat.count += 1;
    if (entry.status === 'error' || entry.status === 'failed') stat.failed += 1;
    byTool.set(tool, stat);
  }
  return [...byTool.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** "$12,400" / "3,200 words" / "+2" — the amount half of a recorded-metric chip. */
function recordedMetricAmount(m: RecordedMetric): string {
  if (typeof m.value === 'number') {
    const num = m.value.toLocaleString();
    return m.unit === 'usd' ? `$${num}` : m.unit ? `${num} ${m.unit}` : num;
  }
  return typeof m.count === 'number' ? `+${m.count.toLocaleString()}` : '';
}

/** One judge verdict for the hoisted panel: the session's own verify markers
 * plus every verify event under its important descendants, oldest first. */
export interface JudgeRow {
  /** Zero-based attempt within its gate cycle; resets on a retry gate. */
  attempt: number;
  id: string;
  time: number;
  verdict: LogVerifySummary['verdict'];
  attemptLabel: string;
  judge?: string;
  critique?: string;
  candidates?: LogVerifySummary['candidates'];
  owner?: string;
  href: string;
}

/**
 * This session's OWN verify markers only. Descendant verdicts used to be walked
 * in here too, but a judge child now renders its verdict on its own card in the
 * tree, so collecting them again printed every judge result twice.
 */
export function collectJudgeRows(logs: ApprovalLogEntry[]): JudgeRow[] {
  const rows: JudgeRow[] = [];
  for (const entry of logs) {
    if (entry.type !== 'verify' || !entry.verify) continue;
    rows.push({
      id: entry.id,
      time: entry.time ?? 0,
      verdict: entry.verify.verdict,
      attempt: entry.verify.attempt,
      attemptLabel: `Attempt ${entry.verify.attempt + 1} of ${entry.verify.maxAttempts}`,
      ...(entry.verify.judge && { judge: entry.verify.judge }),
      ...(entry.verify.critique && { critique: entry.verify.critique }),
      ...(entry.verify.candidates && { candidates: entry.verify.candidates }),
      href: `#log-${encodeURIComponent(entry.id)}`,
    });
  }
  rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  // Point each attempt at the judge's own run, where its reasoning lives,
  // rather than at the verify marker in this log, which only repeats the
  // verdict the row already shows. A verify marker does not name the judge
  // session; the gate it fed does (details.judge.sessionHref). One judge
  // session is resumed across the attempts of one gate cycle, and a cycle
  // restarts when the attempt counter drops back to 0 (a retry gate). So:
  // group rows into cycles, then give each cycle the href of the first
  // linked gate that follows its rows.
  const cycles: { rows: JudgeRow[]; href?: string }[] = [];
  for (const row of rows) {
    const last = cycles[cycles.length - 1];
    if (!last || row.attempt <= (last.rows[last.rows.length - 1]?.attempt ?? -1)) cycles.push({ rows: [row] });
    else last.rows.push(row);
  }
  const gates = logs
    .filter((entry) => entry.details?.judge?.sessionHref)
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const gate of gates) {
    const gateTime = gate.time ?? 0;
    const cycle = [...cycles].reverse().find((c) => c.rows.some((row) => row.time <= gateTime));
    if (cycle && !cycle.href) cycle.href = gate.details!.judge!.sessionHref!;
  }
  for (const cycle of cycles) {
    if (!cycle.href) continue;
    for (const row of cycle.rows) row.href = cycle.href;
  }
  return rows;
}

/**
 * The judge's verdicts, above the fold. The verify markers live inside the
 * session log, which a finished session folds shut by default, so the one
 * thing a reviewer needs to know about a draft that bounced ("which candidate
 * failed, and why") was the thing they never saw. Same placement reasoning as
 * the learnings panel below it.
 */
export function JudgePanel(props: {
  rows: JudgeRow[];
  /** The live gate card already carries the latest verdict on its candidates,
   *  so when one is on the page this panel is a repeat and starts folded. With
   *  no gate showing it, a non-pass verdict is the page's headline and opens. */
  gateVisible?: boolean;
}) {
  if (props.rows.length === 0) return null;
  const last = props.rows[props.rows.length - 1]!;
  const earlier = props.rows.slice(0, -1);
  const failed = props.rows.filter((row) => row.verdict === 'fail').length;
  const open = !props.gateVisible && last.verdict !== 'pass';
  const lede = last.verdict === 'pass'
    ? failed > 0 ? `passed after ${failed} bounce${failed === 1 ? '' : 's'}` : 'passed first time'
    : last.verdict === 'fail'
      ? 'still failing · escalated to you'
      : last.verdict === 'skipped'
        ? 'not judged · escalated to you'
        : 'not reviewed · judge error';
  return (
    <details class="panel judge-panel" aria-label="Judge verdicts" open={open}>
      <summary class="judge-panel-head">
        <span class="judge-label">judge</span>
        <span class={`chip status ${last.verdict === 'pass' ? 'completed' : last.verdict === 'skipped' ? 'skipped' : 'error'}`}>{lede}</span>
        <span class="judge-panel-count">{props.rows.length} {props.rows.length === 1 ? 'attempt' : 'attempts'}</span>
      </summary>
      {/* Only the latest verdict stays open. Earlier attempts repeat the same
          three-candidate critique with small deltas, and each folded gate in
          the log carries its own copy, so printing every round here made the
          page three critiques tall before the reviewer reached the decision. */}
      {earlier.length > 0 && (
        <details class="judge-earlier">
          <summary>{earlier.length} earlier {earlier.length === 1 ? 'attempt' : 'attempts'}</summary>
          <ol class="judge-rows">
            {earlier.map((row) => <JudgeRowItem key={row.id} row={row} />)}
          </ol>
        </details>
      )}
      <ol class="judge-rows">
        <JudgeRowItem row={last} />
      </ol>
    </details>
  );
}

function JudgeRowItem(props: { row: JudgeRow }) {
  const { row } = props;
  return (
    <li class={`judge-row is-${row.verdict}`}>
      <a class="judge-row-head" href={row.href}>
        <span class="judge-row-mark" aria-hidden="true">{row.verdict === 'pass' ? '✓' : row.verdict === 'fail' ? '✗' : row.verdict === 'skipped' ? '–' : '⚠'}</span>
        <span class="judge-row-attempt">{row.attemptLabel}</span>
        {row.owner && <span class="judge-row-owner">{row.owner}</span>}
        {row.judge && <code class="judge-row-judge">{row.judge}</code>}
        <time dateTime={new Date(row.time).toISOString()}>{formatLogTime(row.time)}</time>
      </a>
      {row.candidates && row.candidates.length > 0
        ? <CandidateVerdictList candidates={row.candidates} />
        : row.critique && <p class="judge-row-critique">{row.critique}</p>}
    </li>
  );
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

/**
 * Put the pending gate's card at the top of the viewport. Returns false when the
 * gate has not rendered yet, so the caller can retry on a later commit.
 *
 * The decision row sits at the BOTTOM of a gate card, and those cards run well
 * past a viewport (1200px is ordinary), so jumping to the document end lands the
 * reviewer on the buttons with the quoted original and every candidate scrolled
 * off the top, behind them. A gate reads top-down: what you are replying to, then
 * the options, then the commitment.
 */
/** The element the reviewer must reach: the approval question itself. A
 *  cascade gate wraps a delegated-run tree above that question, and the tree
 *  can run 10,000px on a manager with many children, so landing on the gate
 *  item's top leaves the reviewer a long way from the thing they came to read. */
function actionableGateTarget(): Element | null {
  const gate = document.querySelector('.log-item.is-actionable');
  if (!gate) return null;
  return gate.querySelector('.approval-card') ?? gate;
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

/** The one word the header says about this run, and the only place the page
 *  says it. Plain English rather than a raw status token: a reader should not
 *  have to know that `incomplete` means the agent stopped before reporting.
 *  `tone` drives the status dot's colour; nothing else on the page carries it. */
export function sessionStatusWord(options: {
  /** displaySessionStatus output. */
  status: string;
  mode: SessionPageMode;
  expired: boolean;
  stranded: boolean;
  suspended: boolean;
  ended: boolean;
}): { word: string; tone: 'ok' | 'bad' | 'wait' | 'busy' } {
  if (options.expired) return { word: 'Expired', tone: 'wait' };
  if (options.mode === 'decision') return { word: 'Needs your decision', tone: 'wait' };
  if (options.stranded) return { word: 'Stuck', tone: 'bad' };
  switch (options.status) {
    case 'timeout': return { word: 'Timed out', tone: 'bad' };
    case 'stopped': return { word: 'Stopped', tone: 'bad' };
    case 'incomplete': return { word: 'Incomplete', tone: 'bad' };
    case 'error':
    case 'failed': return { word: 'Failed', tone: 'bad' };
    case 'completed': return { word: 'Completed', tone: 'ok' };
    case 'preparing': return { word: 'Preparing', tone: 'busy' };
    case 'resuming': return { word: 'Resuming', tone: 'busy' };
    case 'loading': return { word: 'Loading', tone: 'busy' };
  }
  if (options.mode === 'working') return { word: 'Working', tone: 'busy' };
  if (options.suspended) return { word: 'Paused', tone: 'wait' };
  if (options.ended) return { word: 'Ended', tone: 'ok' };
  return { word: options.status.charAt(0).toUpperCase() + options.status.slice(1), tone: 'busy' };
}

/** A timed-out run writes the same sentence four times on its way out: the
 *  sub-agent's failure, an operational warn, "Session failed", and the run
 *  error row. Collapse a trailing run of error/warn entries that carry the
 *  same message into the last one. Display-only: it runs on a fresh array at
 *  render-preparation time and never touches the stored log. */
export function collapseTrailingRunErrors<T extends ApprovalLogEntry>(entries: readonly T[]): T[] {
  const errorish = (entry: ApprovalLogEntry): boolean =>
    entry.type === 'error'
    || (entry.type === 'session' && entry.status === 'error')
    || (entry.type === 'log' && (entry.level === 'error' || entry.level === 'warn'))
    || (entry.type === 'tool' && (entry.status === 'error' || entry.status === 'failed'));
  // The same failure arrives worded four ways: as a title, as a message, with
  // a "[SubAgent] X failed: " prefix, behind a warning emoji, and with an em
  // dash where the next one has a hyphen. Normalize all of that away first.
  const core = (entry: ApprovalLogEntry): string => {
    const raw = (entry.message ?? entry.title ?? '')
      .replace(/[–—]/g, '-')
      .replace(/^[^\p{L}\p{N}[]+/u, '')
      .trim()
      .toLocaleLowerCase();
    const prefixed = /^\[[^\]]{1,40}\][^:]{0,40}:\s*(.+)$/s.exec(raw);
    return (prefixed?.[1] ?? raw).replace(/\s+/g, ' ').trim();
  };
  /** Two lines are the same failure when they open the same way. The shared
   *  opening has to be long enough not to match on a stock phrase, and a real
   *  fraction of the shorter line. */
  const sameFailure = (a: string, b: string): boolean => {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i += 1;
    return i >= 16 && i >= limit * 0.25;
  };
  let start = entries.length;
  while (start > 0 && errorish(entries[start - 1] as ApprovalLogEntry)) start -= 1;
  const tail = entries.slice(start);
  // A single trailing error is already said once; a sub-agent row carries its
  // own status and never folds away.
  if (tail.length < 2) return [...entries];
  const last = tail[tail.length - 1] as ApprovalLogEntry;
  // The run's closing row is often a bare "Session failed" with no text, so
  // the sentence to keep is the longest one anywhere in the trailing run.
  const anchorEntry = tail
    .map((entry) => entry as ApprovalLogEntry)
    .filter((entry) => !entry.subagentSession && entry.type !== 'session')
    .reduce<ApprovalLogEntry | undefined>(
      (best, entry) => best === undefined || core(entry).length > core(best).length ? entry : best,
      undefined,
    );
  const anchor = anchorEntry ? core(anchorEntry) : '';
  if (!anchor) return [...entries];
  const foldable = tail.filter((entry) => {
    const row = entry as ApprovalLogEntry;
    if (row.subagentSession) return false;
    // A `session` row is the runtime's terminal marker. It never carries
    // anything the error row beside it does not already say.
    if (row.type === 'session') return true;
    const text = core(row);
    return text === '' || sameFailure(text, anchor);
  });
  if (foldable.length < 2) return [...entries];
  const foldedIds = new Set(foldable.filter((entry) => entry.id !== last.id).map((entry) => entry.id));
  if (foldedIds.size === 0) return [...entries];
  return entries.filter((entry) => !foldedIds.has(entry.id)).map((entry) =>
    entry.id === last.id
      ? { ...entry, title: 'Session failed', message: entry.message ?? anchorEntry?.message ?? anchorEntry?.title }
      : entry
  );
}

/** The one sentence an error card leads with. The header already says the run
 *  timed out, so the headline drops the "Session finished with an error:
 *  TIMEOUT:" scaffolding and says only what happened. */
export function sessionFailureHeadline(options: {
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  fallback: string;
}): string {
  const message = options.errorMessage?.trim();
  if (!message) return options.fallback;
  const sentence = message.split(/\n\s*\n/)[0].trim();
  return sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1);
}

export function hasActionableApproval(status: string, header: ApprovalHeader | null): boolean {
  if (!header?.currentResumeToken) return false;
  return status === 'waiting' || (status === 'loading' && header.sessionStatus === 'suspended');
}

/** Fire-and-forget decision/continue endpoints report a later worker failure
 * through the streamed session header. Recognize both families so the busy
 * decision row is released and the retryable server error reaches the page. */
export function isBackgroundSessionActionFailure(message: string | undefined): boolean {
  if (!message) return false;
  return message.startsWith("Couldn't continue this session:")
    || /^Couldn't (?:approve|reject|send your comment on|act on) this request:/.test(message);
}

/** The streamed header and the local pending flag can update on different
 * frames after a decision is accepted. Status is authoritative: once the run
 * is resuming, the old gate must stop looking actionable immediately instead
 * of lingering as "sending comment…" while the agent is already working. */
export function isActionableApproval(options: {
  pending: boolean;
  status: string;
  header: ApprovalHeader | null;
  expired: boolean;
}): boolean {
  return options.pending
    && !options.expired
    && hasActionableApproval(options.status, options.header);
}

/** A sibling gate in the pending queue: just enough to label it and link to it. */
export interface QueuedApproval {
  sessionId: string;
  project: string;
  agentName: string;
}

export function withoutQueuedApproval(
  queue: QueuedApproval[],
  approval: Pick<QueuedApproval, 'sessionId'> & Partial<Pick<QueuedApproval, 'project'>>
): QueuedApproval[] {
  return queue.filter((row) => row.sessionId !== approval.sessionId
    || (approval.project !== undefined && row.project !== approval.project));
}

export default function SessionDetail() {
  const { params } = useRoute();
  const location = useLocation();
  const goBack = useSmartBack('/sessions');
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  const token = location.query.token || undefined;
  const projectId = location.query.project || undefined;
  const globalApprovals = useGlobalApprovals();
  // The diagnostic subpage, carrying whatever authorises this view.
  const diagnosticHref = (() => {
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (projectId) params.set('project', projectId);
    const query = params.toString();
    return `/sessions/${encodeURIComponent(sessionId)}/context${query ? `?${query}` : ''}`;
  })();
  // Arrived from a just-started detached run: tolerate a brief "not found" while
  // the worker is still writing the session to disk.
  const pending = location.query.pending === '1';

  useTitle(pageTitle('Session'));

  const [approval, setApproval] = useState<ApprovalHeader | null>(null);
  const [status, setStatus] = useState<string>('loading');
  const [logsVersion, setLogsVersion] = useState(0);
  // Explicit expand/collapse per log row. Absent = follow the row's own default
  // (open while running, closed when finished), so a reviewer's choice survives
  // the tool completing but an untouched row tidies itself up.
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [pendingActionable, setPendingActionable] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState<'approve' | 'reject' | 'comment' | null>(null);
  // Reviewer's pick on a pick-among-options gate. null = no explicit pick yet;
  // the effective selection then falls back to the recommended (or first)
  // option, so approve is always well-defined on an options gate.
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  // Sibling gates awaiting a decision, so a reviewer working through a backlog can
  // move to the next one without going back to the approvals list.
  const [pendingQueue, setPendingQueue] = useState<QueuedApproval[]>([]);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [submittingContinue, setSubmittingContinue] = useState(false);
  const [submittingStop, setSubmittingStop] = useState(false);
  // Discard on an ended failed run just happened: hides the button immediately,
  // before the refetched header carries dismissedAt.
  const [justDismissed, setJustDismissed] = useState(false);
  const [submittingReopen, setSubmittingReopen] = useState(false);
  // The resume composer stays collapsed until the user clicks "Resume session";
  // clicking again collapses it.
  const [showResume, setShowResume] = useState(false);
  // Bumped by the session menu's "Revise agent file" while a decision is
  // pending; the launcher (still mounted under the card) opens on change.
  const [reviseRequest, setReviseRequest] = useState(0);
  const [result, setResult] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  // Terminal load failures (unauthorized, not found, corrupted session data):
  // the page can't recover, so we render this instead of the live view.
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [isRevisionSession, setIsRevisionSession] = useState(false);
  const [revisionIdentity, setRevisionIdentity] = useState<AgentRevisionSessionIdentity | null>(null);
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogMode | null>(null);
  const [nudge, setNudge] = useState(0);
  // Project artifacts this run produced, from the artifact manifest. Refetched as
  // the log grows so newly written artifacts appear without a page reload.
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  // "Run again" on an ended run: a fresh detached session of the same agent.
  // Artifact manifests change only when artifact_save completes. Keeping this
  // separate from logsVersion prevents an initial SSE transcript replay from
  // turning N historical log entries into N manifest requests.
  const [artifactRevision, setArtifactRevision] = useState(0);
  const [logsLimit, setLogsLimit] = useState(400);
  const [logsTotal, setLogsTotal] = useState<number | null>(null);
  const [logQuery, setLogQuery] = useState('');
  const [showLogSearch, setShowLogSearch] = useState(false);
  // Whether the summary-first transcript is open. Open by default: a collapsed
  // log reads as absent rather than as available, so the common path was opening
  // it by hand on every finished run. Collapsing it is remembered, so anyone who
  // does want the tidy summary-only view keeps it. Controlled rather than left to
  // the uncontrolled <details> so it can also be banked per session -- and a
  // re-collapsed transcript leaves the page too short for the scroll restore
  // below to land anywhere useful.
  const [transcriptOpen, setTranscriptOpen] = useState<boolean>(transcriptDefaultOpen);
  // Transcript disclosure on a decision or working page. Not the remembered
  // preference above: that defaults open, and the point here is that the log
  // starts closed on every visit while the card is the surface.
  const [transcriptVisitOpen, setTranscriptVisitOpen] = useState(false);
  // Entry-type filter. A long run is mostly tool calls, so free-text search is a
  // poor way to find the agent's reasoning spine or the thing that failed.
  const [logFilter, setLogFilter] = useState<LogFilter>(() => {
    try {
      const stored = localStorage.getItem('agentuse:session:logFilter');
      return stored === 'agent' || stored === 'tools' || stored === 'errors' ? stored : 'all';
    } catch { return 'all'; }
  });
  // Debug-level operational logs are hidden by default to keep the log readable;
  // the preference persists across sessions.
  const [showDebug, setShowDebug] = useState<boolean>(() => {
    try { return localStorage.getItem('agentuse:session:showDebug') === '1'; } catch { return false; }
  });
  const [showReasoning, setShowReasoning] = useState<boolean>(() => {
    try { return localStorage.getItem('agentuse:session:showReasoning') !== '0'; } catch { return true; }
  });
  // Latest per-session view state, read by the [sessionId] cleanup below (which
  // closes over the *outgoing* id) to bank what the reader had open.
  const uiStateRef = useRef({ expandOverrides, logQuery, showLogSearch, logsLimit, transcriptOpen });
  uiStateRef.current = { expandOverrides, logQuery, showLogSearch, logsLimit, transcriptOpen };
  // Scroll offset to restore on the next first paint, set when returning to a
  // session we have banked state for. null = no restore pending.
  const restoreScrollRef = useRef<number | null>(null);
  // Log commits arrive over several frames, so the page is often still too short
  // to honour the restore on the first one. Retry across commits, bounded so a
  // target that can never be reached (entries since trimmed) still releases the
  // first-paint branch to its normal behaviour.
  const restoreAttemptsRef = useRef(0);
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
  const logSearchRef = useRef<HTMLInputElement>(null);
  const currentResumeTokenRef = useRef<string | undefined>(token);
  const followScrollRef = useRef(true);
  // First-paint scroll-to-end happens once per session. The router reuses this
  // component across /sessions/:id navigations, so this must be reset on session
  // change (see the [sessionId] effect) or a sub-agent opened from its parent
  // would inherit the parent's "already scrolled" state and land at the top.
  const hasScrolledRef = useRef(false);
  const resultRef = useRef(result);
  resultRef.current = result;

  // The desktop Edit > Find command dispatches the same event. The search stays
  // out of the session header until requested, then takes focus like a native
  // find overlay. Browser/PWA views get the same scoped Cmd/Ctrl+F behavior.
  useEffect(() => {
    const revealSearch = () => {
      document.querySelector<HTMLDetailsElement>('.session-transcript')?.setAttribute('open', '');
      setTranscriptVisitOpen(true);
      setTranscriptOpen(true);
      setShowLogSearch(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          logSearchRef.current?.focus();
          logSearchRef.current?.select();
        });
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        revealSearch();
      }
    };
    window.addEventListener('agentuse:find-session-log', revealSearch);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('agentuse:find-session-log', revealSearch);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

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
    const transitionFailure = isBackgroundSessionActionFailure(header.errorMessage);
    if (transitionFailure) {
      setResult({ text: header.errorMessage as string, error: true });
      setSubmittingContinue(false);
      setSubmittingDecision(null);
    } else if (nextStatus === 'error' || header.sessionStatus === 'error') {
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
    const banked = sessionViewState.get(sessionId);
    setExpandOverrides(banked ? new Map(banked.expandOverrides) : new Map());
    setResult({ text: '', error: false });
    setFatalError(null);
    setIsRevisionSession(false);
    setRevisionIdentity(null);
    setLogsVersion((v) => v + 1);
    setArtifacts([]);
    setLogsLimit(banked?.logsLimit ?? 400);
    setLogsTotal(null);
    setLogQuery(banked?.logQuery ?? '');
    setShowLogSearch(banked?.showLogSearch ?? false);
    setTranscriptOpen(banked?.transcriptOpen ?? transcriptDefaultOpen());
    setTranscriptVisitOpen(false);
    restoreScrollRef.current = banked && banked.scrollY > 0 ? banked.scrollY : null;
    restoreAttemptsRef.current = 0;
    // Bank this session's view state on the way out, so stepping into a
    // sub-agent and coming back doesn't cost the reader their place.
    return () => {
      rememberSessionViewState(sessionId, {
        ...uiStateRef.current,
        expandOverrides: new Map(uiStateRef.current.expandOverrides),
        scrollY: typeof window === 'undefined' ? 0 : window.scrollY,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Pull the run's artifacts once on navigation, then only after an artifact
  // entry arrives. Abort a superseded request instead of merely ignoring its
  // result: ignored requests still consume a server slot and were the source of
  // a large first-load request storm on long transcripts.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    fetchSessionArtifacts(sessionId, token, projectId, controller.signal)
      .then((payload) => {
        // Artifacts change rarely; skip the state update when the list is
        // unchanged so an explicit refresh does not repaint the transcript.
        setArtifacts((prev) => {
          const next = payload.artifacts;
          const same = prev.length === next.length
            && prev.every((a, i) => a.name === next[i].name && a.updatedAt === next[i].updatedAt);
          return same ? prev : next;
        });
      })
      .catch(() => { /* leave panel empty */ });
    return () => controller.abort();
  }, [sessionId, token, projectId, artifactRevision]);

  useApprovalStream({
    sessionId,
    token,
    project: projectId,
    nudge,
    pending,
    logsLimit,
    handlers: {
      onStatus: handleStatus,
      onLog: (entry) => {
        if (mergeLog(entry)) {
          if (entry.details?.savedArtifact) setArtifactRevision((value) => value + 1);
          commitLogs();
        }
      },
      onLogs: (entries, total) => {
        if (total !== undefined) setLogsTotal(total);
        let changed = false;
        let artifactChanged = false;
        for (const entry of entries) {
          if (!mergeLog(entry)) continue;
          changed = true;
          if (entry.details?.savedArtifact) artifactChanged = true;
        }
        if (artifactChanged) setArtifactRevision((value) => value + 1);
        if (changed) commitLogs();
      },
      onFatalError: (_code, message) => setFatalError(message),
    },
  });

  const orderedLogs = useMemo(
    () => [...logsRef.current.values()].sort((a, b) => (a.time ?? 0) - (b.time ?? 0)),
    [logsVersion]
  );
  const judgeRows = useMemo(() => collectJudgeRows(orderedLogs), [orderedLogs]);
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
      const dedupKey = `${e.title}\0${e.message ?? ''}`;
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
  // Tool calls made from inside a code_exec program carry the parent call id.
  // They fold under the parent row and open with it, so a program that fans out
  // into twenty store reads reads as one step until the reviewer asks for more.
  // Orphans (parent row not loaded) stay in the flat stream so nothing is lost.
  const { nestedToolCalls, nestedToolIds } = useMemo(() => {
    const callIds = new Set(
      orderedLogs.filter((e) => e.type === 'tool' && e.callId).map((e) => e.callId as string)
    );
    const byParent = new Map<string, ApprovalLogEntry[]>();
    const nested = new Set<string>();
    for (const e of orderedLogs) {
      if (e.type !== 'tool' || !e.parentCallId || !callIds.has(e.parentCallId)) continue;
      nested.add(e.id);
      const list = byParent.get(e.parentCallId) ?? [];
      list.push(e);
      byParent.set(e.parentCallId, list);
    }
    return { nestedToolCalls: byParent, nestedToolIds: nested };
  }, [orderedLogs]);
  // Nested warnings are surfaced inside their tool entry, so exclude them from
  // the debug-toggle count too (they aren't free-floating noise anymore).
  const debugCount = useMemo(
    () => orderedLogs.reduce((n, e) => n + (!nestedLogIds.has(e.id) && isDebugLog(e) ? 1 : 0), 0),
    [orderedLogs, nestedLogIds]
  );
  const reasoningCount = useMemo(
    () => orderedLogs.reduce((n, e) => n + (e.type === 'reasoning' ? 1 : 0), 0),
    [orderedLogs]
  );
  const visibleLogs = useMemo(
    // Routine learning captures (captured/none) live in the Learnings panel now,
    // so keep them out of the work log; a failed capture (status 'error') still
    // surfaces inline since it's a real problem worth seeing in the timeline.
    () => orderedLogs.filter((e) =>
      !nestedLogIds.has(e.id)
      && !nestedToolIds.has(e.id)
      && (showDebug || !isDebugLog(e))
      && (showReasoning || e.type !== 'reasoning')
      && !(e.type === 'learning' && e.status !== 'error')
      && matchesLogFilter(e, logFilter, nestedToolCalls.get(e.callId ?? ''))
    ),
    [orderedLogs, showDebug, showReasoning, nestedLogIds, nestedToolIds, nestedToolCalls, logFilter]
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
    // One error, said once at the end of the log. The card above states it too;
    // everything between the two is the same sentence in four costumes.
    return collapseTrailingRunErrors(out);
  }, [visibleLogs]);
  const reviewerComment = useMemo(() => latestReviewerComment(orderedLogs), [orderedLogs]);
  // The outcome for the summary-first ended layout. An agent that declared its
  // verdict through `report_complete` delivered the run's answer there, so read
  // it off that row (already split into headline + body by the server); a run
  // that never called an outcome tool falls back to its last completed
  // assistant text, which is then split here. Derived client-side from the
  // entries already loaded (same idea as the server's feed-detail
  // finalResponse, which reads the durable transcript).
  const finalOutcome = useMemo<{ headline?: string; body: string; reported: boolean }>(() => {
    for (let i = orderedLogs.length - 1; i >= 0; i--) {
      const outcome = orderedLogs[i].details?.runOutcome;
      if (outcome) return { headline: outcome.headline, body: outcome.body ?? '', reported: true };
    }
    for (let i = orderedLogs.length - 1; i >= 0; i--) {
      const entry = orderedLogs[i];
      if (entry.type === 'text' && entry.status !== 'streaming' && (entry.message ?? '').trim()) {
        // Lead the card with the verdict instead of burying it in the body
        // markdown, where it renders smaller than the headings under it.
        // `reported: false` marks it as a stand-in, not the agent's own report:
        // a failed run must not pass its opening sentence off as a result.
        return { ...splitOutcomeHeadline(entry.message as string), reported: false };
      }
    }
    return { body: '', reported: false };
  }, [orderedLogs]);
  // A run that ended in failure shows a report only if it actually filed one.
  // Its first assistant sentence ("I'll start by reading the brand files") is
  // not a result, and reading as one is how a timed-out run looked finished.
  const hasFinalOutcome = Boolean(finalOutcome.headline || finalOutcome.body);
  const toolCallCount = useMemo(
    () => orderedLogs.reduce((n, e) => n + (e.type === 'tool' ? 1 : 0), 0),
    [orderedLogs]
  );
  // The per-tool roll-up moved to the diagnostic subpage, where it is counted
  // from the session's parts instead of from however much of the log this view
  // has paged in. aggregateToolStats stays exported for its tests.
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

  useEffect(() => {
    try { localStorage.setItem('agentuse:session:showReasoning', showReasoning ? '1' : '0'); } catch { /* ignore */ }
  }, [showReasoning]);

  useEffect(() => {
    try { localStorage.setItem('agentuse:session:logFilter', logFilter); } catch { /* ignore */ }
  }, [logFilter]);

  useEffect(() => {
    try { localStorage.setItem('agentuse:session:transcriptOpen', transcriptOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [transcriptOpen]);

  // Initial + follow scroll: stick to the page end while the user is near it.
  useLayoutEffect(() => {
    if (orderedLogs.length === 0) return;
    if (!hasScrolledRef.current) {
      // Returning to a session we banked: put the reader back where they were,
      // ahead of both the gate jump and live-follow. An explicit restore beats
      // any default, and re-arming follow would yank them to the end.
      if (restoreScrollRef.current !== null) {
        const y = restoreScrollRef.current;
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.min(y, maxY));
        restoreAttemptsRef.current += 1;
        if (maxY >= y || restoreAttemptsRef.current >= 20) {
          restoreScrollRef.current = null;
          restoreAttemptsRef.current = 0;
          hasScrolledRef.current = true;
          followScrollRef.current = false;
        }
        return;
      }
      // First paint for this session. An actionable gate takes priority over
      // live-follow: the reviewer's job is that decision, and it reads from the
      // card's top. Leave the ref unset until the card actually exists so a
      // gate that streams in a beat later still gets landed on.
      if (hasActionableApproval(status, approval)) {
        // The gate is the first card under the header now; the page opens on
        // it without a jump. Leave the ref unset until it exists so a gate
        // that streams in a beat later is still what the reviewer lands on.
        if (!actionableGateTarget()) return;
        window.scrollTo({ top: 0, behavior: 'auto' });
        hasScrolledRef.current = true;
        return;
      }
      hasScrolledRef.current = true;
      // Otherwise jump to the newest entry only when there's something live to
      // follow. On an ended session leave the reader at the top so the header
      // orients them.
      if (isLiveStatus(status, orderedLogs)) scrollToPageEnd();
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
  const showWorking = isWorkingStatus(status, orderedLogs) && !tailTyping;
  const workingLabel = status === 'preparing' ? 'Preparing project context' : 'Agent is running';
  const ended = isEndedStatus(approval?.sessionStatus);
  // Opening a finished run is reviewing it: stamp it so Home's "results you
  // haven't opened" and the unseen marks drop it. Once per page load; the
  // server ignores repeats. Best-effort, a miss only leaves the mark on.
  const reviewedPostedRef = useRef(false);
  useEffect(() => {
    if (reviewedPostedRef.current) return;
    if (approval?.sessionStatus !== 'completed') return;
    reviewedPostedRef.current = true;
    void postSessionReviewed(sessionId, token, projectId ? { project: projectId } : {}).catch(() => {
      // Nothing to show the reader; the run simply stays marked new.
    });
  }, [approval?.sessionStatus, sessionId, token, projectId]);
  const expired = approval?.expiresAt !== undefined && approval.expiresAt <= Date.now();
  // Parked on a delegated sub-agent that already ended: still raw-status
  // suspended, but nothing will ever carry it forward. Without its own copy line
  // the page reads "live view of this run" indefinitely.
  const stranded = approval?.errorCode === 'CASCADE_ORPHANED';
  const displayStatus = status === 'waiting' && expired ? 'expired' : displaySessionStatus(status, approval);
  const actionable = isActionableApproval({
    pending: pendingActionable,
    status,
    header: approval,
    expired,
  });
  // A manual "remember" rule can be saved for any agent (the reviewer's action
  // is the opt-in), so the affordance shows whenever there's an agent file to
  // attach it to. Whether the rule is injected into future runs is a separate
  // question, governed by learning.apply — surfaced as a hint in the dialog.
  const canRememberLearning = Boolean(approval?.agent.filePath)
    && !isRevisionSession
    && approval?.approvalKind !== 'tool_approval';
  const rememberApplies = approval?.learning?.apply === true;
  const resumeMode = sessionResumeMode({
    ended,
    live,
    cascadeRetryable: approval?.cascadeRetryable === true,
    hasAgentFile: Boolean(approval?.agent.filePath),
    fatal: Boolean(fatalError),
    revision: isRevisionSession,
  });
  const cascadeRetryActionable = resumeMode === 'cascade';
  const continueActionable = resumeMode === 'continue';
  // Any session with an agent file to read/write learnings for, not only an
  // ended one. A run suspended at an approval is the moment a reviewer is most
  // likely to want to correct the agent, and it is also when a stranded-
  // learnings warning matters most — they are about to approve work produced
  // without any of it. The panel renders nothing at all when it has nothing to
  // report, so extending it to live and suspended runs adds no empty box.
  const learningsVisible = Boolean(approval?.agent.filePath) && !isRevisionSession;
  // What the server lets this run do. Whether a control is busy is carried
  // separately, so an in-flight stop keeps its button (disabled, spinning)
  // instead of making it vanish mid-click.
  const stoppable = approval !== null && !ended && !expired && !fatalError && !isRevisionSession;
  // Discard on an ended failed run stamps it reviewed (dismissedAt) so it
  // clears from Home's "Needs your attention". Stopped-by-user runs never
  // re-enter that list, so they get no discard affordance.
  const dismissable = approval !== null && ended && approval.sessionStatus === 'error'
    && approval.errorCode !== 'USER_STOPPED'
    && approval.dismissedAt === undefined && !justDismissed && !fatalError;
  // An errored session whose resolved approval gate can be rolled back for a retry.
  const reopenable = ended && approval?.sessionStatus === 'error'
    && Boolean(approval?.reopenable) && !live && !fatalError;
  const working = isWorkingStatus(status, orderedLogs);

  // Split the actionable gate OUT of the feed so the transcript can fold shut
  // above it. The gate is the one thing a reviewer must act on; the hundreds
  // of entries before it (rejected rounds, judge critiques, every tool call)
  // are context they can open on demand. The split also covers a reopen,
  // which re-arms an earlier gate mid-stream: it still ends the page.
  const { gateEntry, feedLogs } = useMemo(() => {
    if (!actionable) return { gateEntry: undefined, feedLogs: collapsedLogs };
    const activeToken = currentResumeTokenRef.current;
    const idx = collapsedLogs.findIndex((e) =>
      e.status === 'pending' && Boolean(e.details)
      && (!activeToken || e.details?.resumeToken === activeToken));
    if (idx < 0) return { gateEntry: undefined, feedLogs: collapsedLogs };
    return {
      gateEntry: collapsedLogs[idx],
      feedLogs: [...collapsedLogs.slice(0, idx), ...collapsedLogs.slice(idx + 1)],
    };
  }, [collapsedLogs, actionable]);
  const matchingFeedLogs = useMemo(
    () => feedLogs.filter((entry) => sessionLogMatches(entry, logQuery, nestedToolCalls.get(entry.callId ?? ''))),
    [feedLogs, logQuery, nestedToolCalls]
  );

  // Chromium's Custom Highlight API emphasizes matches without rewriting the
  // rich, nested LogEntry DOM or disturbing text selection. Older embedded
  // engines get an equivalent temporary <mark>-based fallback below.
  useLayoutEffect(() => {
    type HighlightRegistry = {
      set: (name: string, highlight: unknown) => void;
      delete: (name: string) => boolean;
    };
    type HighlightConstructor = new (...ranges: Range[]) => unknown;
    const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    const HighlightClass = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
    const highlightName = 'agentuse-session-search';
    const clearFallbackMarks = () => {
      document.querySelectorAll<HTMLElement>('mark[data-agentuse-session-search]').forEach((mark) => {
        mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
      });
    };
    registry?.delete(highlightName);
    clearFallbackMarks();

    const terms = sessionLogSearchTerms(logQuery);
    if (terms.length === 0) return;

    const ranges: Range[] = [];
    const textNodes: Text[] = [];
    const collectTextNodes = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) textNodes.push(child as Text);
        else collectTextNodes(child);
      }
    };
    document.querySelectorAll<HTMLElement>('.page-approval-detail .logs .log-item').forEach((row) => {
      // Walk childNodes directly: a few embedded WebView builds omit the
      // TreeWalker/NodeFilter globals even though their DOM nodes are complete.
      const rowTextStart = textNodes.length;
      collectTextNodes(row);
      if (registry && HighlightClass) {
        for (const textNode of textNodes.slice(rowTextStart)) {
          const text = textNode.data.toLocaleLowerCase();
          for (const term of terms) {
            let from = 0;
            while (from < text.length) {
              const index = text.indexOf(term, from);
              if (index < 0) break;
              const range = document.createRange();
              range.setStart(textNode, index);
              range.setEnd(textNode, index + term.length);
              ranges.push(range);
              from = index + term.length;
            }
          }
        }
      }
    });
    if (registry && HighlightClass) {
      registry.set(highlightName, new HighlightClass(...ranges));
      return () => registry.delete(highlightName);
    }

    // Older embedded Chromium builds lack CSS.highlights. Wrap only matching
    // text nodes as a fallback, and unwrap them in the effect cleanup before
    // the next query/render so Preact continues to own the surrounding DOM.
    const escaped = [...terms]
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(${escaped.join('|')})`, 'giu');
    for (const textNode of textNodes) {
      pattern.lastIndex = 0;
      if (!pattern.test(textNode.data)) continue;
      pattern.lastIndex = 0;
      const parent = textNode.parentNode;
      if (!parent) continue;
      let cursor = 0;
      for (const match of textNode.data.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (index > cursor) parent.insertBefore(document.createTextNode(textNode.data.slice(cursor, index)), textNode);
        const mark = document.createElement('mark');
        mark.dataset.agentuseSessionSearch = '';
        mark.textContent = match[0];
        parent.insertBefore(mark, textNode);
        cursor = index + match[0].length;
      }
      if (cursor < textNode.data.length) parent.insertBefore(document.createTextNode(textNode.data.slice(cursor)), textNode);
      parent.removeChild(textNode);
    }

    return () => {
      registry?.delete(highlightName);
      clearFallbackMarks();
    };
  }, [logQuery, matchingFeedLogs]);

  useEffect(() => {
    if (continueActionable || cascadeRetryActionable) setSubmittingContinue(false);
    else setShowResume(false);
  }, [continueActionable, cascadeRetryActionable]);

  // Pending-queue position, fetched once when a gate becomes actionable. A
  // capability-scoped (?token=) view has no operator access to the approvals
  // endpoint and stays queue-less.
  useEffect(() => {
    if (token || !actionable) {
      setPendingQueue([]);
      return;
    }
    let cancelled = false;
    void fetchApprovals()
      .then((payload) => {
        if (cancelled) return;
        setPendingQueue(payload.buckets.pending.map((row) => ({
          sessionId: row.sessionId,
          project: row.project,
          agentName: row.agentName || row.agentId,
        })));
      })
      .catch(() => { /* queue nav is an accelerator, never the only path */ });
    return () => { cancelled = true; };
  }, [token, actionable, sessionId]);

  const queueIndex = pendingQueue.findIndex((row) => row.sessionId === sessionId);
  // Wrap to the first gate: working a backlog from the middle should still reach
  // every one of them without a detour through the list.
  const queueNext = queueIndex >= 0 && pendingQueue.length > 1
    ? pendingQueue[(queueIndex + 1) % pendingQueue.length]
    : undefined;

  // Effective pick on an options gate: the reviewer's explicit selection when it
  // still names a live option, otherwise the agent's recommendation. A ref mirrors
  // it so submitDecision reads the latest value without re-creating the callback
  // on every radio click.
  //
  // Deliberately does NOT fall back to the first option. An agent that marks
  // nothing recommended is saying the call is the reviewer's, and position is not
  // a recommendation — preselecting options[0] silently turned "you decide" into
  // an approve button already committed to A, which the selected-candidate
  // emphasis then made look deliberate. With no recommendation the gate stays
  // genuinely unpicked and approve waits for a real choice.
  const gateOptions = approval?.options;
  const effectiveChoice = gateOptions && gateOptions.length > 0
    ? (selectedChoice && gateOptions.some((o) => o.id === selectedChoice)
      ? selectedChoice
      : gateOptions.find((o) => o.recommended)?.id)
    : undefined;
  const effectiveChoiceRef = useRef<string | undefined>(undefined);
  effectiveChoiceRef.current = effectiveChoice;
  // A pick gate cannot be approved without a choice: the agent branches on it, so
  // an approve carrying none is the ambiguity the comment branch exists to avoid.
  const awaitingPick = Boolean(gateOptions && gateOptions.length > 0 && !effectiveChoice);

  const submitDecision = useCallback(async (action: 'approve' | 'reject' | 'comment', comment?: string, remember?: string) => {
    if (submittingDecision || !currentResumeTokenRef.current) return;
    setSubmittingDecision(action);
    setResult({ text: '⋮ submitting decision…', error: false });
    try {
      const decidedResumeToken = currentResumeTokenRef.current;
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
      const queueProject = projectId ?? approval?.project ?? pendingQueue.find((row) => row.sessionId === sessionId)?.project;
      const decided = { sessionId, ...(queueProject && { project: queueProject }) };
      setPendingQueue((current) => withoutQueuedApproval(current, decided));
      globalApprovals.resolvePending({ ...decided, resumeToken: decidedResumeToken });
      if (queueProject) {
        // A retry/reopen may reuse this session id after an earlier discarded
        // failure. Once work resumes, that old attention mask is obsolete.
        globalApprovals.restoreAttentionSession({ project: queueProject, sessionId });
      }
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
  }, [sessionId, token, projectId, approval?.project, submittingDecision, pendingQueue, globalApprovals]);

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
      const resolvedProject = projectId ?? approval?.project;
      if (resolvedProject) {
        globalApprovals.restoreAttentionSession({ project: resolvedProject, sessionId });
      }
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingContinue(false);
    }
  }, [sessionId, token, projectId, approval?.project, submittingContinue, continueActionable, globalApprovals]);

  const submitCascadeRetry = useCallback(async () => {
    if (submittingContinue || !cascadeRetryActionable) return;
    setSubmittingContinue(true);
    setResult({ text: '⋮ resuming…', error: false });
    try {
      const payload = await postSessionResume(sessionId, token, {
        ...(projectId ? { project: projectId } : {}),
      });
      setResult({ text: '✓ run resumed.', error: false });
      setStatus(payload.status || 'resuming');
      setNudge((n) => n + 1);
      const resolvedProject = projectId ?? approval?.project;
      if (resolvedProject) {
        globalApprovals.restoreAttentionSession({ project: resolvedProject, sessionId });
      }
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingContinue(false);
    }
  }, [sessionId, token, projectId, approval?.project, submittingContinue, cascadeRetryActionable, globalApprovals]);

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
      const resolvedProject = projectId ?? approval?.project;
      if (resolvedProject) {
        globalApprovals.restoreAttentionSession({ project: resolvedProject, sessionId });
      }
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
    } finally {
      setSubmittingReopen(false);
    }
  }, [sessionId, token, projectId, approval?.project, submittingReopen, globalApprovals]);

  const submitStop = useCallback(async () => {
    if (submittingStop) return;
    setSubmittingStop(true);
    setResult({ text: '⋮ stopping session…', error: false });
    try {
      const decidedResumeToken = currentResumeTokenRef.current;
      const payload = await postSessionStop(sessionId, token, {
        ...(projectId ? { project: projectId } : {}),
        reason: 'Stopped from session UI',
      });
      if (payload.rejected) {
        // A discard on a pending gate is delivered as a reject decision so the
        // agent can record it before ending — mirror the decision flow. The
        // session comes back live, so re-arm the button: leaving submittingStop
        // set would hide Stop/Discard for the rest of the page's life.
        setSubmittingStop(false);
        setResult({ text: '✓ pending request rejected — agentuse is resuming the session so the agent records it before ending.', error: false });
        setStatus('resuming');
        setNudge((n) => n + 1);
        const queueProject = projectId ?? approval?.project ?? pendingQueue.find((row) => row.sessionId === sessionId)?.project;
        const decided = { sessionId, ...(queueProject && { project: queueProject }) };
        setPendingQueue((current) => withoutQueuedApproval(current, decided));
        globalApprovals.resolvePending({ ...decided, resumeToken: decidedResumeToken });
        void fetchApprovals().then((p) => syncAppBadge(p.buckets.pending.length)).catch(() => {});
        return;
      }
      const resolvedProject = projectId ?? approval?.project;
      if (resolvedProject) {
        globalApprovals.dismissAttentionSession({ project: resolvedProject, sessionId });
      }
      // Discard on an already-ended failed run: nothing was stopped, the run
      // was stamped reviewed. Status/error stay untouched.
      const dismissedOnly = payload.stopped.some((entry) => entry.dismissed) && payload.stopped.every((entry) => !entry.stopped);
      if (dismissedOnly) {
        setResult({ text: '✓ discarded — this run no longer shows under "Needs your attention".', error: false });
        setJustDismissed(true);
        setSubmittingStop(false);
        setNudge((n) => n + 1);
        return;
      }
      setResult({ text: '✓ session stopped. Running subagents were stopped too.', error: false });
      setStatus('stopped');
      setNudge((n) => n + 1);
    } catch (err) {
      setResult({ text: (err as Error).message || String(err), error: true });
      setSubmittingStop(false);
    }
  }, [sessionId, token, projectId, approval?.project, submittingStop, pendingQueue, globalApprovals]);

  const onAction = useCallback((action: 'approve' | 'reject' | 'comment') => {
    if (action === 'comment' && approval?.approvalKind === 'tool_approval') return;
    if (action === 'approve' && gateEntry?.details?.reviewEscalation) return;
    if (action === 'comment' || action === 'reject') {
      setDecisionDialog(action);
      return;
    }
    void submitDecision(action);
  }, [approval?.approvalKind, gateEntry?.details?.reviewEscalation, submitDecision]);

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
      // Single-letter shortcuts must not steal a key the focused element itself
      // consumes. Only two kinds do: a <select> (type-ahead jumps to the option
      // starting with that letter) and editable content. Buttons, links and
      // summaries answer Enter and Space, never 'c' — and browsers focus a
      // button on click, so treating those as interactive silently killed the
      // advertised `c` shortcut for the rest of the page's life the moment the
      // reviewer clicked anything.
      const active = document.activeElement as HTMLElement | null;
      const inTypeAhead = Boolean(active?.closest('select, [contenteditable]'));
      // Transient layers own Escape: they close on it via their own document
      // listener, so firing the gate's reject dialog in the same keystroke
      // dismisses the popover AND opens a decision the reviewer never asked
      // for. Menus and tooltips are portalled, hence a document-wide query
      // rather than a ref.
      const anyDialogOpen = Boolean(document.querySelector(
        'dialog[open], [role="dialog"], [role="menu"], [role="tooltip"], [role="listbox"]',
      ));
      const canAct = actionable && !submittingDecision;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        // Reject and comment stay available on an unpicked gate; only approve
        // needs the choice, so only approve is withheld.
        if (!canAct || inField || awaitingPick || gateEntry?.details?.reviewEscalation) return;
        event.preventDefault();
        void submitDecision('approve');
      } else if (event.key === 'Escape' && !inField && !anyDialogOpen) {
        if (!canAct) return;
        setDecisionDialog('reject');
      } else if ((event.key === 'c' || event.key === 'C') && !inField && !inTypeAhead && !anyDialogOpen && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!canAct || approval?.approvalKind === 'tool_approval') return;
        event.preventDefault();
        setDecisionDialog('comment');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [decisionDialog, actionable, submittingDecision, submitDecision, awaitingPick, approval?.approvalKind, gateEntry?.details?.reviewEscalation]);

  if (fatalError) {
    return (
      <div class="page-approval-detail">
        <main><p class="notice error">{fatalError}</p></main>
      </div>
    );
  }
  if (!approval) {
    return (
      <div class="page-approval-detail">
        <main><Loading wrapClass="notice" label="Loading session…" /></main>
      </div>
    );
  }

  const agentLabel = approval.agent.name || approval.agent.id;
  const sessionProjectId = projectId ?? approval.project;
  // The name is the headline; the description (often a full sentence with
  // implementation notes) reads as a subhead rather than a giant multi-line H1.
  const revisionTitle = revisionIdentity
    ? `Revising ${revisionIdentity.targetAgentName}`
    : undefined;
  const pageAgentLabel = revisionTitle ?? agentLabel;
  const tokenUsage = headerTokenUsage(approval);
  const estimatedCost = pricing ? pricing.estimateSessionCostUsd(approval.model, tokenUsage) : undefined;
  const costLabel = estimatedCost !== undefined && pricing ? pricing.formatUsd(estimatedCost) : undefined;
  const contextLeftLabel = (() => {
    const context = tokenUsage?.context;
    if (!context || typeof context.contextLimit !== 'number' || context.contextLimit <= 0) return undefined;
    return `${Math.max(0, 100 - context.usagePercentage).toFixed(0)}% left`;
  })();
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
  // Run controls (retry, revise, resume, stop) live in the header's ⋯ menu
  // whenever that menu is rendered, on every state: the card is for reading
  // and deciding, not a second button row. Views with no menu (a sub-agent's
  // view-only page, a revision session) keep the inline row.
  const sessionMenuShown = !isSubagentView && Boolean(approval.agent.runPath) && Boolean(sessionProjectId) && !isRevisionSession;
  const runControlsInMenu = sessionMenuShown;
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
  // The only prose the card carries: a state the page cannot otherwise
  // explain (a revision, a resumable delegated failure, an expired or
  // stranded run). A view-only child needs none: its head, its meta and the
  // link back to the parent say it.
  const cardNote = isRevisionSession
    ? 'This AgentUse-owned session diagnoses the originating run and prepares a source proposal for your review.'
    : cascadeRetryActionable
      ? 'This run was interrupted while completing a delegated task. Resume to continue where it stopped.'
      : expired
        ? 'This approval request has expired. The session log remains available for review.'
        : stranded && !ended
          // An ended stranded run leads with this same message as its failure.
          ? (approval.errorMessage ?? 'This run is waiting on a delegated sub-agent that has already ended, so it can no longer be resumed.')
          : undefined;

  // Verdict line for the result card. Prefer the runtime's
  // root+descendant timing split so a reviewer taking 30 minutes does not make
  // the agent look 30 minutes slower. Historical sessions fall back to wall
  // time derived from their log.
  const lastLogTime = orderedLogs.length > 0 ? orderedLogs[orderedLogs.length - 1].time : undefined;
  const elapsedLabel = approval.timing
    ? `active ${formatDuration(approval.timing.activeMs)}`
    : approval.createdAt !== undefined && lastLogTime !== undefined && lastLogTime > approval.createdAt
      ? `${ended ? 'finished in' : 'running'} ${formatDuration(lastLogTime - approval.createdAt)}`
      : undefined;
  // The corrections row lives in the session log, which is collapsed by default.
  // A run that silently applied 10 of its 26 corrections would stay silent until
  // someone expanded it, so the count is repeated here where it cannot be
  // missed. Only the shortfall is worth a line: a run that applied everything it
  // had has nothing to warn about and stays out of the verdict.
  const correctionsShortfall = useMemo(
    () => {
      const row = orderedLogs.find((e) => e.type === 'corrections');
      if (!row || typeof row.applied !== 'number' || typeof row.active !== 'number') return undefined;
      const dormant = row.active - row.applied;
      return dormant > 0 ? `${row.applied} of ${row.active} learnings` : undefined;
    },
    [orderedLogs]
  );
  // One quiet line of facts about the finished run, replacing the three
  // bordered tiles: a card inside a card inside a card was three frames to
  // read three short strings. Only facts the header does not already carry.
  const judgeBounces = judgeRows.filter((row) => row.verdict === 'fail').length;
  const lastJudge = judgeRows[judgeRows.length - 1];
  const decidedGate = [...orderedLogs].reverse().find((e) => e.details?.decisionStatus);
  const runFacts: string[] = [
    decidedGate?.details
      ? `${decidedGate.details.decisionStatus}${decidedGate.details.decisionReviewer ? ` by ${decidedGate.details.decisionReviewer}` : ''} at ${formatLogTime(decidedGate.time)}`
      : undefined,
    lastJudge
      ? lastJudge.verdict === 'pass'
        ? judgeBounces > 0 ? `judge passed after ${judgeBounces} bounce${judgeBounces === 1 ? '' : 's'}` : 'judge passed first time'
        : lastJudge.verdict === 'fail' ? 'judge still failing'
          : lastJudge.verdict === 'skipped' ? 'not judged' : 'judge error'
      : undefined,
    approval.timing && approval.timing.approvalMs > 0
      ? `approval wait ${formatDuration(approval.timing.approvalMs)}`
      : undefined,
    toolCallCount > 0 ? `${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}` : undefined,
    tokenUsage && (tokenUsage.input > 0 || tokenUsage.output > 0)
      ? `${formatTokens(tokenUsage.input)} in / ${formatTokens(tokenUsage.output)} out`
      : undefined,
    tokenUsage && tokenUsage.cachedInput > 0 ? `+${formatTokens(tokenUsage.cachedInput)} cached` : undefined,
    correctionsShortfall ? `${correctionsShortfall} applied` : undefined,
  ].filter((fact): fact is string => Boolean(fact));
  const factsLine = runFacts.length > 0 ? (
    <div class="now-facts">{runFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>
  ) : null;
  // '' unless the session ended in error; leads the result card so a failed
  // run's outcome is the failure, not a mid-thought final message.
  const resultErrorText = sessionErrorText(approval);
  // Older outcome records can contain an ellipsized copy of the full error.
  // Keep distinct headlines, but avoid repeating the failure as a large title.
  const errorHeadline = finalOutcome.headline?.replace(/(?:\.{3}|…)$/, '').trim();

  // The artifact tiles, rendered in the card's result slot.
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
              class={`artifact-open is-${artifactKind(a.name)}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open artifact ${label} (new tab)`}
            >
              <span class="artifact-open-kind">{artifactKind(a.name)}</span>
              <span class="artifact-open-name">{label}</span>
              <span class="artifact-open-hint">open</span>
            </a>
          );
        })}
    </div>
  ) : null;

  const reasoningToggle = reasoningCount > 0 ? (
    <label class="log-debug-toggle" title="Show agent reasoning">
      <input
        type="checkbox"
        checked={showReasoning}
        onChange={(e) => setShowReasoning((e.target as HTMLInputElement).checked)}
      />
      <span>reasoning</span>
      <span class="log-debug-count">{reasoningCount}</span>
    </label>
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

  const logFilterControl = orderedLogs.length > 0 ? (
    <div class="log-filter" role="group" aria-label="Filter session log by entry type">
      {(['all', 'agent', 'tools', 'errors'] as LogFilter[]).map((f) => (
        <button
          key={f}
          type="button"
          class={`log-filter-btn${logFilter === f ? ' is-on' : ''}`}
          aria-pressed={logFilter === f}
          onClick={() => setLogFilter(f)}
        >
          {f}
        </button>
      ))}
    </div>
  ) : null;

  // Search belongs to the log, so it lives in the log's own tools row rather
  // than in the page chrome above it. Cmd/Ctrl+F still reveals and focuses it.
  const logSearchControl = (
    <div class={`session-log-search${showLogSearch || logQuery ? '' : ' is-idle'}`} role="search">
      <svg class="session-log-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
      </svg>
      <input
        ref={logSearchRef}
        type="search"
        value={logQuery}
        placeholder="Search"
        aria-label="Search session log"
        onFocus={() => setShowLogSearch(true)}
        onInput={(event) => {
          const query = (event.currentTarget as HTMLInputElement).value;
          setLogQuery(query);
          if (query && logsTotal !== null && logsRef.current.size < logsTotal) setLogsLimit(5_000);
          if (query) {
            document.querySelector<HTMLDetailsElement>('.session-transcript')?.setAttribute('open', '');
            setTranscriptVisitOpen(true);
            setTranscriptOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setLogQuery('');
          setShowLogSearch(false);
          (event.currentTarget as HTMLInputElement).blur();
        }}
      />
      {(logQuery || showLogSearch) && (
        <button
          type="button"
          class="session-log-search-clear"
          aria-label="Clear session log search"
          title="Clear search"
          onClick={() => {
            setLogQuery('');
            setShowLogSearch(false);
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );

  const logTools = orderedLogs.length > 0 ? (
    <div class="log-tools">{logFilterControl}<span class="log-tools-spacer" />{logSearchControl}{reasoningToggle}{debugToggle}</div>
  ) : null;

  // Ended with something to show: an outcome, timings, artifacts. Decides
  // result-vs-idle; the card's slots below render the pieces.
  const hasResult = ended && (hasFinalOutcome || runFacts.length > 0 || artifacts.length > 0);
  const mode = sessionPageMode({
    gate: Boolean(gateEntry),
    ended,
    working,
    failed: Boolean(resultErrorText),
    hasResult,
  });
  const transcriptPerVisit = transcriptFoldsPerVisit(mode);
  const transcriptIsOpen = transcriptPerVisit ? transcriptVisitOpen : transcriptOpen;
  const setTranscriptIsOpen = transcriptPerVisit ? setTranscriptVisitOpen : setTranscriptOpen;
  const runControls = sessionRunControls({
    ended,
    live,
    atGate: approval.sessionStatus === 'suspended',
    hasAgentFile: Boolean(approval.agent.filePath),
    revision: isRevisionSession,
    reopenable,
    resume: resumeMode,
    stoppable,
    dismissable,
    busy: { reopen: submittingReopen, resume: submittingContinue, stop: submittingStop },
  });
  const runControl = (control: SessionRunControl) => {
    switch (control.id) {
      case 'retry': void submitReopen(); return;
      case 'revise': setReviseRequest((n) => n + 1); return;
      case 'resume': setShowResume(true); return;
      case 'cascade': void submitCascadeRetry(); return;
      case 'stop':
      case 'discard': void submitStop(); return;
    }
  };
  const menuControls = runControls.filter((control) => control.placement === 'menu');
  const barControl = runControls.find((control) => control.placement === 'bar');
  const controlIcon = (icon: SessionRunControl['icon']) => icon === 'edit'
    ? <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    : icon === 'stop'
      ? <rect x="6" y="6" width="12" height="12" rx="2" />
      : <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>;

  const renderLogEntry = (entry: PreparedLogEntry, extra?: { priorReview?: PriorReview | undefined }) => {
    const entryActionable = actionable && entry.status === 'pending' && Boolean(entry.details) &&
      (!currentResumeTokenRef.current || entry.details?.resumeToken === currentResumeTokenRef.current);
    const nestedCalls = entry.callId ? nestedToolCalls.get(entry.callId) : undefined;
    // This is deliberately derived instead of writing an expansion override:
    // clearing the search restores the reviewer's normal collapsed state.
    const expandedNestedCallIds = nestedCallIdsToExpand(logQuery, logFilter, nestedCalls);
    return (
      <LogEntry
        key={entry.id}
        entry={entry}
        isNew={isNewLog(entry.id)}
        repeatCount={entry.repeatCount}
        warnings={entry.callId ? toolWarnings.get(entry.callId) : undefined}
        nestedCalls={nestedCalls}
        nestedWarnings={toolWarnings}
        expanded={expandedNestedCallIds.size > 0 ? true : expandOverrides.get(entry.id)}
        expandOverrides={expandOverrides}
        forceExpandedNestedCallIds={expandedNestedCallIds}
        showActions={entryActionable}
        priorReview={extra?.priorReview}
        parentApproveHref={showParentApproveCta ? parentLink : undefined}
        parentApproveLabel={parentLabel}
        actionsDisabled={submittingDecision !== null}
        pendingAction={submittingDecision}
        projectId={projectId}
        sessionId={sessionId}
        token={token}
        selectedChoice={entryActionable ? effectiveChoice : undefined}
        onSelectChoice={entryActionable ? setSelectedChoice : undefined}
        onToggle={(id, next) => {
          setExpandOverrides((current) => new Map(current).set(id, next));
        }}
        onAction={onAction}
      />
    );
  };

  // The pending gate, in its own list after the folded transcript. Same list
  // markup as the feed so the card, its sticky action row, and the auto-scroll
  // target (.log-item.is-actionable) all keep working unchanged.
  const gatePanel = gateEntry ? (
    <div class="panel gate-panel">
      <ul class="logs" role="list">
        {/* The previous round's comment used to be its own banner above the
            page. It rides inside the gate now, folded, so the decision and
            the reason the draft was sent back sit together. */}
        {renderLogEntry(gateEntry, { priorReview: reviewerComment })}
      </ul>
    </div>
  ) : null;

  // Session-level controls (retry, run again, revise the agent, continue,
  // stop) plus the change set / revision panels a session may carry. They
  // render inside the now card, at its foot, so the thing to do sits with the
  // thing to read; a session with no card (still loading) gets them alone.
  const sessionActions = (
    <>
        <div class="session-actions">
          {/* Only a page with no ⋯ menu (a sub-agent's view-only page, a
              revision session) renders controls here; otherwise the row hosts
              just the revise form and history, and collapses when empty. */}
          {!runControlsInMenu && menuControls.map((control) => (
            <button
              key={control.id}
              type="button"
              class={`debug-prompt-button${control.id === 'stop' || control.id === 'discard' ? ' stop-session-button' : ''}`}
              disabled={control.busy}
              aria-busy={control.busy}
              title={control.title}
              onClick={() => runControl(control)}
            >
              {control.busy
                ? <span class="btn-spinner" aria-hidden="true" />
                : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    {controlIcon(control.icon)}
                  </svg>
                )}
              <span>{control.label}</span>
            </button>
          ))}
          {!approval.agent.filePath && approval.agent.name === ONBOARDING_AGENT_NAME && approval.model === ONBOARDING_MODEL ? (
            <DebugPromptButton
              mode="onboarding"
              context={{
                sessionId: approval.sessionId,
                projectId: projectId ?? approval.project,
                projectPath: approval.projectPath,
                agentName: agentLabel,
                model: approval.model,
                sessionStatus: approval.sessionStatus,
                errorCode: approval.errorCode,
                errorMessage: approval.errorMessage,
              }}
            />
          ) : approval.agent.filePath && !isRevisionSession ? (
            <AgentRevisionLauncher
              ended={ended}
              atGate={approval.sessionStatus === 'suspended'}
              hideTrigger
              presentation="dialog"
              openRequest={reviseRequest}
              token={token}
              context={{
                sessionId: approval.sessionId,
                projectId: projectId ?? approval.project,
                projectPath: approval.projectPath,
                agentName: agentLabel,
                agentFilePath: approval.agent.filePath,
                model: approval.model,
                sessionStatus: approval.sessionStatus,
                errorCode: approval.errorCode,
                errorMessage: approval.errorMessage,
              }}
            />
          ) : null}
        </div>

        <ContinuePanel
          hidden={!continueActionable || !showResume}
          disabled={submittingContinue || !continueActionable}
          busy={submittingContinue}
          onSubmit={(prompt) => void submitContinue(prompt)}
        />

        <ChangesetSessionPanel
          sessionId={sessionId}
          token={token}
          project={projectId ?? approval.project}
          sessionStatus={displayStatus}
          onDetected={(changeset) => {
            setIsRevisionSession(true);
            if (changeset.target) setRevisionIdentity({ targetAgentName: changeset.target.name, ...(changeset.originSessionId && { originSessionId: changeset.originSessionId }) });
          }}
        />

        {/* Changesets replaced revisions; this panel stays for sessions that
            authored a revision record before that switch. */}
        <AgentRevisionSessionPanel
          sessionId={sessionId}
          token={token}
          project={projectId ?? approval.project}
          sessionStatus={displayStatus}
          onDetected={(identity) => {
            setIsRevisionSession(true);
            if (identity) setRevisionIdentity(identity);
          }}
        />
    </>
  );

  // ---- The "now" card: what this page is for in its current state ----
  // One card, directly under the header, built from fixed slots: a head that
  // names the state, a note the page cannot otherwise explain, the one thing
  // to read or do (the gate, the running step, the failure), the result, the
  // tiles, a way back to the parent, and the action row. Every mode fills
  // the same slots or leaves them empty; no mode composes its own tree.
  // Everything else on the page (judge, learnings, the transcript) folds
  // under it.
  const isSuspended = approval.sessionStatus === 'suspended';
  // The status word, said once, in the header. The sticky bar borrows it while
  // scrolled; no card, tile or badge repeats it.
  const { word: statusWord, tone: statusTone } = sessionStatusWord({
    status: displayStatus,
    mode,
    expired,
    stranded,
    suspended: isSuspended,
    ended,
  });
  const cardLabel = nowCardLabel({
    mode,
    viewOnly: isSubagentView,
    suspended: isSuspended,
    ended,
    preparing: status === 'preparing',
    escalation: Boolean(gateEntry?.details?.reviewEscalation),
  });
  // Slot: the note. Only a state the page cannot otherwise explain. An idle
  // card has nothing else to say, so its note becomes its headline.
  const note = cardNote ?? (mode !== 'idle'
    ? undefined
    : showParentApproveCta
      // A sub-agent never takes a decision itself. Say where the question is
      // and link to it, instead of copying the gate onto a page that cannot
      // answer it.
      ? `Waiting for a decision on ${parentLabel}, the parent run. Sub-agents don't take decisions themselves.`
      : ended
        ? 'This run ended with nothing to show; the session log below has the details.'
        : 'This session is not accepting actions right now.');

  // The row a working card leads with, and the row an error card blames.
  const runningEntry = mode === 'working' ? workingSessionEntry(orderedLogs) : undefined;
  const failedEntry = mode === 'error' ? failedSessionEntry(orderedLogs) : undefined;
  const recentSteps = mode === 'working'
    ? [...orderedLogs].reverse().filter((e) => e.type === 'tool' && e.status === 'completed' && !e.parentCallId).slice(0, 3).reverse()
    : [];
  // The agent's own words for what it is doing: the intent phrase it declared,
  // else the row's title. Never the raw tool id.
  const stepTitleOf = (entry: ApprovalLogEntry | undefined): string =>
    (entry?.details?.intent ?? entry?.title ?? '').trim();
  const delegateSession = runningEntry?.subagentSession;
  const delegateName = delegateSession?.label ?? delegateSession?.agent?.name;
  const workingHeadline = delegateName
    ? `Waiting on ${delegateName}, a sub-agent`
    : stepTitleOf(runningEntry) || workingLabel;
  const stepNumber = orderedLogs.filter((e) => e.type === 'tool' && !e.parentCallId).length;
  const workingMeta = [
    stepNumber > 0 ? `step ${stepNumber}` : undefined,
    runningEntry?.time !== undefined ? formatDuration(Date.now() - runningEntry.time) : undefined,
  ].filter(Boolean).join(' · ');

  // The card's headline: the one sentence this page exists to say. A decision
  // card has none of its own — the gate's question is its headline.
  const showOutcomeHeadline = Boolean(finalOutcome.headline)
    && !(resultErrorText && errorHeadline && resultErrorText.includes(errorHeadline));
  const headline = mode === 'working'
    ? (
      <div class="now-headline-row">
        <span class="log-spinner" aria-hidden="true" />
        <h2 class="now-headline">{workingHeadline}</h2>
        {workingMeta && <span class="now-headline-meta">{workingMeta}</span>}
      </div>
    )
    : mode === 'error' && resultErrorText
      ? (
        <h2 class="now-headline is-error">{sessionFailureHeadline({
          errorCode: approval.errorCode,
          errorMessage: approval.errorMessage,
          fallback: resultErrorText,
        })}</h2>
      )
      : mode === 'result' && showOutcomeHeadline && finalOutcome.headline
        ? <h2 class="now-headline"><InlineMarkdown value={finalOutcome.headline} /></h2>
        : mode === 'idle' && note
          ? <h2 class="now-headline">{note}</h2>
          : null;

  // The body under the headline, per mode: the gate, the failed row, the
  // recent steps, or the agent's report.
  const focus = mode === 'decision'
    ? gatePanel
    : mode === 'working'
      ? (recentSteps.length > 0
        ? <ul class="logs now-recent" role="list">{recentSteps.map((e) => renderLogEntry(e))}</ul>
        : null)
      : mode === 'error'
        ? (failedEntry ? <ul class="logs now-failed-step" role="list">{renderLogEntry(failedEntry)}</ul> : null)
        : null;

  const showOutcomeBody = hasFinalOutcome && (mode !== 'error' || finalOutcome.reported);
  const resultSlot = (ended && (recordedMetrics.length > 0 || showOutcomeBody)) || mode === 'result' || artifactTiles ? (
    <div class="session-result">
      {ended && showOutcomeBody ? (
        <>
          {/* On an error card the headline is the failure, so the agent's own
              headline drops back into the body rather than competing with it. */}
          {mode !== 'result' && showOutcomeHeadline && finalOutcome.headline && (
            <p class="result-headline"><InlineMarkdown value={finalOutcome.headline} /></p>
          )}
          {finalOutcome.body && (
            <div class="result-body"><LogContent value={finalOutcome.body} forceMarkdown /></div>
          )}
        </>
      ) : mode === 'result' ? (
        <div class="result-empty">This run ended without a final response; the session log below has the details.</div>
      ) : null}
      {/* Recorded business facts as plain numbers. They were chips, which made
          a count the agent measured look like a filter control. */}
      {ended && recordedMetrics.length > 0 && (
        <div class="result-metrics">
          {recordedMetrics.map((m) => {
            const amount = recordedMetricAmount(m);
            return (
              <a
                key={m.metric}
                class="result-metric"
                href={`/stores/metrics${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`}
                title={m.metric}
              >
                {amount && <span class="result-metric-amount">{amount}</span>}
                <span class="result-metric-name">{humanizeMetric(m.metric)}</span>
              </a>
            );
          })}
        </div>
      )}
      {artifactTiles && <div class="result-artifacts">{artifactTiles}</div>}
    </div>
  ) : null;

  // Slot: the way back. A sub-agent reports to its parent, where its
  // decisions are made.
  const parentCta = isSubagentView && parentLink ? (
    <div class="now-cta">
      <a class="debug-prompt-button now-cta-primary" href={parentLink}>{isSuspended ? 'Go to the decision' : `Open ${parentLabel}`}</a>
      {isSuspended && <span class="now-cta-note">{parentLabel} is waiting on you</span>}
    </div>
  ) : null;

  const nowCard = (
    <section
      class={`panel now-card is-${mode}`}
      aria-label={cardLabel}
      role={mode === 'error' ? 'alert' : undefined}
    >
      {headline}
      {note && mode !== 'idle' && <p class="now-note">{note}</p>}
      {focus}
      {resultSlot}
      {parentCta}
      {sessionActions}
      {ended && factsLine}
    </section>
  );

  // The transcript feed always lives in the same disclosure card. Page state
  // changes only its initial disclosure, never its visual presentation.
  const logsFeed = (
    <div class="transcript-feed">
      {logsTotal !== null && logsRef.current.size < logsTotal && (
        <button
          type="button"
          class="transcript-more"
          onClick={() => setLogsLimit((current) => Math.min(current + 400, 5_000))}
        >
          Load {logsTotal - logsRef.current.size} earlier {logsTotal - logsRef.current.size === 1 ? 'entry' : 'entries'}
        </button>
      )}
      <ul class="logs" role="log">
        {(visibleLogs.length === 0 || (logQuery && matchingFeedLogs.length === 0)) && (
          <li class="log-empty">
            {logQuery && visibleLogs.length > 0
              ? `No session log entries match “${logQuery}”.`
              : orderedLogs.length === 0
              ? 'No session events yet.'
              : `${debugCount} debug ${debugCount === 1 ? 'entry' : 'entries'} hidden. Enable the debug toggle to view.`}
          </li>
        )}
        {matchingFeedLogs.map((entry) => renderLogEntry(entry))}
        {showWorking && !logQuery && (
          <li class="log-item log-working">
            <div class="log-head">
              <span class="log-time" />
              <span class="log-marker"><span class="log-spinner" aria-label="working" /></span>
              <span class="log-title">{workingLabel}<span class="log-dots" aria-hidden="true" /></span>
            </div>
          </li>
        )}
      </ul>
    </div>
  );

  return (
    <div class={`page-approval-detail${isRevisionSession ? ' is-internal-revision' : ''}`}>
      <main>
        {/* A zero-height sticky shell. At rest it draws nothing at all: the
            header two rows below already carries the status, the name and the
            one control, and a bar repeating them would be the page's third
            copy of each. Once the page scrolls past the header, the compact
            bar inside fades in as the only thing left saying where you are. */}
        <div class={`session-sticky${scrolled ? ' is-scrolled' : ''}`}>
          <div class="session-sticky-bar">
            <span class={`session-status is-${statusTone}`}>
              <span class="session-status-dot" aria-hidden="true" />
              {statusWord}
            </span>
            <span class="session-sticky-name">{pageAgentLabel}</span>
            <span class="session-sticky-spacer" />
            {barControl && (
              <button
                type="button"
                class="session-bar-stop"
                disabled={barControl.busy}
                aria-busy={barControl.busy}
                tabIndex={scrolled ? 0 : -1}
                onClick={() => runControl(barControl)}
                title={barControl.title}
              >
                {barControl.busy
                  ? <span class="btn-spinner" aria-hidden="true" />
                  : (
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                  )}
                <span>{barControl.label}</span>
              </button>
            )}
            <button
              type="button"
              class="session-bar-top"
              onClick={scrollToTop}
              aria-label="Scroll to top"
              title="Scroll to top"
              tabIndex={scrolled ? 0 : -1}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
        <header class="session-header">
          {/* Row one: where you are, what state it is in, and the one thing to
              do about it. Everything that used to live in a second sticky bar
              is here, said once. */}
          <div class="session-header-controls">
            {isSubagentView && parentLink ? (
              <a class="session-bar-back" href={parentLink} aria-label={`Back to ${parentLabel}`} title={`Back to ${parentLabel}`}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span class="session-bar-back-label">{parentLabel}</span>
              </a>
            ) : (
              <a class="session-bar-back" href="/sessions" onClick={goBack} aria-label="Back to sessions" title="Back to sessions">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </a>
            )}
            <span class={`session-status is-${statusTone}`}>
              <span class="session-status-dot" aria-hidden="true" />
              {statusWord}
            </span>
            {approval?.mock && <span class="session-header-tag" title="Tool outputs were LLM-generated; no real tools ran">mock</span>}
            {isRevisionSession && <span class="session-header-tag">internal</span>}
            {isSubagentView && <span class="session-header-tag">view only</span>}
            <span class="session-header-spacer" />
            {actionable && queueNext && (
              <div class="session-bar-queue">
                <span class="session-bar-queue-count">{queueIndex + 1} of {pendingQueue.length} pending</span>
                <a
                  class="session-bar-queue-next"
                  href={`/sessions/${encodeURIComponent(queueNext.sessionId)}?project=${encodeURIComponent(queueNext.project)}`}
                  title={`Next pending: ${queueNext.agentName}`}
                >
                  Next
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </a>
              </div>
            )}
            {barControl && (
              <button
                type="button"
                class="session-bar-stop"
                disabled={barControl.busy}
                aria-busy={barControl.busy}
                onClick={() => runControl(barControl)}
                title={barControl.title}
              >
                {barControl.busy
                  ? <span class="btn-spinner" aria-hidden="true" />
                  : (
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                  )}
                <span>{barControl.label}</span>
              </button>
            )}
            {sessionMenuShown ? (
              <SessionMenu
                agentName={agentLabel}
                agentRunPath={approval.agent.runPath as string}
                // The URL's ?project= wins, but push links and direct session
                // URLs often omit it; the header's stamped project id keeps
                // "Run new session" working on multi-project daemons.
                projectId={sessionProjectId as string}
                diagnosticHref={diagnosticHref}
                {...(runControlsInMenu ? {
                  runActions: menuControls.map((control) => ({
                    label: control.label,
                    title: control.title,
                    icon: control.icon,
                    busy: control.busy,
                    onSelect: () => runControl(control),
                  })),
                } : {})}
              />
            ) : (
              <a class="meta-band-link session-header-diagnostic" href={diagnosticHref}>
                Diagnostic
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
              </a>
            )}
          </div>
          <div class="header-title-row">
            <h1>{pageAgentLabel}</h1>
            {isSubagentView && parentLink && (
              <span class="session-title-note">
                sub-agent of <a href={parentLink}>{parentLabel}</a>
              </span>
            )}
            {isRevisionSession && (
              <span class="session-title-note">
                by AgentUse
                {revisionIdentity?.originSessionId && (
                  <>
                    {', from '}
                    <a href={`/sessions/${encodeURIComponent(revisionIdentity.originSessionId)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`}>the originating run</a>
                  </>
                )}
              </span>
            )}
          </div>
          {/* One meta line, in one typeface, read left to right: what this run
              is, then what it has cost so far. The old page split it in two
              rows and repeated the elapsed time in the card head. */}
          <div class="session-meta-line">
            <span title={term('project')}>{projectId ?? approval.project ?? 'default'}</span>
            {approval.model && <span class="session-meta-model" title="model">{approval.model}</span>}
            {approval.createdAt !== undefined && (
              <span>started {formatApprovalTime(approval.createdAt)}</span>
            )}
            {elapsedLabel && <span>{elapsedLabel}</span>}
            {costLabel && <span>cost {costLabel}</span>}
            {mode === 'working' && contextLeftLabel && <span>context {contextLeftLabel}</span>}
            {mode === 'decision' && approval.expiresAt !== undefined && (
              <span>expires {formatApprovalTime(approval.expiresAt)}</span>
            )}
            <SessionIdCopy sessionId={approval.sessionId} short />
          </div>
        </header>

        {nowCard}

        {approval.additionalInstruction && (
          // The instruction a delegated run was handed can be the parent's
          // whole brief, thousands of words. It folds like the other drawers;
          // the first line shows in the row so the fold is not a mystery.
          <details class="panel additional-instruction is-foldable">
            <summary>
              <span class="label">additional instruction</span>
              <span class="additional-instruction-meta">{approval.additionalInstruction.split('\n').find((line) => line.trim())?.slice(0, 120) ?? ''}</span>
            </summary>
            <div class="body">{approval.additionalInstruction}</div>
          </details>
        )}

        {/* Above the session log, not below it. The log is the long thing on
            this page: anything under it is read only by someone who scrolled
            past every tool call to get there, which is not where a warning that
            the agent's learnings have stopped being read belongs. */}
        <JudgePanel rows={judgeRows} gateVisible={Boolean(gateEntry)} />

        <LearningsPanel
          hidden={!learningsVisible}
          sessionId={sessionId}
          token={token}
          {...(projectId ? { project: projectId } : {})}
        />

        <details
          class="session-transcript"
          key={`transcript-${sessionId}`}
          open={transcriptIsOpen}
          onToggle={(e) => setTranscriptIsOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>
            <span class="transcript-title">Log</span>
            {visibleLogs.length > 0 && (
              <span class="count">{visibleLogs.length} {visibleLogs.length === 1 ? 'entry' : 'entries'}</span>
            )}
            {!showDebug && debugCount > 0 && (
              <span class="count">{debugCount} debug hidden</span>
            )}
            {!transcriptIsOpen && (
              <span class="count">{sessionTranscriptFoldedCopy(mode)}</span>
            )}
            <span class="rule"></span>
          </summary>
          {logTools && <div class="transcript-tools">{logTools}</div>}
          {logsFeed}
        </details>

        {shouldShowResultNotice(result, mode === 'error', resultErrorText) && (
          <p ref={noticeRef} class={`notice${result.error ? ' error' : ''}`} role={result.error ? 'alert' : 'status'}>{result.text}</p>
        )}
      </main>

      <DecisionDialog
        open={decisionDialog !== null}
        mode={decisionDialog ?? 'comment'}
        choiceLabel={gateOptions?.find((o) => o.id === effectiveChoice)?.label}
        allowRemember={canRememberLearning}
        rememberApplies={rememberApplies}
        revisionGuidance={Boolean(gateEntry?.details?.reviewEscalation)}
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
