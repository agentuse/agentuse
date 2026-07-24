import type { RunAgentResult } from './types';

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
 * One mapping for every external surface. `report_incomplete` is a clean
 * runtime finish but a failed product outcome: persistence, JSON/IPC/API,
 * telemetry, notifications, and the process exit code must all say failure.
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
  return disposition.kind === 'incomplete'
    ? { id, success: false as const, error: disposition.error, result: wireResult }
    : { id, success: true as const, result: wireResult };
}
