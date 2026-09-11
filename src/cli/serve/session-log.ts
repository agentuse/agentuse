/**
 * Folding a session's subagent activity into its own log.
 *
 * Matches child sessions to the tool calls that spawned them, builds the
 * important-descendant tree the session page renders, and synthesises entries
 * for subagents that left no child record. Moved verbatim out of serve.ts.
 */
import type { DescendantActivity, DescendantBreadcrumb, DescendantReport, ImportantDescendantEvent, ImportantDescendantKind, ImportantDescendantSummary, VerifyCandidateSummary } from "../../session/important-descendants";
import { isTerminalSessionStatus } from "../../session/status";
import type { SessionTrigger } from "../../session/types";
import { agentBaseName } from "../../utils/agent-id.js";

export interface ChildSessionSummary {
  sessionId: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
  };
  status: string;
  trigger: SessionTrigger;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
  /** Newest tool step, present only while the child is still executing. */
  activity?: DescendantActivity;
  /** Terminal report declared by this child, independent of its agent role. */
  report?: DescendantReport;
}

export interface ApprovalLogEntry {
  id: string;
  type: string;
  tool?: string;
  callId?: string;
  status?: string;
  /** Severity for `type: 'log'` entries; carried through the worker IPC. */
  level?: 'debug' | 'info' | 'warn' | 'error' | 'system';
  title: string;
  message?: string;
  time?: number;
  subagentSession?: LogSubagentSession;
  details?: ApprovalLogDetails;
}

export interface LogSubagentSession extends ChildSessionSummary {
  /** Fallback card for a subagent tool call whose durable child record is not
   * available yet (or was never created by an older runtime). */
  synthetic?: boolean;
  href?: string;
  command: string;
  displayStatus: string;
  parentSessionId?: string;
  depth?: number;
  breadcrumb?: DescendantBreadcrumb[];
  durationMs?: number;
  kinds?: ImportantDescendantKind[];
  important?: boolean;
  phase?: 'revising' | 'awaiting-approval';
  label?: string;
  gateLabel?: string;
  attemptLabel?: string;
  /** Judge children: 0-based attempt, and the verdict its parent's verify
   *  marker recorded for it. */
  attempt?: number;
  lastAttempt?: number;
  verdict?: 'pass' | 'fail' | 'error' | 'skipped';
  critique?: string;
  candidates?: VerifyCandidateSummary[];
  maxAttempts?: number;
  report?: DescendantReport;
  events?: LogSubagentEvent[];
  children?: LogSubagentSession[];
}

export type LogSubagentEvent = ImportantDescendantEvent & {
  href?: string;
  displayStatus: string;
};

export interface ApprovalLogDetails {
  resumeToken?: string;
  prompt?: string;
  /** Model-declared goal of this call (the injected `intent` parameter). */
  intent?: string;
  input?: string;
  output?: string;
  tokenUsage?: {
    input: number;
    output: number;
    cachedInput: number;
    sharedCalls?: number;
  };
  summary?: string;
  context?: string;
  risk?: string;
  draft?: string;
  changes?: Array<{ label?: string; content: string; displayContent?: string; optionId?: string }>;
  reference?: { label?: string; author?: string; title?: string; url?: string; excerpt?: string };
  options?: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
  draftUrl?: string;
  artifactUrl?: string;
  /** Project-root-relative paths to local file artifacts, viewable via /sessions/:id/artifacts/*. */
  artifactPaths?: string[];
  /** Completed child report returned on the parent subagent__* call. Retained as
   * a compatibility source for sessions written before child summaries carried
   * their own report. */
  subagentResult?: {
    headline?: string;
    incomplete?: string;
    artifacts?: string[];
    body?: string;
  };
  /** The pre-review verdict that immediately preceded this gate. `sessionId`
   *  names the judge child; this layer resolves it to `sessionHref`. */
  judge?: {
    verdict: 'pass' | 'fail' | 'error';
    attempt: number;
    maxAttempts: number;
    judge?: string;
    critique?: string;
    candidates?: VerifyCandidateSummary[];
    sessionId?: string;
    sessionHref?: string;
  };
  decisionStatus?: string;
  decisionComment?: string;
  decisionChoice?: string;
  decisionReviewer?: string;
  errorMessage?: string;
}

export function normalizeSubagentName(value: string): string {
  return agentBaseName(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/-/g, '_');
}

export function subagentNameTokens(value: string): string[] {
  return normalizeSubagentName(value)
    .split('_')
    .filter((part) => part.length > 0);
}

export function childSessionLogMatchScore(child: ChildSessionSummary, entry: ApprovalLogEntry): number {
  if (!entry.tool?.startsWith('subagent__')) return 0;
  const toolName = normalizeSubagentName(entry.tool.slice('subagent__'.length));
  const candidates = [
    normalizeSubagentName(child.agent.id),
    normalizeSubagentName(child.agent.name || ''),
  ];
  if (candidates.includes(toolName)) return 100;
  if (candidates.some((candidate) => candidate.includes(toolName) || toolName.includes(candidate))) return 80;

  const toolTokens = subagentNameTokens(entry.tool.slice('subagent__'.length));
  if (toolTokens.length > 0) {
    const candidateTokens = new Set([
      ...subagentNameTokens(child.agent.id),
      ...subagentNameTokens(child.agent.name || ''),
    ]);
    const matched = toolTokens.filter((token) => candidateTokens.has(token));
    if (matched.length === toolTokens.length) return 70;
    if (matched.length > 0 && matched.length / toolTokens.length >= 0.5) return 40;
  }

  const timeDelta = typeof entry.time === 'number'
    ? Math.abs(child.createdAt - entry.time)
    : Number.POSITIVE_INFINITY;
  return timeDelta <= 5_000 ? 10 : 0;
}

export function renderChildSessionStatus(child: ChildSessionSummary): string {
  if (child.status === 'error' && child.errorCode === 'USER_STOPPED') return 'stopped';
  if (child.status === 'error' && child.errorCode === 'TIMEOUT') return 'timeout';
  if (child.status === 'error' && child.errorCode === 'INCOMPLETE') return 'incomplete';
  return child.status;
}

export function enrichChildSessionForLog(
  child: ChildSessionSummary,
  childSessionHref?: (sessionId: string) => string,
  details: Partial<LogSubagentSession> = {}
): LogSubagentSession {
  return {
    ...child,
    ...details,
    displayStatus: details.phase ?? renderChildSessionStatus(child),
    command: `agentuse sessions show ${child.sessionId.substring(0, 12)} --all-search`,
    ...(childSessionHref && { href: childSessionHref(child.sessionId) }),
  };
}

export function importantDescendantTree(
  childSessions: ChildSessionSummary[],
  importantDescendants: ImportantDescendantSummary[] = [],
  childSessionHref?: (sessionId: string) => string,
  root?: { sessionId: string; agentName: string },
  importantDescendantEvents: ImportantDescendantEvent[] = []
): LogSubagentSession[] {
  const nodes = new Map<string, LogSubagentSession>();
  const directIds = new Set(childSessions.map((child) => child.sessionId));

  for (const child of childSessions) {
    const terminal = isTerminalSessionStatus(child.status);
    nodes.set(child.sessionId, enrichChildSessionForLog(child, childSessionHref, {
      ...(terminal && child.updatedAt >= child.createdAt && { durationMs: child.updatedAt - child.createdAt }),
      ...(root && {
        parentSessionId: root.sessionId,
        depth: 1,
        breadcrumb: [{ sessionId: root.sessionId, agentName: root.agentName }],
      }),
    }));
  }
  for (const descendant of importantDescendants) {
    const existing = nodes.get(descendant.sessionId);
    const child: ChildSessionSummary = existing ?? descendant;
    nodes.set(descendant.sessionId, enrichChildSessionForLog(child, childSessionHref, {
      parentSessionId: descendant.parentSessionId,
      depth: descendant.depth,
      breadcrumb: descendant.breadcrumb,
      ...(descendant.durationMs !== undefined && { durationMs: descendant.durationMs }),
      kinds: descendant.kinds,
      important: descendant.important,
      ...(descendant.phase && { phase: descendant.phase }),
      ...(descendant.label && { label: descendant.label }),
      ...(descendant.gateLabel && { gateLabel: descendant.gateLabel }),
      ...(descendant.attemptLabel && { attemptLabel: descendant.attemptLabel }),
      ...(descendant.attempt !== undefined && { attempt: descendant.attempt }),
      ...(descendant.lastAttempt !== undefined && { lastAttempt: descendant.lastAttempt }),
      ...(descendant.verdict && { verdict: descendant.verdict }),
      ...(descendant.critique && { critique: descendant.critique }),
      ...(descendant.candidates && { candidates: descendant.candidates }),
      ...(descendant.maxAttempts !== undefined && { maxAttempts: descendant.maxAttempts }),
      ...(descendant.activity && { activity: descendant.activity }),
      ...(descendant.report && { report: descendant.report }),
    }));
  }

  for (const descendant of importantDescendants) {
    if (directIds.has(descendant.sessionId)) continue;
    const node = nodes.get(descendant.sessionId);
    const parent = nodes.get(descendant.parentSessionId);
    if (!node || !parent) continue;
    parent.children = [...(parent.children ?? []), node];
  }
  for (const event of importantDescendantEvents) {
    const owner = nodes.get(event.ownerSessionId);
    if (!owner) continue;
    const ownerHref = childSessionHref?.(event.ownerSessionId);
    const projected: LogSubagentEvent = {
      ...event,
      displayStatus: event.type === 'reviewer-feedback'
        ? 'commented'
        : event.verdict === 'pass' ? 'passed' : event.verdict === 'fail' ? 'failed' : event.verdict === 'skipped' ? 'not judged' : 'error',
      ...(ownerHref && { href: `${ownerHref}#log-${encodeURIComponent(event.sourceLogId)}` }),
    };
    owner.events = [...(owner.events ?? []), projected];
  }
  for (const node of nodes.values()) {
    node.children?.sort((a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId));
    node.events?.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  return childSessions.map((child) => nodes.get(child.sessionId)!).filter(Boolean);
}

export function childSessionLogEntry(
  child: ChildSessionSummary,
  childSessionHref?: (sessionId: string) => string
): ApprovalLogEntry {
  const session = enrichChildSessionForLog(child, childSessionHref);
  return {
    id: `subagent-session-${child.sessionId}`,
    type: 'subagent',
    status: session.displayStatus,
    title: `${child.agent.name || child.agent.id} ${session.displayStatus}`,
    time: child.createdAt,
    subagentSession: session,
  };
}

export function fallbackSubagentSession(entry: ApprovalLogEntry): LogSubagentSession | undefined {
  if (!entry.tool?.startsWith('subagent__')) return undefined;
  const rawName = entry.tool.slice('subagent__'.length) || 'subagent';
  const name = rawName
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'pr' ? 'PR' : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  const explicitError = entry.details?.errorMessage;
  const failureText = explicitError ?? [entry.details?.output, entry.message]
    .find((value) => typeof value === 'string' && /sub-agent\b.*\bfailed:|all mcp servers failed/i.test(value));
  const status = failureText || entry.status === 'error'
    ? 'error'
    : entry.status === 'pending' ? 'running' : entry.status ?? 'running';
  const createdAt = entry.time ?? 0;
  return {
    sessionId: entry.callId ?? entry.id,
    agent: { id: rawName, name: name || rawName },
    status,
    trigger: 'manual',
    createdAt,
    updatedAt: createdAt,
    ...(failureText && { errorMessage: failureText }),
    synthetic: true,
    command: '',
    displayStatus: status,
    ...(() => {
      const report = reportFromSubagentResult(entry.details?.subagentResult);
      return report ? { report } : {};
    })(),
  };
}

/** Compatibility adapter for sessions written before child summaries carried
 * their own durable report. New sessions derive this from the child's
 * report_complete/report_incomplete part; old ones can still use the result
 * returned on the parent subagent__* call. */
export function reportFromSubagentResult(
  result: ApprovalLogDetails['subagentResult'] | undefined
): DescendantReport | undefined {
  if (!result) return undefined;
  const headline = result.incomplete ?? result.headline;
  if (!headline) return undefined;
  return {
    status: result.incomplete ? 'incomplete' : 'complete',
    headline,
    ...(result.body && { body: result.body }),
    ...(result.artifacts?.length && { artifacts: result.artifacts }),
  };
}

export function logsWithChildSessions(
  logs: ApprovalLogEntry[] = [],
  childSessions: ChildSessionSummary[] = [],
  childSessionHref?: (sessionId: string) => string,
  importantDescendants: ImportantDescendantSummary[] = [],
  root?: { sessionId: string; agentName: string },
  importantDescendantEvents: ImportantDescendantEvent[] = []
): ApprovalLogEntry[] {
  const childTree = importantDescendantTree(
    childSessions,
    importantDescendants,
    childSessionHref,
    root,
    importantDescendantEvents
  );

  const matchedChildIds = new Set<string>();
  const assignedChildren = new Map<string, LogSubagentSession>();
  for (const entry of logs) {
    if (entry.subagentSession) {
      matchedChildIds.add(entry.subagentSession.sessionId);
      const current = childTree.find((candidate) => candidate.sessionId === entry.subagentSession?.sessionId);
      assignedChildren.set(entry.id, current ?? entry.subagentSession);
    }
  }

  // Match globally instead of walking logs chronologically. With repeated calls
  // to the same agent, a greedy oldest-first pass attached the newest child to
  // the first historical call solely because their names matched. Ranking every
  // available pair lets time proximity break that tie before either side is used.
  const candidates = logs
    .filter((entry) => !entry.subagentSession && entry.tool?.startsWith('subagent__'))
    .flatMap((entry) => childTree
      .filter((child) => !matchedChildIds.has(child.sessionId))
      .map((child) => ({
        entry,
        child,
        score: childSessionLogMatchScore(child, entry),
        timeDelta: typeof entry.time === 'number'
          ? Math.abs(child.createdAt - entry.time)
          : Number.POSITIVE_INFINITY,
      })))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      a.timeDelta - b.timeDelta ||
      (a.entry.time ?? 0) - (b.entry.time ?? 0) ||
      a.child.sessionId.localeCompare(b.child.sessionId)
    );
  for (const candidate of candidates) {
    if (assignedChildren.has(candidate.entry.id) || matchedChildIds.has(candidate.child.sessionId)) continue;
    assignedChildren.set(candidate.entry.id, candidate.child);
    matchedChildIds.add(candidate.child.sessionId);
  }

  // A gate's judge verdict travels with the judge child's session id; only this
  // layer knows how to mint a viewable link for it.
  const withJudgeHref = (entry: ApprovalLogEntry): ApprovalLogEntry => {
    const judge = entry.details?.judge;
    if (!judge?.sessionId || !childSessionHref) return entry;
    return {
      ...entry,
      details: { ...entry.details, judge: { ...judge, sessionHref: childSessionHref(judge.sessionId) } },
    };
  };

  const enrichedLogs = logs.map((entry) => {
    const child = assignedChildren.get(entry.id);
    if (child) {
      const report = child.report ?? reportFromSubagentResult(entry.details?.subagentResult);
      return withJudgeHref({
        ...entry,
        subagentSession: report && report !== child.report ? { ...child, report } : child,
      });
    }
    const fallback = fallbackSubagentSession(entry);
    return withJudgeHref(fallback ? { ...entry, subagentSession: fallback } : entry);
  });

  for (const child of childTree) {
    if (!matchedChildIds.has(child.sessionId)) {
      enrichedLogs.push(childSessionLogEntry(child, childSessionHref));
    }
  }

  return enrichedLogs.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.id.localeCompare(b.id));
}
