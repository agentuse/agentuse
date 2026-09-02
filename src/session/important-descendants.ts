import type { Part, SessionInfo, SessionTrigger } from './types';
import { isExecutingSessionStatus, isTerminalSessionStatus } from './status';

export type ImportantDescendantKind = 'judge' | 'verification' | 'approval' | 'failure' | 'mutation' | 'context';

export interface DescendantBreadcrumb {
  sessionId: string;
  agentName: string;
}

/** Additive session-detail projection. childSessions remains the direct-child
 * API; this collection contains important nodes at any depth plus only the
 * otherwise-routine ancestors needed to render their real hierarchy. */
export interface ImportantDescendantSummary {
  sessionId: string;
  parentSessionId: string;
  depth: number;
  breadcrumb: DescendantBreadcrumb[];
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
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  kinds: ImportantDescendantKind[];
  important: boolean;
  /** Reviewer-facing lifecycle phase derived from durable gate history. */
  phase?: 'revising' | 'awaiting-approval';
  label?: string;
  gateLabel?: string;
  attemptLabel?: string;
  activity?: DescendantActivity;
}

/** What a still-running descendant is doing right now. A RUNNING card otherwise
 * shows only the task it was handed, which answers "what was it told to do",
 * never "what is it doing"; the newest tool step answers the second. */
export interface DescendantActivity {
  /** Tool name of the newest step. */
  tool: string;
  /** Compact argument of that step, when its input carries an obvious one. */
  detail?: string;
  /** Tool steps taken so far, so the reader can tell progress from a stall. */
  steps: number;
  /** Start of the newest step, for a live elapsed timer. */
  startedAt: number;
  /** The newest step is still executing, rather than the last one that finished. */
  running: boolean;
}

export interface DescendantEvidence {
  session: SessionInfo;
  parts?: Part[];
}

interface ImportantDescendantEventBase {
  id: string;
  sourceLogId: string;
  ownerSessionId: string;
  depth: number;
  breadcrumb: DescendantBreadcrumb[];
  time: number;
}

export interface VerifyDescendantEvent extends ImportantDescendantEventBase {
  type: 'verify';
  verdict: 'pass' | 'fail' | 'error';
  judge?: string;
  mode: 'inline' | 'sessionless-agent';
  attempt: number;
  maxAttempts: number;
  attemptLabel: string;
  critique?: string;
}

export interface ReviewerFeedbackDescendantEvent extends ImportantDescendantEventBase {
  type: 'reviewer-feedback';
  reviewer?: string;
  comment: string;
  round: number;
  roundLabel: string;
}

export type ImportantDescendantEvent = VerifyDescendantEvent | ReviewerFeedbackDescendantEvent;

const JUDGE_IDENTITY_RE = /(^|[\s/_-])(judge|grader|review-gate|pipeline-gate)([\s/_-]|$)/i;
const MUTATION_IDENTITY_RE = /(^|[\s/_-])(publish|publisher|schedule|scheduler|send|sender|mailer|campaign|deploy|release|mutation|mutator|pipeline)([\s/_-]|$)/i;
const MUTATION_TOOL_RE = /(^|__|_)(publish|schedule|send|post|deploy|release|campaign)(_|$)/i;

function identityText(session: SessionInfo): string {
  return [session.agent.id, session.agent.name, session.agent.filePath, session.agent.description]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function toolStateInput(part: Part): Record<string, unknown> | undefined {
  if (part.type !== 'tool') return undefined;
  const state = part.state;
  if (!('input' in state) || !state.input || typeof state.input !== 'object' || Array.isArray(state.input)) return undefined;
  return state.input as Record<string, unknown>;
}

function approvalParts(parts: Part[]): Array<Extract<Part, { type: 'tool' }>> {
  return parts.filter((part): part is Extract<Part, { type: 'tool' }> =>
    part.type === 'tool' && part.tool === 'await_human'
  );
}

function gateLabel(parts: Part[]): string | undefined {
  // A completed gate is history, not the session's current phase. Reusing its
  // prompt while the agent revises is what made a RUNNING card look as though
  // it were still waiting on the previous approval round.
  const gate = [...approvalParts(parts)].reverse().find((part) => part.state.status === 'pending');
  if (!gate) return undefined;
  const input = toolStateInput(gate);
  for (const key of ['summary', 'prompt']) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.trim().replace(/\s+/g, ' ');
      return compact.length > 96 ? `${compact.slice(0, 93)}…` : compact;
    }
  }
  return 'Approval gate';
}

function reviewerDecision(part: Extract<Part, { type: 'tool' }>): {
  status?: string;
  comment?: string;
  reviewer?: string;
  human: boolean;
  time: number;
} | undefined {
  if (part.state.status !== 'completed') return undefined;
  const output = part.state.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  const reviewerRecord = record.reviewer && typeof record.reviewer === 'object' && !Array.isArray(record.reviewer)
    ? record.reviewer as Record<string, unknown>
    : {};
  const reviewer = [reviewerRecord.username, reviewerRecord.name, reviewerRecord.id]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
  const source = typeof record.source === 'string' ? record.source.toLowerCase() : undefined;
  const human = source !== 'pre-review'
    && source !== 'gate-preflight'
    && reviewer !== 'verify-judge'
    && reviewer !== 'agentuse-runtime';
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : undefined;
  const comment = typeof record.comment === 'string' && record.comment.trim()
    ? record.comment.trim()
    : undefined;
  const timeRecord = part.state.time as { start: number; end?: number };
  return {
    ...(status && { status }),
    ...(comment && { comment }),
    ...(reviewer && { reviewer }),
    human,
    time: timeRecord.end ?? timeRecord.start,
  };
}

function humanReviewerComments(parts: Part[]) {
  return approvalParts(parts)
    .map((part) => ({ part, decision: reviewerDecision(part) }))
    .filter((entry): entry is { part: Extract<Part, { type: 'tool' }>; decision: NonNullable<ReturnType<typeof reviewerDecision>> } =>
      Boolean(entry.decision?.human && entry.decision.comment && (entry.decision.status === 'comment' || entry.decision.status === 'commented'))
    );
}

function hasMutationEvidence(session: SessionInfo, parts: Part[]): boolean {
  if (MUTATION_IDENTITY_RE.test(identityText(session))) return true;
  return parts.some((part) => part.type === 'tool' && (
    MUTATION_TOOL_RE.test(part.tool) ||
    MUTATION_TOOL_RE.test(String(toolStateInput(part)?.intent ?? ''))
  ));
}

function isJudge(session: SessionInfo): boolean {
  return session.observability?.role === 'verify-judge' || JUDGE_IDENTITY_RE.test(identityText(session));
}

function verifyParts(parts: Part[]): Array<Extract<Part, { type: 'verify' }>> {
  return parts
    .filter((part): part is Extract<Part, { type: 'verify' }> => part.type === 'verify')
    .sort((a, b) => a.time.start - b.time.start || a.attempt - b.attempt || a.id.localeCompare(b.id));
}

function errorFields(session: SessionInfo): Pick<ImportantDescendantSummary, 'errorCode' | 'errorMessage'> {
  return {
    ...(session.error?.code && { errorCode: session.error.code }),
    ...(session.error?.message && { errorMessage: session.error.message }),
  };
}

/** Input keys that carry the human-meaningful argument of a tool call, in the
 * order a reader would want them. */
const ACTIVITY_DETAIL_KEYS = ['command', 'query', 'url', 'path', 'file_path', 'pattern', 'task', 'prompt', 'name'];

function activityDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ACTIVITY_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const compact = value.trim().replace(/\s+/g, ' ');
    return compact.length > 88 ? `${compact.slice(0, 85)}…` : compact;
  }
  return undefined;
}

type StartedToolPart = Extract<Part, { type: 'tool' }> & {
  state: Extract<Part, { type: 'tool' }>['state'] & { time: { start: number } };
};

/** The newest started tool step of a session that is still executing. Terminal
 * sessions report a duration instead, so they get no activity line. */
export function buildDescendantActivity(session: SessionInfo, parts: Part[]): DescendantActivity | undefined {
  if (!isExecutingSessionStatus(session.status)) return undefined;
  const steps = parts.filter((part): part is StartedToolPart =>
    part.type === 'tool' && part.state.status !== 'pending'
  );
  const latest = steps.reduce<StartedToolPart | undefined>(
    (newest, part) => !newest || part.state.time.start >= newest.state.time.start ? part : newest,
    undefined
  );
  if (!latest) return undefined;
  const detail = activityDetail(latest.state.input);
  return {
    tool: latest.tool,
    ...(detail && { detail }),
    steps: steps.length,
    startedAt: latest.state.time.start,
    running: latest.state.status === 'running',
  };
}

/** Classify important descendants and retain the minimum ancestor chain needed
 * to show them beneath their real parents. Historical judges without explicit
 * attempt metadata are numbered chronologically among Judge siblings. */
export function buildImportantDescendants(
  root: SessionInfo,
  evidence: DescendantEvidence[]
): ImportantDescendantSummary[] {
  if (evidence.length === 0) return [];
  const byId = new Map(evidence.map((item) => [item.session.id, item]));
  const raw = new Map<string, {
    item: DescendantEvidence;
    kinds: ImportantDescendantKind[];
    gateLabel?: string;
  }>();

  for (const item of evidence) {
    const parts = item.parts ?? [];
    const kinds: ImportantDescendantKind[] = [];
    const judge = isJudge(item.session);
    if (judge) kinds.push('judge');
    const gate = gateLabel(parts);
    if (approvalParts(parts).length > 0) kinds.push('approval');
    if (verifyParts(parts).length > 0) kinds.push('verification');
    if (item.session.status === 'error' || item.session.error?.code === 'INCOMPLETE') kinds.push('failure');
    if (!judge && hasMutationEvidence(item.session, parts)) kinds.push('mutation');
    raw.set(item.session.id, { item, kinds, ...(gate && { gateLabel: gate }) });
  }

  const included = new Set<string>();
  for (const [id, row] of raw) {
    if (row.kinds.length === 0) continue;
    included.add(id);
    let parentId = row.item.session.parentSessionID;
    while (parentId && parentId !== root.id) {
      included.add(parentId);
      parentId = byId.get(parentId)?.session.parentSessionID;
    }
  }

  const judgeOrdinals = new Map<string, number>();
  const judgesByParent = new Map<string, SessionInfo[]>();
  for (const row of raw.values()) {
    if (!row.kinds.includes('judge')) continue;
    const parent = row.item.session.parentSessionID ?? root.id;
    const judges = judgesByParent.get(parent) ?? [];
    judges.push(row.item.session);
    judgesByParent.set(parent, judges);
  }
  for (const judges of judgesByParent.values()) {
    judges.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
    judges.forEach((session, index) => judgeOrdinals.set(session.id, index));
  }

  const hasJudgeEvidence = (sessionId: string): boolean => {
    if (verifyParts(byId.get(sessionId)?.parts ?? []).length > 0) return true;
    for (const row of raw.values()) {
      if (!row.kinds.includes('judge')) continue;
      let parentId = row.item.session.parentSessionID;
      while (parentId) {
        if (parentId === sessionId) return true;
        if (parentId === root.id) break;
        parentId = byId.get(parentId)?.session.parentSessionID;
      }
    }
    return false;
  };

  const contextFor = (session: SessionInfo): { depth: number; breadcrumb: DescendantBreadcrumb[] } => {
    const lineage: SessionInfo[] = [];
    let parentId = session.parentSessionID;
    while (parentId && parentId !== root.id) {
      const parent = byId.get(parentId)?.session;
      if (!parent) break;
      lineage.push(parent);
      parentId = parent.parentSessionID;
    }
    lineage.reverse();
    return {
      depth: lineage.length + 1,
      breadcrumb: [root, ...lineage].map((entry) => ({
        sessionId: entry.id,
        agentName: entry.agent.name || entry.agent.id,
      })),
    };
  };

  const result: ImportantDescendantSummary[] = [];
  for (const item of evidence) {
    const session = item.session;
    if (!included.has(session.id) || !session.parentSessionID) continue;
    const classified = raw.get(session.id)!;
    const important = classified.kinds.length > 0;
    const kinds = important ? classified.kinds : ['context'] as ImportantDescendantKind[];
    const explicitAttempt = session.observability?.attempt;
    const ordinal = explicitAttempt ?? judgeOrdinals.get(session.id);
    const maxAttempts = session.observability?.maxAttempts;
    const attemptLabel = kinds.includes('judge') && ordinal !== undefined
      ? `Judge attempt ${ordinal + 1}${maxAttempts ? ` of ${maxAttempts}` : ''}`
      : undefined;
    const failedBeforeJudge = kinds.includes('failure')
      && MUTATION_IDENTITY_RE.test(identityText(session))
      && !hasJudgeEvidence(session.id);
    const reviewerComments = humanReviewerComments(item.parts ?? []);
    const pendingGate = classified.gateLabel;
    const active = isExecutingSessionStatus(session.status);
    const phase = pendingGate
      ? 'awaiting-approval' as const
      : reviewerComments.length > 0 && active
        ? 'revising' as const
        : undefined;
    const fallbackLabel = kinds.includes('failure')
      ? session.error?.code === 'INCOMPLETE' ? 'Incomplete descendant' : 'Descendant failed'
      : kinds.includes('mutation') ? 'Mutation / publishing workflow'
        : kinds.includes('verification') ? 'Verification workflow' : undefined;
    const label = failedBeforeJudge
      ? 'Failed before Judge'
      : attemptLabel
        ? `Automated pre-review · ${attemptLabel}`
        : pendingGate
          ? `${reviewerComments.length > 0 ? 'Revised approval · ' : ''}${pendingGate}`
          : phase === 'revising'
            ? 'Revising after reviewer feedback'
            : fallbackLabel;
    const terminal = isTerminalSessionStatus(session.status);
    const activity = buildDescendantActivity(session, item.parts ?? []);
    result.push({
      sessionId: session.id,
      parentSessionId: session.parentSessionID,
      ...contextFor(session),
      agent: {
        id: session.agent.id,
        name: session.agent.name,
        ...(session.agent.description && { description: session.agent.description }),
        ...(session.agent.filePath && { filePath: session.agent.filePath }),
      },
      status: session.status,
      trigger: session.trigger ?? 'manual',
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      ...(terminal && session.time.updated >= session.time.created && { durationMs: session.time.updated - session.time.created }),
      ...errorFields(session),
      kinds,
      important,
      ...(phase && { phase }),
      ...(label && { label }),
      ...(classified.gateLabel && { gateLabel: classified.gateLabel }),
      ...(attemptLabel && { attemptLabel }),
      ...(activity && { activity }),
    });
  }
  return result;
}

/** Inline criteria and judge-agent setup failures have verify markers but no
 * inspectable child session. Project those markers as events under the owning
 * session. A matching real Judge child wins and suppresses the virtual event. */
export function buildImportantDescendantEvents(
  root: SessionInfo,
  evidence: DescendantEvidence[]
): ImportantDescendantEvent[] {
  const byId = new Map(evidence.map((item) => [item.session.id, item]));
  const judgeChildren = new Map<string, SessionInfo[]>();
  for (const item of evidence) {
    if (!isJudge(item.session) || !item.session.parentSessionID) continue;
    const siblings = judgeChildren.get(item.session.parentSessionID) ?? [];
    siblings.push(item.session);
    judgeChildren.set(item.session.parentSessionID, siblings);
  }
  for (const siblings of judgeChildren.values()) {
    siblings.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  }

  const breadcrumbFor = (owner: SessionInfo): DescendantBreadcrumb[] => {
    const lineage: SessionInfo[] = [owner];
    let parentId = owner.parentSessionID;
    while (parentId && parentId !== root.id) {
      const parent = byId.get(parentId)?.session;
      if (!parent) break;
      lineage.push(parent);
      parentId = parent.parentSessionID;
    }
    lineage.reverse();
    return [root, ...lineage].map((session) => ({
      sessionId: session.id,
      agentName: session.agent.name || session.agent.id,
    }));
  };

  const events: ImportantDescendantEvent[] = [];
  for (const item of evidence) {
    const comments = humanReviewerComments(item.parts ?? []);
    comments.forEach(({ part, decision }, index) => {
      const breadcrumb = breadcrumbFor(item.session);
      events.push({
        id: `reviewer-feedback-event-${item.session.id}-${part.id}`,
        sourceLogId: part.id,
        type: 'reviewer-feedback',
        ownerSessionId: item.session.id,
        depth: breadcrumb.length,
        breadcrumb,
        ...(decision.reviewer && { reviewer: decision.reviewer }),
        comment: decision.comment!,
        round: index + 1,
        roundLabel: `Revision request ${index + 1}`,
        time: decision.time,
      });
    });

    const markers = verifyParts(item.parts ?? []);
    if (markers.length === 0) continue;
    const realJudges = judgeChildren.get(item.session.id) ?? [];
    const explicitAttempts = new Set(realJudges
      .map((session) => session.observability?.attempt)
      .filter((attempt): attempt is number => attempt !== undefined));
    let historicalJudgesRemaining = realJudges.filter((session) => session.observability?.attempt === undefined).length;

    for (const marker of markers) {
      if (explicitAttempts.has(marker.attempt)) continue;
      if (historicalJudgesRemaining > 0) {
        historicalJudgesRemaining--;
        continue;
      }
      const maxAttempts = marker.maxRedos + 1;
      const judge = marker.judge?.trim() || undefined;
      const breadcrumb = breadcrumbFor(item.session);
      events.push({
        id: `verify-event-${item.session.id}-${marker.id}`,
        sourceLogId: marker.id,
        type: 'verify',
        ownerSessionId: item.session.id,
        depth: breadcrumb.length,
        breadcrumb,
        verdict: marker.verdict,
        ...(judge && { judge }),
        mode: judge?.toLowerCase().endsWith('.agentuse') ? 'sessionless-agent' : 'inline',
        attempt: marker.attempt,
        maxAttempts,
        attemptLabel: `Attempt ${marker.attempt + 1} of ${maxAttempts}`,
        time: marker.time.start,
        ...(marker.critique && { critique: marker.critique }),
      });
    }

  }
  return events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
