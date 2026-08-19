import type { Tool } from 'ai';
import { z } from 'zod';
import { logger } from '../utils/logger';

/**
 * Mutable per-run outcome shared between the `report_complete` /
 * `report_incomplete` tools and the runner. The tools record the agent's own
 * verdict on whether the run achieved its objective; after the stream ends
 * cleanly the runner reads this slot to decide the terminal status and to
 * surface the run's headline.
 *
 * Deliberately NOT a thrown signal: execution stops report_complete through the
 * runner's stop predicate, while report_incomplete may keep stepping only for
 * required bookkeeping and concise final context. Created fresh per run in
 * loadAgentTools, so a resumed session starts with a clean outcome.
 *
 * One slot, two writers. When an agent calls both (it learned mid-run that a
 * "complete" run was actually blocked, or vice versa), `incomplete` wins: see
 * classifyRunResult. A run that hit a real blocker is not complete regardless
 * of which call came last.
 */
export interface RunOutcome {
  incomplete?: { reason: string };
  complete?: { headline: string; details?: string; artifacts?: string[] };
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

export const REPORT_COMPLETE_TOOL = 'report_complete';
export const REPORT_INCOMPLETE_TOOL = 'report_incomplete';

/**
 * The one-line verdict to render where the agent declared it, or undefined for
 * any other tool. The runtime prints this now, which is what lets the agent
 * skip writing a report at all: the outcome is on screen either way.
 *
 * Display only — capped like a headline so a rambling reason cannot swallow the
 * terminal. The full reason still travels on the error payload.
 */
export function formatOutcomeLine(toolName: string, input: unknown): string | undefined {
  const data = (input ?? {}) as { headline?: unknown; reason?: unknown };
  if (toolName === REPORT_COMPLETE_TOOL && typeof data.headline === 'string') {
    return `✅ Complete: ${normalizeHeadline(data.headline)}`;
  }
  if (toolName === REPORT_INCOMPLETE_TOOL && typeof data.reason === 'string') {
    return `⚠️ Incomplete: ${normalizeHeadline(data.reason)}`;
  }
  return undefined;
}

export function createReportIncompleteTool(outcome: RunOutcome): Tool {
  return {
    description:
      'Declare that a required outcome was not delivered because a required precondition, input, access path, login/session, dependency, or action failed. ' +
      'Judge against the requested objective: use this even when stopping was correct, bookkeeping succeeded, or secondary work was completed. ' +
      'Call once the blocker is confirmed. The run remains active only so you can finish required bookkeeping and add concise context that is not already in the reason; do not resume core work or call report_complete later. ' +
      'Do not call this when a successful evaluation legitimately found nothing to act on — call report_complete instead.',
    inputSchema: z.object({
      reason: z.string().describe('One or two sentences: what blocked the run and what a human must fix before the next attempt (e.g. "Substack session logged out; needs re-auth").')
    }),
    execute: async ({ reason }: { reason: string }) => {
      // Last call wins: an agent may refine the reason as it learns more.
      outcome.incomplete = { reason };
      return 'Recorded: this run will end marked incomplete. Finish only required bookkeeping and concise non-duplicative context, then stop without another outcome call.';
    }
  };
}

export function createReportCompleteTool(outcome: RunOutcome): Tool {
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
      details: z.string().optional().describe(
        'Optional Markdown body rendered under the headline. Include it ONLY when you have substance the headline cannot carry: per-item results, a table, a document you were asked to produce, findings a human must act on. Do not repeat the headline here, do not recap your steps, and do not restate a file you already wrote — link it. Omit this entirely when the headline says the whole thing. ' +
        'EXCEPTION, and it overrides every brevity rule: when your instructions specify an output format, document, schema, or template, `details` IS that output, complete and in full — every row, every field, no summarizing and no length ceiling. Putting the document in your prose and a summary here loses nothing but reaches the reader twice; put it here once.'
      ),
      artifacts: z.array(z.string()).optional().describe(
        'Optional. Paths or URLs this run produced or changed (files written, PRs, issues, published posts). Callers use these instead of parsing your report.'
      )
    }),
    execute: async ({ headline, details, artifacts }: { headline: string; details?: string; artifacts?: string[] }) => {
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
 * `report_complete` is the primary path — its headline and details ARE the
 * report. Streamed prose is the fallback for a run that never called it (and
 * for a model that wrote its report the old way despite calling it, which is
 * why an already-written body is kept rather than dropped).
 */
export function composeFinalOutput(
  complete: { headline: string; details?: string } | undefined,
  streamedText: string
): string {
  if (!complete) return streamedText;
  const opener = `✅ Complete: ${complete.headline}`;
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
 * `report_complete` and the prose it streamed.
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
    incomplete?: string;
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
    const opener = `⚠️ Incomplete: ${incomplete.reason}`;
    const body = stripLeadingOutcomeLine(text, incomplete.reason);
    return {
      output: body ? `${opener}\n\n${body}` : opener,
      metadata: { agent: params.agent, incomplete: incomplete.reason }
    };
  }

  return {
    output: composeFinalOutput(complete, text) || 'Sub-agent completed without text response',
    metadata: {
      agent: params.agent,
      ...(complete && {
        headline: complete.headline,
        ...(complete.artifacts?.length && { artifacts: complete.artifacts })
      })
    }
  };
}

/**
 * Drop a leading "✅ Complete: …" / "⚠️ Incomplete: …" line, or a bare repeat of
 * the headline, from streamed prose. Models trained on the old contract still
 * open their report with one.
 */
export function stripLeadingOutcomeLine(text: string, headline: string): string {
  const lines = text.split('\n');
  let cut = 0;
  while (cut < lines.length && !lines[cut]!.trim()) cut++;
  const first = lines[cut]?.trim() ?? '';
  const isStatusLine = /^(✅\s*Complete:|⚠️\s*Incomplete:)/.test(first);
  const isHeadlineEcho = first.length > 0 && first === headline.trim();
  if (!isStatusLine && !isHeadlineEcho) return text.trim();
  return lines.slice(cut + 1).join('\n').trim();
}
