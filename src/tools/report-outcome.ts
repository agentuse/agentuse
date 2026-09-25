import type { Tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';

/**
 * Mutable per-run outcome shared between the `report_outcome` tool and the
 * runner. The tool records the agent's own verdict on whether the run achieved
 * its objective; after the stream ends cleanly the runner reads this slot to
 * decide the terminal status and to surface the run's headline.
 *
 * Deliberately NOT a thrown signal: execution stops on a complete or idle
 * verdict through the runner's stop predicate, while an incomplete verdict may
 * keep stepping only for required bookkeeping and concise final context.
 * Created fresh per run in loadAgentTools, so a resumed session starts with a
 * clean outcome.
 *
 * One slot, two halves. When an agent reports twice (it learned mid-run that a
 * "complete" run was actually blocked, or vice versa), `incomplete` wins: see
 * classifyRunResult. A run that hit a real blocker is not complete regardless
 * of which call came last.
 *
 * `complete.idle` marks a run that checked and found nothing to do. It stays a
 * successful completion everywhere; the flag only lets a surface tell "did the
 * job" from "had no job", so a stretch of idle runs can be noticed.
 */
export interface RunOutcome {
  incomplete?: { reason: string; rejectionOnly?: boolean };
  complete?: { headline: string; details?: string; artifacts?: string[]; idle?: true };
}

/** Longest headline we keep verbatim; past this it stops being skimmable. */
export const MAX_HEADLINE_LENGTH = 160;

/**
 * Trim a headline to one line. Models occasionally hand back the whole report
 * here; downstream surfaces (Slack titles, feed rows, session lists) render
 * this in one line, so collapse newlines and cap the length rather than let a
 * paragraph through.
 */
export function normalizeHeadline(headline: string): string {
  const oneLine = headline.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_HEADLINE_LENGTH
    ? `${oneLine.slice(0, MAX_HEADLINE_LENGTH - 1).trimEnd()}…`
    : oneLine;
}

export const REPORT_OUTCOME_TOOL = 'report_outcome';
/**
 * The two tools `report_outcome` replaced. New runs never see them. They stay
 * readable because stored sessions contain their calls, and executable because
 * a session suspended before the change resumes with its original tool
 * snapshot (see bindLegacyOutcomeTools).
 */
export const REPORT_COMPLETE_TOOL = 'report_complete';
export const REPORT_INCOMPLETE_TOOL = 'report_incomplete';
export const OUTCOME_TOOL_NAMES: readonly string[] = [REPORT_OUTCOME_TOOL, REPORT_COMPLETE_TOOL, REPORT_INCOMPLETE_TOOL];

export function isOutcomeTool(toolName: string): boolean {
  return OUTCOME_TOOL_NAMES.includes(toolName);
}

export const OUTCOME_STATUSES = ['complete', 'idle', 'incomplete'] as const;
export type OutcomeStatus = typeof OUTCOME_STATUSES[number];

/** One outcome call, whichever tool made it, in the shape every reader wants. */
export interface OutcomeCall {
  status: OutcomeStatus;
  /** The one-line verdict; a legacy `report_incomplete` call's `reason`. Raw, not normalized. */
  headline: string;
  details?: string;
  artifacts?: string[];
  rejectionOnly?: boolean;
}

/**
 * Read an outcome call from its tool name and input. The one place that knows
 * the legacy tool names, so stored sessions from before `report_outcome` render
 * and reconcile exactly as new ones do. A legacy `report_complete` is never
 * idle: nothing in it says whether the run did anything.
 */
export function readOutcomeCall(toolName: string, input: unknown): OutcomeCall | undefined {
  if (!isOutcomeTool(toolName) || !input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  const details = typeof data.details === 'string' && data.details.trim() ? data.details : undefined;
  const listed = Array.isArray(data.artifacts)
    ? data.artifacts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : undefined;
  // A legacy call's [] carried no meaning (the field was optional), so it reads
  // as absent, exactly as the legacy tool recorded it.
  const artifacts = toolName === REPORT_COMPLETE_TOOL && !listed?.length ? undefined : listed;
  const rejectionOnly = typeof data.rejectionOnly === 'boolean' ? data.rejectionOnly : undefined;
  if (toolName === REPORT_INCOMPLETE_TOOL) {
    if (typeof data.reason !== 'string') return undefined;
    return { status: 'incomplete', headline: data.reason, ...(rejectionOnly !== undefined && { rejectionOnly }) };
  }
  if (typeof data.headline !== 'string') return undefined;
  const status: OutcomeStatus | undefined = toolName === REPORT_COMPLETE_TOOL
    ? 'complete'
    : OUTCOME_STATUSES.find((candidate) => candidate === data.status);
  if (!status) return undefined;
  return {
    status,
    headline: data.headline,
    ...(details && { details }),
    ...(artifacts && { artifacts }),
    ...(status === 'incomplete' && rejectionOnly !== undefined && { rejectionOnly }),
  };
}

const OUTCOME_OPENERS: Record<OutcomeStatus, string> = {
  complete: '✅ Complete',
  idle: '💤 Idle',
  incomplete: '⚠️ Incomplete',
};

/** The opener line every surface leads a declared outcome with. */
export function outcomeOpener(status: OutcomeStatus, headline: string): string {
  return `${OUTCOME_OPENERS[status]}: ${headline}`;
}

/**
 * The one-line verdict to render where the agent declared it, or undefined for
 * any other tool. The runtime prints this now, which is what lets the agent
 * skip writing a report at all: the outcome is on screen either way.
 *
 * Display only — capped like a headline so a rambling reason cannot swallow the
 * terminal. The full reason still travels on the error payload.
 */
export function formatOutcomeLine(toolName: string, input: unknown): string | undefined {
  const call = readOutcomeCall(toolName, input);
  return call && outcomeOpener(call.status, normalizeHeadline(call.headline));
}

const DETAILS_DESCRIPTION =
  'Optional Markdown body rendered under the headline. Include it ONLY when you have substance the headline cannot carry: per-item results, a table, a document you were asked to produce, findings a human must act on. Do not repeat the headline here, do not recap your steps, and do not restate a file you already wrote — link it. Omit this entirely when the headline says the whole thing. ' +
  'EXCEPTION, and it overrides every brevity rule: when your instructions specify an output format, document, schema, or template, `details` IS that output, complete and in full — every row, every field, no summarizing and no length ceiling. Putting the document in your prose and a summary here loses nothing but reaches the reader twice; put it here once.';

const REJECTION_ONLY_DESCRIPTION =
  'Set true only when a human rejection in this run or a delegated child is the sole reason for non-delivery. Set false if any independent failure or pending approval remains. Rejection-only runs are automatically dismissed after verifying the recorded human decision.';

/** Shared by the tool, runtime prompt, and reserved outcome turn. */
export const IDLE_OUTCOME_GUIDANCE =
  'You successfully checked and no action was due: nothing eligible, no alert condition met, or the intended work was already handled before this run. Routine bookkeeping (logs, checkpoints, watermarks, audit notes, or refreshed monitoring state) does not turn that into delivered work. Report idle even when the check itself was the requested task. A requested report, analysis, or other substantive deliverable that this run actually produced is complete, even if it recommends no action. Work that is due but blocked, including pending approval, is incomplete, never idle.';

export const OUTCOME_ARTIFACTS_DESCRIPTION =
  'Paths or URLs of substantive deliverables this run produced or changed: requested documents, PRs, issues, published posts, sent messages. Exclude routine bookkeeping and pre-existing outputs merely inspected or referenced. Use [] when this run delivered no substantive output, including idle runs. Relevant bookkeeping or prior-output links may go in details when needed.';

interface ReportOutcomeInput {
  status: OutcomeStatus;
  headline: string;
  details?: string;
  artifacts: string[];
  rejectionOnly?: boolean;
}

/**
 * The run's single outcome tool. `assertDeliverable` runs before a complete or
 * idle verdict is recorded, so an agent with a required structured submission
 * gets a tool error it can correct instead of a delivered run with nothing in it.
 */
export function createReportOutcomeTool(
  outcome: RunOutcome,
  options: { assertDeliverable?: () => void } = {}
): Tool {
  return {
    description:
      'Declare how this run ended and deliver its report. Judge the requested objective, not whether the run stopped cleanly. Pick one status:\n' +
      '- complete: the objective was achieved. This call IS your final answer: the runtime renders `headline` + `details` everywhere (terminal, Slack, the session list, the run feed, and the parent when you are a sub-agent). Call it once, when the work is done, then stop; do not also write the report as a normal message.\n' +
      '- idle: ' + IDLE_OUTCOME_GUIDANCE + ' `artifacts` must be []. The headline says what you checked and why no action was due. Also final: stop after it.\n' +
      '- incomplete: a required outcome was not delivered because a precondition, input, access path, login/session, dependency, or action failed. That includes items that were waiting but you could not act on (a failed check, a conflict, a missing approval), even when your instructions told you to skip them: skipping was right, but the work is stuck, so it is not idle. Name what is stuck and why. Use it even when stopping was correct or secondary work succeeded. Call it once the blocker is confirmed; the run stays active only for required bookkeeping and concise context not already in the headline. Do not resume core work or report again.\n' +
      'Unsure between idle and incomplete? Choose incomplete.',
    inputSchema: z.object({
      status: z.enum(OUTCOME_STATUSES).describe('complete, idle, or incomplete, as defined in the tool description.'),
      headline: z.string().describe(
        'ONE line, no markdown heading. complete: what the run achieved and the single number that matters (e.g. "Posted 10/10 connect replies, all verified; 10 of 20 daily budget left"). idle: what you checked. incomplete: what remains blocked and what a human must fix; alongside a human rejection, only the independent failures. Not the task restated, not a summary of your steps.'
      ),
      details: z.string().optional().describe(DETAILS_DESCRIPTION),
      artifacts: z.array(z.string()).describe(OUTCOME_ARTIFACTS_DESCRIPTION),
      rejectionOnly: z.boolean().optional().describe(`incomplete only. ${REJECTION_ONLY_DESCRIPTION}`),
    }),
    execute: async ({ status, headline, details, artifacts, rejectionOnly }: ReportOutcomeInput) => {
      if (status === 'incomplete') {
        // Last call wins: an agent may refine the reason as it learns more.
        outcome.incomplete = { reason: headline, ...(rejectionOnly !== undefined && { rejectionOnly }) };
        return 'Recorded: this run will end marked incomplete. Finish only required bookkeeping and concise non-duplicative context, then stop without another outcome call.';
      }
      if (status === 'idle' && artifacts.length > 0) {
        throw new Error(
          `status "idle" means this run delivered no substantive output, but artifacts lists ${artifacts.length}. ` +
          'Exclude routine bookkeeping and pre-existing outputs from artifacts. Use "complete" if the run produced a substantive deliverable, or "incomplete" if due work was blocked.'
        );
      }
      options.assertDeliverable?.();
      // Last call wins, matching incomplete: an agent may refine the headline
      // once late bookkeeping changes the number. The list is kept even when
      // empty: [] is the agent saying it has no substantive output artifacts.
      outcome.complete = {
        headline: normalizeHeadline(headline),
        ...(details?.trim() ? { details: details.trim() } : {}),
        artifacts,
        ...(status === 'idle' && { idle: true as const }),
      };
      // Deliberately does NOT ask for a report: this call already delivered it.
      return 'Recorded and delivered — this is the run\'s output. Write nothing further.';
    }
  };
}

/**
 * Legacy `report_incomplete`, bound only for sessions whose tool snapshot
 * predates `report_outcome`. A resumed session presents the snapshot's schema
 * and description to the model, so only this execute matters.
 */
export function createReportIncompleteTool(outcome: RunOutcome): Tool {
  return {
    description:
      'Declare that a required outcome was not delivered because a required precondition, input, access path, login/session, dependency, or action failed. ' +
      'Judge against the requested objective: use this even when stopping was correct, bookkeeping succeeded, or secondary work was completed. ' +
      'Call once the blocker is confirmed. The run remains active only so you can finish required bookkeeping and add concise context that is not already in the reason; do not resume core work or call report_complete later. ' +
      'Do not call this when a successful evaluation legitimately found nothing to act on — call report_complete instead.',
    inputSchema: z.object({
      reason: z.string().describe('One or two sentences: what remains blocked and what a human must fix. When there are independent failures alongside a human rejection, describe only those unresolved failures.'),
      rejectionOnly: z.boolean().optional().describe(REJECTION_ONLY_DESCRIPTION)
    }),
    execute: async ({ reason, rejectionOnly }: { reason: string; rejectionOnly?: boolean }) => {
      // Last call wins: an agent may refine the reason as it learns more.
      outcome.incomplete = { reason, ...(rejectionOnly !== undefined && { rejectionOnly }) };
      return 'Recorded: this run will end marked incomplete. Finish only required bookkeeping and concise non-duplicative context, then stop without another outcome call.';
    }
  };
}

/** Legacy `report_complete`, bound only for pre-`report_outcome` snapshots. */
export function createReportCompleteTool(outcome: RunOutcome, options: { assertDeliverable?: () => void } = {}): Tool {
  return {
    description:
      'Declare that this run achieved its objective AND deliver its report. This call IS your final answer: the runtime renders `headline` + `details` as the run\'s output everywhere (terminal, Slack, the session list, the run feed, and the parent when you are a sub-agent). ' +
      'Call it once, when the work is done, and then stop — do not also write the report as a normal message, or the reader gets it twice. ' +
      'A legitimately empty result still counts as complete (e.g. a sweep that found nothing to act on): say so in the headline and leave details out. ' +
      'Do not call this merely because the run ended cleanly: if a required outcome was skipped, blocked, failed, or only partially delivered, call report_incomplete.',
    inputSchema: z.object({
      headline: z.string().describe(
        'ONE line, no markdown heading, stating what the run achieved and the single number that matters (e.g. "Posted 10/10 connect replies, all verified; 10 of 20 daily budget left"). Not the task restated, not a summary of your steps.'
      ),
      details: z.string().optional().describe(DETAILS_DESCRIPTION),
      artifacts: z.array(z.string()).optional().describe(
        'Optional. Paths or URLs this run produced or changed (files written, PRs, issues, published posts). Callers use these instead of parsing your report.'
      )
    }),
    execute: async ({ headline, details, artifacts }: { headline: string; details?: string; artifacts?: string[] }) => {
      options.assertDeliverable?.();
      // Last call wins, matching report_incomplete: an agent may refine the
      // headline once late bookkeeping changes the number.
      outcome.complete = {
        headline: normalizeHeadline(headline),
        ...(details?.trim() ? { details: details.trim() } : {}),
        ...(artifacts?.length ? { artifacts } : {})
      };
      // Deliberately does NOT ask for a report: this call already delivered it.
      // Earlier wording here ("now write your final report") produced a second
      // copy whenever the runtime asked for a missing verdict at the end of a run.
      return 'Recorded and delivered — this is the run\'s output. Write nothing further.';
    }
  };
}

/**
 * The run's final output: what every surface shows.
 *
 * A complete or idle `report_outcome` is the primary path — its headline and
 * details ARE the report. Streamed prose is the fallback for a run that never called it (and
 * for a model that wrote its report the old way despite calling it, which is
 * why an already-written body is kept rather than dropped).
 */
export function composeFinalOutput(
  complete: { headline: string; details?: string; idle?: true } | undefined,
  streamedText: string
): string {
  if (!complete) return streamedText;
  const opener = outcomeOpener(complete.idle ? 'idle' : 'complete', complete.headline);
  // Both halves, not one: an agent whose deliverable IS its response often
  // streams the document and attaches a briefing, and taking only the attached
  // body silently threw the document away (agentuse-lab#198). Strip any status
  // line the model typed first, so the opener is never doubled.
  const body = mergeReportBodies(
    complete.details?.trim() ?? '',
    stripLeadingOutcomeLine(streamedText, complete.headline)
  );
  return body ? `${opener}\n\n${body}` : opener;
}

/** Whitespace-insensitive form for comparing two renderings of one report. */
function normalizeForContainment(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Combine the two places a report can arrive: the body the agent attached to
 * its outcome call and the prose it streamed.
 *
 * Containment rather than equality, because the common duplicate is one report
 * written twice — streamed, then attached — and the two copies rarely match
 * byte-for-byte once markdown is re-wrapped. When neither contains the other
 * they are genuinely different content (a briefing and a document), so both are
 * kept, briefing first.
 */
export function mergeReportBodies(details: string, prose: string): string {
  if (!details) return prose;
  if (!prose) return details;
  const normalizedDetails = normalizeForContainment(details);
  const normalizedProse = normalizeForContainment(prose);
  // Attached copy first, so an exact tie (the same report in both places) keeps
  // the one the agent deliberately structured rather than a stream re-wrap.
  if (normalizedDetails.includes(normalizedProse)) return details;
  if (normalizedProse.includes(normalizedDetails)) return prose;
  // The only signal for how often an agent splits its report this way: nothing
  // is lost now, so this line is the sole evidence the case still occurs.
  logger.debug(
    `[Outcome] Report arrived in two parts; keeping both (details ${details.length} chars, streamed ${prose.length} chars).`
  );
  return `${details}\n\n${prose}`;
}

/**
 * What a sub-agent tool hands back to its parent: the child's report as text,
 * plus the structured verdict a parent can act on without re-reading the body.
 */
export interface SubagentResult {
  output: string;
  metadata: {
    agent: string;
    headline?: string;
    artifacts?: string[];
    /** The child checked and found nothing to do. */
    idle?: true;
    incomplete?: string;
    rejectionOnly?: boolean;
  };
}

/**
 * Compose that pair. One composer because a parent receives a child's result
 * from two paths — a child that ran straight through, and a child resumed after
 * a human cleared its approval gate — and they drifted: the resume path rebuilt
 * the pair by hand and dropped the headline and artifacts, while a blocked child
 * arrived as the meaningless "completed without text response" with its reason
 * reachable only in metadata. Both now read the child's verdict the same way.
 *
 * Also the shape the session view reads to render a sub-agent row, so a row can
 * rely on `headline`/`artifacts` being present whenever the child declared them.
 */
export function composeSubagentResult(params: {
  agent: string;
  outcome?: RunOutcome | undefined;
  text?: string | undefined;
}): SubagentResult {
  const text = params.text ?? '';
  // Same precedence as classifyRunResult and the top-level run: a child that hit
  // a real blocker is not complete, whichever call it happened to make last.
  const incomplete = params.outcome?.incomplete;
  const complete = incomplete ? undefined : params.outcome?.complete;

  if (incomplete) {
    // Lead with the blocker. Before this, a child that declared itself blocked
    // and wrote no prose reached the parent as "completed without text
    // response", which managers then repeated to the human as the status.
    const opener = outcomeOpener('incomplete', incomplete.reason);
    const body = stripLeadingOutcomeLine(text, incomplete.reason);
    return {
      output: body ? `${opener}\n\n${body}` : opener,
      metadata: {
        agent: params.agent, incomplete: incomplete.reason,
        ...(incomplete.rejectionOnly !== undefined && { rejectionOnly: incomplete.rejectionOnly }),
      }
    };
  }

  return {
    output: composeFinalOutput(complete, text) || 'Sub-agent completed without text response',
    metadata: {
      agent: params.agent,
      ...(complete && {
        headline: complete.headline,
        ...(complete.artifacts && { artifacts: complete.artifacts }),
        ...(complete.idle && { idle: true as const }),
      })
    }
  };
}

/**
 * Drop a leading "✅ Complete: …" / "💤 Idle: …" / "⚠️ Incomplete: …" line, or a bare repeat of
 * the headline, from streamed prose. Models trained on the old contract still
 * open their report with one.
 */
export function stripLeadingOutcomeLine(text: string, headline: string): string {
  const lines = text.split('\n');
  let cut = 0;
  while (cut < lines.length && !lines[cut]!.trim()) cut++;
  const first = lines[cut]?.trim() ?? '';
  const isStatusLine = /^(✅\s*Complete:|💤\s*Idle:|⚠️\s*Incomplete:)/.test(first);
  const isHeadlineEcho = first.length > 0 && first === headline.trim();
  if (!isStatusLine && !isHeadlineEcho) return text.trim();
  return lines.slice(cut + 1).join('\n').trim();
}
