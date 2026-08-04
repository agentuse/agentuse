import type { Tool } from 'ai';
import { z } from 'zod';

/**
 * Mutable per-run outcome shared between the `report_complete` /
 * `report_incomplete` tools and the runner. The tools record the agent's own
 * verdict on whether the run achieved its objective; after the stream ends
 * cleanly the runner reads this slot to decide the terminal status and to
 * surface the run's headline.
 *
 * Deliberately NOT a thrown signal: the agent keeps running after either call
 * so it can finish bookkeeping (store writes, final report) before the run
 * ends. Created fresh per run in loadAgentTools, so a resumed session starts
 * with a clean outcome.
 *
 * One slot, two writers. When an agent calls both (it learned mid-run that a
 * "complete" run was actually blocked, or vice versa), `incomplete` wins: see
 * classifyRunResult. A run that hit a real blocker is not complete regardless
 * of which call came last.
 */
export interface RunOutcome {
  incomplete?: { reason: string };
  complete?: { headline: string; artifacts?: string[] };
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

export function createReportIncompleteTool(outcome: RunOutcome): Tool {
  return {
    description:
      'Declare that this run cannot achieve its objective (blocked precondition, missing access or expired login, unrecoverable dependency failure). ' +
      'The run continues so you can finish bookkeeping and your final report, but it ends marked "incomplete" instead of "completed" and failure notifications fire. ' +
      'Do not call this for an empty-but-successful result (e.g. a sweep that legitimately found nothing to act on) — call report_complete instead.',
    inputSchema: z.object({
      reason: z.string().describe('One or two sentences: what blocked the run and what a human must fix before the next attempt (e.g. "Substack session logged out; needs re-auth").')
    }),
    execute: async ({ reason }: { reason: string }) => {
      // Last call wins: an agent may refine the reason as it learns more.
      outcome.incomplete = { reason };
      return 'Recorded: this run will end marked incomplete. Finish any remaining bookkeeping and produce your final report as usual.';
    }
  };
}

export function createReportCompleteTool(outcome: RunOutcome): Tool {
  return {
    description:
      'Declare that this run achieved its objective, and give the one-line headline every surface shows first (Slack, the session list, the run feed, and the parent when you are a sub-agent). ' +
      'Call this once, just before your final report. A legitimately empty result still counts as complete (e.g. a sweep that found nothing to act on) — say so in the headline. ' +
      'If the objective was blocked instead, call report_incomplete.',
    inputSchema: z.object({
      headline: z.string().describe(
        'ONE line, no markdown heading, stating what the run achieved and the single number that matters (e.g. "Posted 10/10 connect replies, all verified; 10 of 20 daily budget left"). Not a restatement of the task, not a summary of your steps.'
      ),
      artifacts: z.array(z.string()).optional().describe(
        'Optional. Paths or URLs this run produced or changed (files written, PRs, issues, published posts). Callers use these instead of parsing your report.'
      )
    }),
    execute: async ({ headline, artifacts }: { headline: string; artifacts?: string[] }) => {
      // Last call wins, matching report_incomplete: an agent may refine the
      // headline once late bookkeeping changes the number.
      outcome.complete = {
        headline: normalizeHeadline(headline),
        ...(artifacts?.length ? { artifacts } : {})
      };
      // Deliberately does NOT say "now write your report". This call can arrive
      // after the report is already written (the runtime asks for a missing
      // verdict at the end of a run), and an instruction to write one there
      // produced a second copy of the whole report.
      return 'Recorded: this run will end marked complete with that headline. If you have not written your final report yet, write it now, opening with that same headline.';
    }
  };
}
