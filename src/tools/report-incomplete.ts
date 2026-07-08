import type { Tool } from 'ai';
import { z } from 'zod';

/**
 * Mutable per-run outcome shared between the `report_incomplete` tool and the
 * runner. The tool records the agent's own verdict that the run did not achieve
 * its objective; after the stream ends cleanly the runner reads it and marks the
 * session `error`/`INCOMPLETE` (firing failure channels) instead of `completed`.
 *
 * This is deliberately NOT a thrown signal: the agent keeps running after the
 * call so it can finish bookkeeping (store writes, final report) before the run
 * ends. Created fresh per run in loadAgentTools, so a resumed session starts
 * with a clean outcome.
 */
export interface RunOutcome {
  incomplete?: { reason: string };
}

export function createReportIncompleteTool(outcome: RunOutcome): Tool {
  return {
    description:
      'Declare that this run cannot achieve its objective (blocked precondition, missing access or expired login, unrecoverable dependency failure). ' +
      'The run continues so you can finish bookkeeping and your final report, but it ends marked "incomplete" instead of "completed" and failure notifications fire. ' +
      'Do not call this for an empty-but-successful result (e.g. a sweep that legitimately found nothing to act on).',
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
