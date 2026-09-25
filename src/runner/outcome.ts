import type { RunAgentResult } from './types';
import type { RunOutcome } from '../tools/report-outcome.js';
import { IDLE_OUTCOME_GUIDANCE } from '../tools/report-outcome.js';
import { aggregateToolCalls, countSteps } from '../telemetry/metrics.js';

/**
 * Asked once when a run is about to end without either outcome tool being
 * called. Deliberately forbids new prose: the stream consumer ACCUMULATES text
 * across segments (`finalText += chunk.text`), so a nudge that invited another
 * report would append a second copy to the first. We are recovering the
 * structured verdict here, not rewriting the body — surfaces render
 * `complete.headline` above whatever text the run already produced.
 */
export const OUTCOME_NUDGE_PROMPT =
  '[runtime] This run is ending without a declared outcome. The preceding turn may have reached its normal work-step limit after returning a tool result; this reserved outcome-only turn does not authorize more work. ' +
  'Review the full preceding task and tool trace, and do not invent a blocker or claim work was skipped when the trace shows it was performed. ' +
  'Call report_outcome now with a one-line headline: status "complete" if the requested objective was achieved with substantive work delivered, "idle" if a successful check found no action due, ' +
  'or "incomplete" if the trace shows a required outcome was skipped, blocked, failed, or only partially delivered, including waiting items you could not act on. ' +
  IDLE_OUTCOME_GUIDANCE + ' For idle, artifacts must be []; exclude routine bookkeeping and pre-existing outputs. ' +
  'Emit ONLY that tool call: do not redo any work, and do not repeat, extend, or rewrite the report you already wrote.';

/**
 * Whether to spend the run's single outcome nudge. True only when the model has
 * genuinely finished its turn (`stop`, a provider-specific clean `other`, a
 * tool-calls finish at or beyond the normal work ceiling, or a successful
 * structured delivery), declared neither verdict, and has not already spent
 * its reserved outcome-only turn. The final verdict is deliberately allowed
 * after the normal work budget: a one-step run may use code_exec once, then
 * needs one constrained turn to read that result and submit its outcome.
 *
 * `outcome: undefined` means the tools were never loaded (hand-built
 * preparations in tests), so there is nothing to observe and nothing to ask for.
 */
export function shouldRequestOutcome(state: {
  outcome: RunOutcome | undefined;
  segmentFinishReason: string | undefined;
  stepCount: number;
  maxSteps: number;
  alreadyAsked: boolean;
  suspended: boolean;
  /** A source or suggestions delivery completed in the preceding segment. */
  structuredDeliveryCompleted: boolean;
}): boolean {
  if (!state.outcome) return false;
  if (state.alreadyAsked || state.suspended) return false;
  if (state.outcome.complete || state.outcome.incomplete) return false;
  const endedAtOrBeyondWorkCeiling = state.segmentFinishReason === 'tool-calls'
    && state.stepCount >= state.maxSteps;
  const endedAfterStructuredDelivery = state.segmentFinishReason === 'tool-calls'
    && state.structuredDeliveryCompleted;
  if (
    state.segmentFinishReason !== 'stop'
    && state.segmentFinishReason !== 'other'
    && !endedAtOrBeyondWorkCeiling
    && !endedAfterStructuredDelivery
  ) return false;
  // The execution loop reserves one constrained outcome-only segment. A
  // parallel tool step can exceed the normal budget before the SDK observes a
  // stop condition, and providers can describe that cutoff as `stop` or
  // `other`; both still need the same final verdict turn.
  return true;
}

export type RunResultDisposition =
  | { kind: 'completed'; success: true; status: 'completed'; exitCode: 0 }
  | { kind: 'suspended'; success: true; status: 'suspended'; exitCode: 0 }
  | {
      kind: 'incomplete';
      success: false;
      status: 'incomplete';
      exitCode: 1;
      error: { code: 'INCOMPLETE'; message: string };
    };

/**
 * One mapping for every external surface. An incomplete verdict is a clean
 * runtime finish but a failed product outcome: persistence, JSON/IPC/API,
 * telemetry, notifications, and the process exit code must all say failure.
 * An idle verdict is a success; it travels as `result.idle`, not a status.
 *
 * Complete and incomplete verdicts write one shared slot, so an agent
 * can set both (it usually learned late that a "done" run was actually
 * blocked). Incomplete is checked FIRST and wins unconditionally: a run that
 * hit a real blocker is not complete, whichever call landed last.
 */
export function classifyRunResult(
  result: Pick<RunAgentResult, 'status' | 'incomplete'>
): RunResultDisposition {
  if (result.incomplete) {
    return {
      kind: 'incomplete',
      success: false,
      status: 'incomplete',
      exitCode: 1,
      error: { code: 'INCOMPLETE', message: result.incomplete.reason },
    };
  }
  if (result.status === 'suspended') {
    return { kind: 'suspended', success: true, status: 'suspended', exitCode: 0 };
  }
  return { kind: 'completed', success: true, status: 'completed', exitCode: 0 };
}

export function executionOutcomeFields(
  result: Pick<RunAgentResult, 'status' | 'incomplete'>
): { success: boolean; errorType?: 'incomplete' } {
  const disposition = classifyRunResult(result);
  return disposition.kind === 'incomplete'
    ? { success: false, errorType: 'incomplete' }
    : { success: true };
}

export function runResultJson(result: RunAgentResult, duration: number) {
  const disposition = classifyRunResult(result);
  return {
    success: disposition.success,
    status: disposition.status,
    ...(disposition.kind === 'incomplete' && { error: disposition.error }),
    result: {
      text: result.text || '',
      // Only present on a complete or idle verdict. Consumers that show
      // an outcome before the body (Slack, feed rows, session lists) read this
      // and fall back to `text` when it is absent. Suppressed alongside an
      // incomplete verdict so no payload can pair a failure with a success
      // headline, matching classifyRunResult's precedence.
      ...(result.complete && !result.incomplete && {
        headline: result.complete.headline,
        // Kept when empty: [] is the agent saying it changed nothing.
        ...(result.complete.artifacts && { artifacts: result.complete.artifacts }),
        ...(result.complete.idle && { idle: true as const }),
      }),
      ...(result.agentSource && { agentSource: result.agentSource }),
      ...(result.authoredAgentName && { authoredAgentName: result.authoredAgentName }),
      ...(result.authoredAgentFileName && { authoredAgentFileName: result.authoredAgentFileName }),
      ...(result.authoredAgentLoadedSkills?.length && { authoredAgentLoadedSkills: result.authoredAgentLoadedSkills }),
      ...(result.projectDiscovery && { projectDiscovery: result.projectDiscovery }),
      ...(result.finishReason && { finishReason: result.finishReason }),
      duration,
      ...(result.usage && {
        tokens: {
          input: result.usage.inputTokens || 0,
          output: result.usage.outputTokens || 0,
        },
      }),
      toolCalls: result.toolCallCount || 0,
    },
  };
}

export function workerRunResponse(
  id: string,
  result: RunAgentResult,
  duration: number,
  sessionIdOverride?: string
) {
  const disposition = classifyRunResult(result);
  const wireResult = {
    ...runResultJson(result, duration).result,
    ...(sessionIdOverride
      ? { sessionId: sessionIdOverride }
      : result.sessionId
        ? { sessionId: result.sessionId }
        : {}),
    ...(result.approvalUrl && { approvalUrl: result.approvalUrl }),
  };
  const telemetry = {
    toolCalls: aggregateToolCalls(result.toolCallTraces),
    steps: countSteps(result.toolCallTraces),
  };
  return disposition.kind === 'incomplete'
    ? { id, success: false as const, error: disposition.error, result: wireResult, telemetry }
    : { id, success: true as const, result: wireResult, telemetry };
}
