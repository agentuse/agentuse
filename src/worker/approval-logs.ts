import { describeErrorPart, describeLogPart } from '../runner';
import { describeLearningOutcome } from '../learning';
import { extractToolIntent, extractToolRecovery, withoutToolIntent } from '../runner/tool-intent';
import { resolveToolRecoveryLinks } from '../runner/tool-recovery';
import { LIVE_OUTPUT_METADATA_KEY } from '../tools/types';
import { formatOutcomeLine, normalizeHeadline, stripLeadingOutcomeLine, REPORT_COMPLETE_TOOL, REPORT_INCOMPLETE_TOOL } from '../tools/report-outcome';
import { repairEscapedText } from '../utils/display-text';
import { safeHttpUrl } from '../utils/url';
import type { LogPartLevel, SessionInfo } from '../session';
import { formatApprovalLogValue, formatTokenCount, valueAsRecord } from './helpers.js';
import type { ApprovalChange, ApprovalLogDetails, ApprovalOption, ApprovalReference, LogVerifySummary } from './types.js';

/**
 * Pair each `report_complete` / `report_incomplete` call with the assistant
 * text part the runtime wrote to deliver it, so the session view can render
 * the report on the call's own row and drop the duplicate text row.
 *
 * The pairing key is the opener line the runtime composes from the call's own
 * input ("✅ Complete: <headline>"), which makes this work on runs recorded
 * before this row existed — no marker on the stored part is needed.
 *
 * The body comes from the delivered text rather than straight from the call's
 * `details`, because the runtime merges `details` with any prose the agent
 * streamed alongside it; rebuilding from `details` alone would drop the
 * deliverable of an agent that streamed its document and attached a briefing
 * (agentuse-lab#198). Only the LAST match is claimed: an agent that typed the
 * opener itself keeps its own message as a real assistant response.
 */
export function collectRunOutcomes(parts: any[]): {
  outcomeByPartId: Map<string, NonNullable<ApprovalLogDetails['runOutcome']>>;
  deliveredTextIds: Set<string>;
} {
  const outcomeByPartId = new Map<string, NonNullable<ApprovalLogDetails['runOutcome']>>();
  const deliveredTextIds = new Set<string>();
  const openerToPartId = new Map<string, string>();
  for (const part of parts) {
    if (part?.type !== 'tool') continue;
    const tool = String(part.tool ?? '');
    if (tool !== REPORT_COMPLETE_TOOL && tool !== REPORT_INCOMPLETE_TOOL) continue;
    const input = valueAsRecord(part.state?.input);
    const opener = formatOutcomeLine(tool, input);
    if (!opener) continue;
    const kind = tool === REPORT_COMPLETE_TOOL ? 'complete' as const : 'incomplete' as const;
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      : [];
    // Stands in until the delivered text is found below: during a live run the
    // call lands a tick before the text part that delivers it.
    const attached = typeof input.details === 'string' ? repairEscapedText(input.details).trim() : '';
    const raw = kind === 'complete' ? input.headline : input.reason;
    outcomeByPartId.set(String(part.id), {
      kind,
      // The row draws its own verdict mark, so the headline arrives bare
      // rather than carrying the opener's "✅ Complete: " prefix.
      headline: normalizeHeadline(typeof raw === 'string' ? repairEscapedText(raw) : ''),
      ...(attached && { body: attached }),
      ...(artifacts.length > 0 && { artifacts })
    });
    openerToPartId.set(opener, String(part.id));
  }
  if (openerToPartId.size === 0) return { outcomeByPartId, deliveredTextIds };

  const deliveredByOpener = new Map<string, { id: string; body: string }>();
  for (const part of parts) {
    if (part?.type !== 'text' || part.role === 'user') continue;
    const text = typeof part.text === 'string' ? part.text : '';
    const newline = text.indexOf('\n');
    const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
    if (!openerToPartId.has(firstLine)) continue;
    deliveredByOpener.set(firstLine, {
      id: String(part.id),
      body: newline === -1 ? '' : text.slice(newline + 1).trim()
    });
  }
  for (const [opener, delivered] of deliveredByOpener) {
    deliveredTextIds.add(delivered.id);
    const outcome = outcomeByPartId.get(openerToPartId.get(opener)!)!;
    if (delivered.body) outcome.body = delivered.body;
  }
  return { outcomeByPartId, deliveredTextIds };
}

/** The structured verdict of a stored `type: 'verify'` part. */
export function verifySummaryFromPart(part: any): LogVerifySummary {
  const attempt = typeof part.attempt === 'number' ? part.attempt : 0;
  const maxRedos = typeof part.maxRedos === 'number' ? part.maxRedos : 0;
  const critique = typeof part.critique === 'string' ? part.critique : undefined;
  const judge = typeof part.judge === 'string' ? part.judge : undefined;
  const candidates = Array.isArray(part.candidates)
    ? (part.candidates as Array<{ id: string; pass: boolean; critique?: string; settled?: boolean; fingerprint?: string }>)
    : undefined;
  return {
    verdict: part.verdict as 'pass' | 'fail' | 'error' | 'skipped',
    attempt,
    maxAttempts: maxRedos + 1,
    ...(judge && { judge }),
    ...(critique && { critique }),
    ...(candidates && candidates.length > 0 && { candidates }),
  };
}

/** The latest verify marker recorded before `gatePartId` in the same session.
 *  A gate that bounced back from the judge is the one place a reviewer needs
 *  that verdict, and it is otherwise buried further up the folded log. */
export function judgeSummaryForGate(parts: any[], gatePartId: string): (LogVerifySummary & { previous?: LogVerifySummary }) | undefined {
  let latest: LogVerifySummary | undefined;
  let lastJudged: LogVerifySummary | undefined;
  for (const part of parts) {
    if (String(part?.id) === gatePartId) break;
    if (part?.type !== 'verify') continue;
    latest = verifySummaryFromPart(part);
    if (latest.verdict !== 'skipped') lastJudged = latest;
  }
  return withPreviousVerdict(latest, lastJudged);
}

/** Whether a judge child (possibly resumed across several attempts) produced
 *  the verdict for `attempt`. */
export function judgedAttempt(descendant: { attempt?: number; lastAttempt?: number }, attempt: number): boolean {
  if (descendant.attempt === undefined) return false;
  return attempt >= descendant.attempt && attempt <= (descendant.lastAttempt ?? descendant.attempt);
}

/** A skipped marker says "no judge looked at this"; the last real verdict
 *  rides along so the card can still show what the judge said about the
 *  earlier text, labelled as such. */
export function withPreviousVerdict(
  latest: LogVerifySummary | undefined,
  lastJudged: LogVerifySummary | undefined
): (LogVerifySummary & { previous?: LogVerifySummary }) | undefined {
  if (!latest) return undefined;
  if (latest.verdict === 'skipped' && lastJudged && lastJudged !== latest) return { ...latest, previous: lastJudged };
  return latest;
}

export function buildApprovalLogs(parts: any[]): Array<{ id: string; type: string; tool?: string; callId?: string; parentCallId?: string; toolId?: string; status?: string; level?: LogPartLevel; title: string; message?: string; time?: number; details?: ApprovalLogDetails; verify?: LogVerifySummary }> {
  const { outcomeByPartId, deliveredTextIds } = collectRunOutcomes(parts);
  // The runtime records an outcome tool's delivered report as an assistant
  // text part as well, so `sessions show`, a resumed run and a sub-agent's
  // parent all still find the run's final output. The session view renders
  // that report on the tool row that produced it, so keeping the text part
  // too would print the whole report twice — once as the report, once as an
  // "Assistant response" the model never wrote.
  const entries = parts.filter((part: any) => !deliveredTextIds.has(String(part?.id))).map((part: any) => {
    if (part?.type === 'log') {
      const view = describeLogPart(part);
      return {
        id: String(part.id),
        type: 'log',
        level: view.level,
        ...(part.toolId && { toolId: String(part.toolId) }),
        title: view.title,
        ...(view.message !== undefined && { message: view.message }),
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'text') {
      const message = formatApprovalLogValue(part.text);
      const isUser = part.role === 'user';
      return {
        id: String(part.id),
        type: 'text',
        ...(typeof part.time?.end === 'number' ? { status: 'completed' } : { status: 'streaming' }),
        title: isUser ? 'User response' : 'Assistant response',
        ...(message !== undefined && { message }),
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'reasoning') {
      const message = formatApprovalLogValue(part.text);
      return {
        id: String(part.id),
        type: 'reasoning',
        ...(typeof part.time?.end === 'number' ? { status: 'completed' } : { status: 'streaming' }),
        title: 'Reasoning',
        ...(message !== undefined && { message }),
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'compaction') {
      const before = typeof part.tokensBefore === 'number' ? part.tokensBefore : 0;
      const after = typeof part.tokensAfter === 'number' ? part.tokensAfter : 0;
      const saved = before - after;
      const pct = before > 0 ? Math.round((saved / before) * 100) : 0;
      const reasonLabel = part.reason === 'approval'
        ? 'at approval gate'
        : part.reason === 'step'
          ? 'at step boundary'
          : 'near context limit';
      const message = before > 0
        ? `${formatTokenCount(before)} → ${formatTokenCount(after)} tokens (−${pct}%), ${reasonLabel}`
        : `Compacted ${reasonLabel}`;
      return {
        id: String(part.id),
        type: 'compaction',
        title: 'Context compacted',
        message,
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'corrections') {
      // Numbers only, no sentence: the row is worded in log-entry.tsx, which
      // has to phrase the same three counts for the context view anyway. A
      // title composed here would be a second copy to keep in agreement.
      return {
        id: String(part.id),
        type: 'corrections',
        status: 'completed',
        title: 'learnings applied',
        ...(typeof part.applied === 'number' && { applied: part.applied }),
        ...(typeof part.active === 'number' && { active: part.active }),
        ...(typeof part.cap === 'number' && { cap: part.cap }),
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'learning') {
      const { title, message } = describeLearningOutcome({
        status: part.status,
        source: part.source,
        count: typeof part.count === 'number' ? part.count : 0,
        titles: Array.isArray(part.titles) ? part.titles : undefined,
        detail: typeof part.detail === 'string' ? part.detail : undefined,
      });
      return {
        id: String(part.id),
        type: 'learning',
        // 'error' drives the warning styling for a failed capture; both other
        // outcomes are terminal/non-live.
        status: part.status === 'failed' ? 'error' : 'completed',
        title,
        message,
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'verify') {
      const attempt = typeof part.attempt === 'number' ? part.attempt : 0;
      const maxRedos = typeof part.maxRedos === 'number' ? part.maxRedos : 0;
      const critique = typeof part.critique === 'string' ? part.critique : undefined;
      const judge = typeof part.judge === 'string' ? part.judge : undefined;
      const title = part.verdict === 'pass'
        ? `Verification passed${attempt > 0 ? ` (after ${attempt} redo${attempt === 1 ? '' : 's'})` : ''}`
        : part.verdict === 'fail'
          ? `Verification failed (attempt ${attempt + 1} of ${maxRedos + 1})`
          : part.verdict === 'skipped'
            ? 'Verification skipped'
            : 'Verification judge error';
      const message = part.verdict === 'error'
        ? critique ?? 'Judge failed; output shipped unverified'
        : part.verdict === 'skipped'
          ? critique ?? 'Not judged'
          : critique ?? (judge ? `Judged by ${judge}` : undefined);
      return {
        id: String(part.id),
        type: 'verify',
        status: part.verdict === 'pass' ? 'completed' : part.verdict === 'skipped' ? 'skipped' : 'error',
        title,
        ...(message !== undefined && { message }),
        verify: verifySummaryFromPart(part),
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'error') {
      const { title, message } = describeErrorPart({
        source: part.source === 'compaction' ? 'compaction' : 'agent',
        code: typeof part.code === 'string' ? part.code : undefined,
        message: typeof part.message === 'string' ? part.message : 'Error',
        detail: typeof part.detail === 'string' ? part.detail : undefined,
        statusCode: typeof part.statusCode === 'number' ? part.statusCode : undefined,
      });
      return {
        id: String(part.id),
        type: 'error',
        status: 'error',
        title,
        message,
        ...(typeof part.time?.start === 'number' && { time: part.time.start })
      };
    }
    if (part?.type === 'tool') {
      const state = part.state ?? {};
      const isAwaitHuman = part.tool === 'await_human';
      const genericApprovalDetails = typeof part.tool === 'string'
        ? buildGenericToolApprovalDetails(state, part.tool)
        : undefined;
      const runOutcome = outcomeByPartId.get(String(part.id));
      const built = isAwaitHuman
        ? buildAwaitHumanDetails(state)
        : genericApprovalDetails ?? buildToolDetails(state, part.tool);
      const details = runOutcome ? { ...(built ?? {}), runOutcome } : built;
      const message = details
        ? undefined
        : state.status === 'completed'
          ? formatApprovalLogValue(state.output)
          : state.status === 'error'
            ? formatApprovalLogValue(state.error)
            : state.status === 'pending'
              ? formatApprovalLogValue(state.input)
              : undefined;
      const title = isAwaitHuman
        ? approvalLogTitle(state)
        : genericApprovalDetails
          ? state.status === 'pending'
            ? `Approval required for ${part.tool}`
            : genericApprovalDetails.decisionStatus === 'rejected'
              ? `${part.tool} rejected`
              : state.status === 'completed'
                ? `${part.tool} approved and completed`
                : `${part.tool} approved`
        : `${part.tool ?? 'tool'} ${state.status ?? ''}`.trim();
      return {
        id: String(part.id),
        type: 'tool',
        ...(part.tool && { tool: String(part.tool) }),
        ...(part.callID && { callId: String(part.callID) }),
        ...(part.parentCallID && { parentCallId: String(part.parentCallID) }),
        ...(typeof state.status === 'string' && { status: state.status }),
        title,
        ...(message !== undefined && { message }),
        ...(details && { details }),
        ...(typeof state.time?.start === 'number'
          ? { time: state.time.start }
          : typeof state.suspendedAt === 'number'
            ? { time: state.suspendedAt }
            : {})
      };
    }
    return {
      id: String(part?.id ?? 'unknown'),
      type: String(part?.type ?? 'part'),
      title: String(part?.type ?? 'Session event')
    };
  });
  // Counters belong to model steps, not individual tool executions. For old
  // sessions without a step id, consume only the recorded number of adjacent
  // top-level calls with identical usage. Never count nested Code Mode calls.
  const seenSteps = new Set<string>();
  let legacyKey = '';
  let legacyRemaining = 0;
  let legacyStepId = '';
  let previousInput: number | undefined;
  const partsById = new Map(parts.map((part: any) => [String(part.id), part]));
  for (const entry of entries) {
    if (entry.type !== 'tool' || ('parentCallId' in entry && entry.parentCallId)) continue;
    const details = 'details' in entry ? entry.details : undefined;
    const usage = details?.tokenUsage;
    if (!usage) { legacyRemaining = 0; previousInput = undefined; continue; }
    const raw = partsById.get(entry.id)?.state?.metadata?.modelStepUsage;
    if (typeof raw?.stepId === 'string') {
      details.modelStepId = raw.stepId;
      if (seenSteps.has(raw.stepId)) delete details.tokenUsage;
      seenSteps.add(raw.stepId);
      legacyRemaining = 0;
    } else {
      const key = JSON.stringify(usage);
      if (legacyRemaining > 0 && key === legacyKey) {
        details.modelStepId = legacyStepId;
        delete details.tokenUsage;
        legacyRemaining--;
      } else {
        legacyStepId = entry.id;
        details.modelStepId = legacyStepId;
        legacyKey = key;
        legacyRemaining = Math.max(0, (usage.sharedCalls ?? 1) - 1);
      }
    }
    if (details.tokenUsage) {
      if (previousInput !== undefined) details.contextAddedTokens = usage.input - previousInput;
      previousInput = usage.input;
    }
  }
  // Second pass: hand every gate the verdict that preceded it. The judge runs
  // before await_human suspends, so a bounced draft's reason is already in the
  // log — just far above the card the reviewer is actually looking at.
  let latestVerify: LogVerifySummary | undefined;
  let lastJudged: LogVerifySummary | undefined;
  for (const entry of entries) {
    if (entry.type === 'verify' && 'verify' in entry && entry.verify) {
      latestVerify = entry.verify as LogVerifySummary;
      if (latestVerify.verdict !== 'skipped') lastJudged = latestVerify;
      continue;
    }
    if (entry.type !== 'tool' || !('tool' in entry) || entry.tool !== 'await_human' || !latestVerify) continue;
    const withJudge = entry as { details?: ApprovalLogDetails };
    withJudge.details = { ...(withJudge.details ?? {}), judge: withPreviousVerdict(latestVerify, lastJudged)! };
  }

  // Explicit model metadata is authoritative. If the model omitted it, the
  // resolver recognizes a contiguous retry chain over the same stored result,
  // plus an immediate successful same-tool call with corrected arguments.
  const toolInputByPartId = new Map<string, unknown>();
  for (const part of parts) {
    if (part?.type === 'tool') toolInputByPartId.set(String(part.id), part.state?.input);
  }
  const toolEntries = entries as Array<{
    id: string;
    type: string;
    tool?: string;
    callId?: string;
    status?: string;
    details?: ApprovalLogDetails;
  }>;
  const recoveryLinks = resolveToolRecoveryLinks(toolEntries.flatMap((entry) => {
    if (entry.type !== 'tool' || !entry.tool || !entry.callId || !entry.status) return [];
    return [{
      callId: entry.callId,
      tool: entry.tool,
      status: entry.status,
      input: toolInputByPartId.get(entry.id),
      ...(entry.details?.recoversCallId && { recoversCallId: entry.details.recoversCallId }),
    }];
  }));

  for (const entry of toolEntries) {
    if (entry.type !== 'tool' || !entry.callId) continue;
    const target = recoveryLinks.recoveryTargetByCallId.get(entry.callId);
    if (target) {
      entry.details = {
        ...(entry.details ?? {}),
        recoversCallId: target.failedCallId,
        ...(target.inferred && { recoveryInferred: true }),
      };
    } else if (entry.details?.recoversCallId) {
      const {
        recoversCallId: _invalidRecovery,
        recoveryInferred: _invalidInference,
        ...remainingDetails
      } = entry.details;
      if (Object.keys(remainingDetails).length > 0) entry.details = remainingDetails;
      else delete entry.details;
    }

    const recoveredBy = recoveryLinks.recoveryByFailedCallId.get(entry.callId);
    if (recoveredBy) {
      entry.details = {
        ...(entry.details ?? {}),
        recoveredByCallId: recoveredBy.recoveryCallId,
        ...(recoveredBy.inferred && { recoveryInferred: true }),
      };
    }
  }
  return groupParallelToolCalls(entries);
}

/** Presentation-only grouping. Persisted calls and their tool outputs stay intact. */
export function groupParallelToolCalls<T extends { id: string; type: string; tool?: string; callId?: string; parentCallId?: string; status?: string; title: string; time?: number; details?: ApprovalLogDetails }>(entries: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const step = entry.details?.modelStepId;
    if (entry.type !== 'tool' || entry.parentCallId || !step) continue;
    const group = groups.get(step) ?? [];
    group.push(entry);
    groups.set(step, group);
  }
  const parents = new Map<string, T>();
  for (const [step, calls] of groups) {
    // Decisions and outcomes retain their dedicated surfaces. Never hide an
    // actionable gate inside a display-only parent.
    if (calls.length < 2 || calls.some(call => call.status === 'pending' || call.tool === 'await_human' || call.tool?.startsWith('report_') || call.details?.toolApproval)) continue;
    const usage = calls.find(call => call.details?.tokenUsage)?.details?.tokenUsage;
    if (!usage || calls.length !== usage.sharedCalls) continue;
    const first = calls[0]!;
    parents.set(step, { id: `model-step:${step}`, callId: `model-step:${step}`, type: 'tool',
      title: 'Parallel tool calls', time: first.time,
      status: calls.some(call => call.status === 'error') ? 'error' : calls.some(call => call.status === 'running') ? 'running' : 'completed',
      details: {
        tokenUsage: usage,
        ...(first.details?.requestFingerprint && { requestFingerprint: first.details.requestFingerprint }),
        ...(first.details?.contextAddedTokens !== undefined && { contextAddedTokens: first.details.contextAddedTokens }),
        // Only direct responses enter this batch total. Descendant executions
        // may already be represented in a Code Mode response. Unknown sizes
        // must not masquerade as zero or a complete aggregate.
        ...(calls.every(call => typeof call.details?.returnedBytes === 'number') && {
          returnedBytes: calls.reduce((sum, call) => sum + call.details!.returnedBytes!, 0),
        }),
      },
    } as T);
  }
  const emitted = new Set<string>();
  return entries.flatMap(entry => {
    const step = entry.details?.modelStepId;
    const parent = step && !entry.parentCallId ? parents.get(step) : undefined;
    if (!parent || !step) return [entry];
    const details = { ...entry.details };
    delete details.tokenUsage;
    delete details.contextAddedTokens;
    delete details.requestFingerprint;
    const child = { ...entry, parentCallId: parent.callId, details };
    if (emitted.has(step)) return [child];
    emitted.add(step);
    return [parent, child];
  });
}

export function approvalLogTitle(state: any): string {
  if (state?.status === 'pending') return 'Pending for approval';
  if (state?.status === 'completed') {
    const output = valueAsRecord(state.output);
    const decision = typeof output.status === 'string' ? output.status.toLowerCase() : '';
    if (decision === 'approve' || decision === 'approved') return 'Approved';
    if (decision === 'reject' || decision === 'rejected') return 'Rejected';
    if (decision === 'comment' || decision === 'commented') return 'Comment sent';
    return 'Approval resolved';
  }
  if (state?.status === 'error') return 'Approval failed';
  return 'Approval';
}

/** Untrusted tool-input `changes`: keep only entries with real content. */
export function normalizeApprovalChanges(value: unknown): ApprovalChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes = value.flatMap((entry): ApprovalChange[] => {
    const rec = valueAsRecord(entry);
    const content = typeof rec.content === 'string' ? repairEscapedText(rec.content) : '';
    if (!content.trim()) return [];
    const label = typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : undefined;
    // The tool normalizes a listed displayContent into displayParts + a joined
    // string, but a record written by an older runtime or a raw transport can
    // still carry the list itself: accept both.
    const listed = Array.isArray(rec.displayParts) ? rec.displayParts : Array.isArray(rec.displayContent) ? rec.displayContent : undefined;
    const displayParts = listed
      ?.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => repairEscapedText(part.trim()));
    const displayContent = typeof rec.displayContent === 'string' && rec.displayContent.trim()
      ? repairEscapedText(rec.displayContent)
      : displayParts && displayParts.length > 0
        ? displayParts.join('\n\n')
        : undefined;
    const mediaUrls = Array.isArray(rec.media_urls)
      ? [...new Set(rec.media_urls.map(safeHttpUrl).filter((url): url is string => Boolean(url)))]
      : undefined;
    const optionId = typeof rec.optionId === 'string' && rec.optionId.trim() ? rec.optionId.trim() : undefined;
    return [{
      ...(label && { label }),
      content,
      ...(displayContent && { displayContent }),
      ...(displayParts && displayParts.length > 1 && { displayParts }),
      ...(mediaUrls && mediaUrls.length > 0 && { mediaUrls }),
      ...(optionId && { optionId }),
    }];
  });
  return changes.length > 0 ? changes : undefined;
}

/**
 * Untrusted tool-input `options`: keep only entries with a real id and label,
 * drop duplicate ids (first wins), and require at least two survivors, since
 * a one-entry "menu" degrades to the plain approve flow.
 */
export function normalizeApprovalOptions(value: unknown): ApprovalOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const options = value.flatMap((entry): ApprovalOption[] => {
    const rec = valueAsRecord(entry);
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const label = typeof rec.label === 'string' ? repairEscapedText(rec.label.trim()) : '';
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    const description = typeof rec.description === 'string' && rec.description.trim()
      ? repairEscapedText(rec.description.trim())
      : undefined;
    return [{
      id,
      label,
      ...(description && { description }),
      ...(rec.recommended === true && { recommended: true })
    }];
  });
  return options.length >= 2 ? options : undefined;
}

/** Untrusted tool-input `reference`: string fields only, URL must be http(s). */
export function normalizeApprovalReference(value: unknown): ApprovalReference | undefined {
  const rec = valueAsRecord(value);
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? repairEscapedText(v.trim()) : undefined;
  const url = safeHttpUrl(rec.url);
  const label = text(rec.label);
  const author = text(rec.author);
  const title = text(rec.title);
  const excerpt = text(rec.excerpt);
  const reference: ApprovalReference = {
    ...(label && { label }),
    ...(author && { author }),
    ...(title && { title }),
    ...(url && { url }),
    ...(excerpt && { excerpt })
  };
  return Object.keys(reference).length > 0 ? reference : undefined;
}

/** Untrusted suspension metadata for a strict-review feedback gate. */
export function normalizeReviewEscalation(value: unknown): ApprovalLogDetails['reviewEscalation'] | undefined {
  const rec = valueAsRecord(value);
  if (rec.kind !== 'fresh-review-exhausted' || typeof rec.critique !== 'string' || !rec.critique.trim()) return undefined;
  if (!Number.isInteger(rec.attempts) || (rec.attempts as number) < 1) return undefined;
  if (!Number.isInteger(rec.maxAttempts) || (rec.maxAttempts as number) < 1) return undefined;
  if ((rec.attempts as number) > (rec.maxAttempts as number)) return undefined;
  return {
    kind: 'fresh-review-exhausted',
    critique: repairEscapedText(rec.critique.trim()),
    attempts: rec.attempts as number,
    maxAttempts: rec.maxAttempts as number,
  };
}

export function buildAwaitHumanDetails(state: any): ApprovalLogDetails | undefined {
  const input = valueAsRecord(state?.input);
  const output = valueAsRecord(state?.output);
  const metadata = valueAsRecord(state?.metadata);
  const resumePayload = state?.status === 'pending'
    ? valueAsRecord(state?.resumePayload)
    : valueAsRecord(metadata.resumePayload);
  const fields: ApprovalLogDetails = {};
  if (typeof resumePayload.resumeToken === 'string' && resumePayload.resumeToken) {
    fields.resumeToken = resumePayload.resumeToken;
  }
  const reviewEscalation = normalizeReviewEscalation(resumePayload.reviewEscalation);
  if (reviewEscalation) fields.reviewEscalation = reviewEscalation;
  if (typeof input.prompt === 'string' && input.prompt) fields.prompt = repairEscapedText(input.prompt);
  if (typeof input.summary === 'string' && input.summary) fields.summary = repairEscapedText(input.summary);
  if (typeof input.context === 'string' && input.context) fields.context = repairEscapedText(input.context);
  if (typeof input.risk === 'string' && input.risk) fields.risk = repairEscapedText(input.risk);
  if (typeof input.draft === 'string' && input.draft) fields.draft = repairEscapedText(input.draft);
  const changes = normalizeApprovalChanges(input.changes);
  if (changes) fields.changes = changes;
  const reference = normalizeApprovalReference(input.reference);
  if (reference) fields.reference = reference;
  const options = normalizeApprovalOptions(input.options);
  if (options) fields.options = options;
  const safeDraftUrl = safeHttpUrl(input.draft_url);
  if (safeDraftUrl) fields.draftUrl = safeDraftUrl;
  const safeArtifactUrl = safeHttpUrl(input.artifact_url);
  if (safeArtifactUrl) fields.artifactUrl = safeArtifactUrl;
  const artifactPaths: string[] = [];
  if (typeof input.artifact_path === 'string' && input.artifact_path.trim()) artifactPaths.push(input.artifact_path.trim());
  if (Array.isArray(input.artifact_paths)) {
    for (const p of input.artifact_paths) {
      if (typeof p === 'string' && p.trim()) artifactPaths.push(p.trim());
    }
  }
  const uniqueArtifactPaths = [...new Set(artifactPaths)];
  if (uniqueArtifactPaths.length > 0) fields.artifactPaths = uniqueArtifactPaths;
  if (Array.isArray(resumePayload.artifactSnapshots)) {
    const snapshots = resumePayload.artifactSnapshots
      .map((s: unknown) => valueAsRecord(s))
      .filter((s) => typeof s.path === 'string' && /^[a-f0-9]{16}$/.test(String(s.hash)) && typeof s.ext === 'string')
      .map((s) => ({
        path: s.path as string,
        hash: s.hash as string,
        ext: s.ext as string,
        ...(typeof s.bytes === 'number' && { bytes: s.bytes })
      }));
    if (snapshots.length > 0) fields.artifactSnapshots = snapshots;
  }

  if (state?.status === 'completed') {
    const decisionStatus = typeof output.status === 'string' ? output.status : undefined;
    const decisionComment = typeof output.comment === 'string' ? output.comment : undefined;
    const decisionChoice = typeof output.choice === 'string' && output.choice ? output.choice : undefined;
    if (decisionChoice) fields.decisionChoice = decisionChoice;
    const reviewer = valueAsRecord(output.reviewer);
    const reviewerLabel = typeof reviewer.username === 'string'
      ? reviewer.username
      : typeof reviewer.name === 'string'
        ? reviewer.name
        : typeof reviewer.id === 'string'
          ? reviewer.id
        : undefined;
    if (decisionStatus) fields.decisionStatus = decisionStatus;
    if (decisionComment) fields.decisionComment = decisionComment;
    if (reviewerLabel) fields.decisionReviewer = reviewerLabel;
  } else if (state?.status === 'error') {
    const errText = typeof state.error === 'string' ? state.error : undefined;
    if (errText) fields.errorMessage = errText;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function normalizeToolOutputArtifact(value: unknown): ApprovalLogDetails['toolOutputArtifact'] | undefined {
  const artifact = valueAsRecord(value);
  if (artifact.kind !== 'tool-output' || typeof artifact.path !== 'string' || !artifact.path.trim()) {
    return undefined;
  }
  return {
    path: artifact.path.trim(),
    ...(typeof artifact.bytes === 'number' && { bytes: artifact.bytes }),
    ...(typeof artifact.originalChars === 'number' && { originalChars: artifact.originalChars }),
  };
}

export function toolOutputArtifactFromText(text: string | undefined): ApprovalLogDetails['toolOutputArtifact'] | undefined {
  if (!text) return undefined;
  const match = text.match(/full tool output saved to session artifact:\s+([^\s)]+)(?:\s+\((\d+)\s+bytes\))?/i)
    ?? text.match(/full output saved to session artifact:\s+([^\s)]+)(?:\s+\((\d+)\s+bytes\))?/i);
  if (!match?.[1]) return undefined;
  return {
    path: match[1],
    ...(match[2] ? { bytes: Number.parseInt(match[2], 10) } : {}),
  };
}

export function toolOutputArtifactFromState(state: any): ApprovalLogDetails['toolOutputArtifact'] | undefined {
  const stateMetadata = valueAsRecord(state?.metadata);
  const stateArtifact = normalizeToolOutputArtifact(stateMetadata.fullOutputArtifact);
  if (stateArtifact) return stateArtifact;

  const output = valueAsRecord(state?.output);
  const outputMetadata = valueAsRecord(output.metadata);
  const outputArtifact = normalizeToolOutputArtifact(outputMetadata.fullOutputArtifact);
  if (outputArtifact) return outputArtifact;

  const outputText = typeof state?.output === 'string'
    ? state.output
    : typeof output.output === 'string'
      ? output.output
      : undefined;
  return toolOutputArtifactFromText(outputText);
}

/**
 * `tools__artifact_save` returns `{ success, path, group, url }` and is called
 * with a `title`. Surface that as a viewable tile instead of dumping the raw
 * (often huge) file content and JSON result into the log.
 */
export function savedArtifactFromState(state: any): ApprovalLogDetails['savedArtifact'] | undefined {
  const output = valueAsRecord(state?.output);
  const outputText = typeof state?.output === 'string'
    ? state.output
    : typeof output.output === 'string'
      ? output.output
      : undefined;
  if (!outputText) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = valueAsRecord(JSON.parse(outputText));
  } catch {
    return undefined;
  }
  if (parsed.success !== true) return undefined;
  const url = safeHttpUrl(parsed.url);
  const path = typeof parsed.path === 'string' ? parsed.path.trim() : '';
  if (!url || !path) return undefined;
  const input = valueAsRecord(state?.input);
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined;
  const group = typeof parsed.group === 'string' && parsed.group ? parsed.group : undefined;
  return { url, path, ...(title ? { title } : {}), ...(group ? { group } : {}) };
}

/**
 * The child's own report, pulled off a completed `subagent__*` tool part so the
 * parent's row can show what the sub-agent delivered without a click-through to
 * the child session. Reads the shape composeSubagentResult writes: the verdict
 * and artifact list from `metadata`, the body from the output text with the
 * verdict line stripped (it becomes the row's headline instead of repeating).
 *
 * A child that never called an outcome tool still lands here: it has no
 * headline, and its prose becomes the body.
 */
export function subagentResultFromState(state: any, tool?: string): ApprovalLogDetails['subagentResult'] {
  if (!tool?.startsWith('subagent__')) return undefined;
  const output = valueAsRecord(state?.output);
  const metadata = valueAsRecord(output.metadata);
  const text = typeof output.output === 'string' ? output.output : undefined;
  if (text === undefined && Object.keys(metadata).length === 0) return undefined;

  const headline = typeof metadata.headline === 'string' ? metadata.headline : undefined;
  const incomplete = typeof metadata.incomplete === 'string' ? metadata.incomplete : undefined;
  const artifacts = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : [];
  const body = text ? stripLeadingOutcomeLine(text, incomplete ?? headline ?? '') : '';

  if (!headline && !incomplete && artifacts.length === 0 && !body) return undefined;
  return {
    ...(headline && { headline }),
    ...(incomplete && { incomplete }),
    ...(artifacts.length > 0 && { artifacts }),
    ...(body && { body }),
  };
}

export function buildToolDetails(state: any, tool?: string): ApprovalLogDetails | undefined {
  const fields: ApprovalLogDetails = {};
  if (state?.status === 'completed' && state.output !== undefined) {
    const serialized = typeof state.output === 'string' ? state.output : JSON.stringify(state.output);
    if (serialized !== undefined) fields.returnedBytes = Buffer.byteLength(serialized, 'utf8');
  }
  const usage = valueAsRecord(valueAsRecord(state?.metadata).modelStepUsage);
  const fingerprint = valueAsRecord(usage.requestFingerprint);
  if (typeof fingerprint.allHash === 'string' && /^[a-f0-9]{64}$/.test(fingerprint.allHash) && typeof fingerprint.sequence === 'number') {
    fields.requestFingerprint = {
      sequence: fingerprint.sequence, allHash: fingerprint.allHash,
      ...(typeof fingerprint.prefixHash === 'string' && /^[a-f0-9]{64}$/.test(fingerprint.prefixHash) && { prefixHash: fingerprint.prefixHash }),
      ...(typeof fingerprint.previousAllHash === 'string' && /^[a-f0-9]{64}$/.test(fingerprint.previousAllHash) && { previousAllHash: fingerprint.previousAllHash }),
      ...(typeof fingerprint.prefixUnchanged === 'boolean' && { prefixUnchanged: fingerprint.prefixUnchanged }),
    };
  }
  const inputTokens = usage.input;
  const outputTokens = usage.output;
  const cachedInputTokens = usage.cachedInput;
  if (
    typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0 &&
    typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0 &&
    typeof cachedInputTokens === 'number' && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0
  ) {
    const sharedCalls = typeof usage.sharedCalls === 'number' && Number.isFinite(usage.sharedCalls)
      ? Math.max(1, Math.floor(usage.sharedCalls))
      : undefined;
    fields.tokenUsage = {
      input: inputTokens,
      output: outputTokens,
      cachedInput: cachedInputTokens,
      ...(sharedCalls !== undefined && { sharedCalls }),
    };
  }

  if (state?.status === 'completed' && tool === 'tools__artifact_save') {
    const saved = savedArtifactFromState(state);
    // The tile is the whole story for a saved artifact; skip the input/output dump.
    if (saved) return { savedArtifact: saved };
  }

  // The injected intent phrase is the row's primary label; the input dump
  // shows the real args without it (an intent-only input renders no dump).
  const intent = extractToolIntent(state?.input);
  if (intent !== undefined) fields.intent = intent;
  const recoversCallId = extractToolRecovery(state?.input);
  if (recoversCallId !== undefined) fields.recoversCallId = recoversCallId;
  const inputWithoutMetadata = withoutToolIntent(state?.input);
  const inputIsEmpty = inputWithoutMetadata !== null
    && typeof inputWithoutMetadata === 'object'
    && Object.keys(inputWithoutMetadata).length === 0
    && (intent !== undefined || recoversCallId !== undefined);
  const input = inputIsEmpty ? undefined : formatApprovalLogValue(inputWithoutMetadata);
  if (input !== undefined) fields.input = input;

  if (state?.status === 'running') {
    // Live tail of a call still in flight. Written by the runner on a throttle
    // and dropped the moment the call settles, so a finished row never carries
    // one (see persistToolState).
    const live = valueAsRecord(state?.metadata)[LIVE_OUTPUT_METADATA_KEY];
    if (typeof live === 'string' && live.trim()) fields.liveOutput = live;
  }

  if (state?.status === 'completed') {
    // A sub-agent's result is the child's whole report. Rendered as the raw
    // `{output, metadata}` JSON dump it was unreadable, so the reviewer had to
    // open the child's own session to learn what it did. Surface it structured
    // instead and skip the dump.
    const subagentResult = subagentResultFromState(state, tool);
    if (subagentResult) {
      fields.subagentResult = subagentResult;
    } else {
      const output = formatApprovalLogValue(state.output);
      if (output !== undefined) fields.output = output;
    }
    const artifact = toolOutputArtifactFromState(state);
    if (artifact) fields.toolOutputArtifact = artifact;
  } else if (state?.status === 'error') {
    const error = formatApprovalLogValue(state.error);
    if (error !== undefined) fields.errorMessage = error;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function formatGenericToolApprovalValue(value: unknown): string {
  let rendered: string;
  if (value === undefined) rendered = 'undefined';
  else if (typeof value === 'string') rendered = value;
  else {
    try { rendered = JSON.stringify(value, null, 2); }
    catch { rendered = String(value); }
  }
  const limit = 16_384;
  return rendered.length <= limit ? rendered : `${rendered.slice(0, limit)}\n… [truncated for display]`;
}

function buildGenericToolApprovalDetails(state: any, tool: string): ApprovalLogDetails | undefined {
  const metadata = valueAsRecord(state?.metadata);
  const resumePayload = state?.status === 'pending'
    ? valueAsRecord(state?.resumePayload)
    : valueAsRecord(metadata.resumePayload);
  if (resumePayload.kind !== 'tool_approval' || typeof resumePayload.approvalId !== 'string') return undefined;
  const canonicalInput = formatGenericToolApprovalValue(state?.input);
  const signedRawInput = Object.prototype.hasOwnProperty.call(state ?? {}, 'rawApprovedInput')
    ? formatGenericToolApprovalValue(state.rawApprovedInput)
    : canonicalInput;
  const response = valueAsRecord(metadata.approvalResponse);
  const reviewer = valueAsRecord(metadata.approvalReviewer);
  const intent = extractToolIntent(state?.input);
  const recoversCallId = extractToolRecovery(state?.input);
  const approved = response.type === 'tool-approval-response' && typeof response.approved === 'boolean'
    ? response.approved
    : undefined;
  return {
    ...(state?.status === 'pending' && typeof resumePayload.resumeToken === 'string'
      ? { resumeToken: resumePayload.resumeToken }
      : {}),
    prompt: `Approve execution of ${tool}?`,
    ...(intent && { intent }),
    ...(recoversCallId && { recoversCallId }),
    toolApproval: {
      approvalId: resumePayload.approvalId,
      toolName: tool,
      canonicalInput,
      signedRawInput,
      ...(typeof resumePayload.signature === 'string' && { signature: resumePayload.signature }),
    },
    ...(approved !== undefined && { decisionStatus: approved ? 'approved' : 'rejected' }),
    ...(typeof response.reason === 'string' && { decisionComment: response.reason }),
    ...(typeof reviewer.username === 'string' && { decisionReviewer: reviewer.username }),
    ...(state?.status === 'error' && { errorMessage: formatApprovalLogValue(state.error) ?? 'Tool execution failed' }),
  };
}

export function toolPartStartedAt(part: any): number | undefined {
  const state = part?.state ?? {};
  if (state.status === 'pending' && typeof state.suspendedAt === 'number') return state.suspendedAt;
  if (typeof state.time?.start === 'number') return state.time.start;
  return undefined;
}

export function approvalWasRolledBackAfterResume(session: SessionInfo, approvalPart: any, parts: any[]): boolean {
  const state = approvalPart?.state ?? {};
  if (state.status !== 'pending' || !session.error) return false;
  const boundary = typeof state.suspendedAt === 'number' ? state.suspendedAt : undefined;
  if (boundary === undefined) return false;
  return parts.some((part) =>
    part?.type === 'tool' &&
    part?.id !== approvalPart.id &&
    (toolPartStartedAt(part) ?? 0) > boundary
  );
}

export function logsWithRecoveredApprovalDecision(
  logs: ReturnType<typeof buildApprovalLogs>,
  approvalPart: any
): ReturnType<typeof buildApprovalLogs> {
  return logs.map((entry) => {
    if (entry.id !== String(approvalPart?.id)) return entry;
    const { resumeToken: _resumeToken, ...detailsWithoutResume } = entry.details ?? {};
    return {
      ...entry,
      status: 'completed',
      title: 'Approved',
      details: {
        ...detailsWithoutResume,
        decisionStatus: 'approved'
      }
    };
  });
}

export function logsWithSessionError(
  logs: ReturnType<typeof buildApprovalLogs>,
  session: SessionInfo
): ReturnType<typeof buildApprovalLogs> {
  const errors = [...(session.errorHistory ?? []), ...(session.error ? [session.error] : [])];
  if (errors.length === 0) return logs;
  const sessionTime = typeof session.time?.updated === 'number' ? session.time.updated : undefined;
  return errors.reduce((entries, error, index) => {
    // Keep the original stable id for the first failure. Later attempts get
    // deterministic suffixes so every failure remains independently visible.
    const id = `session-error:${session.id}${index === 0 ? '' : `:${index + 1}`}`;
    if (entries.some((entry) => entry.id === id)) return entries;
    const message = error.message || error.code || 'Session failed';
    const lastLogTime = entries.reduce((max, entry) => Math.max(max, entry.time ?? 0), 0);
    const errorTime = typeof error.time === 'number' ? error.time : undefined;
    // Anchor the marker at the moment the failure was recorded. Older
    // sessions stored no error time and fall back to after existing logs.
    const time = errorTime ?? Math.max(lastLogTime, sessionTime ?? 0) + 1;
    return [
      ...entries,
      {
        id,
        type: 'session',
        status: 'error',
        title: 'Session failed',
        time,
        details: { errorMessage: message }
      }
    ];
  }, logs);
}
