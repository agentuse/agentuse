import { withoutToolIntent } from './tool-intent';

export interface ToolRecoveryCandidate {
  callId: string;
  tool: string;
  status: string;
  input?: unknown;
  /** Model-declared target from the runtime-owned `recovers` input field. */
  recoversCallId?: string;
}

export interface ToolRecoveryTarget {
  failedCallId: string;
  inferred: boolean;
}

export interface ToolRecoverySuccess {
  recoveryCallId: string;
  inferred: boolean;
}

export interface ToolRecoveryLinks {
  /** Valid recovery attempts, including attempts that are still running or failed. */
  recoveryTargetByCallId: Map<string, ToolRecoveryTarget>;
  /** Failed calls with a later successful recovery. */
  recoveryByFailedCallId: Map<string, ToolRecoverySuccess>;
}

function comparableInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const value = withoutToolIntent(input);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

const RESULT_ID_PATTERN = /\bresult_[0-9A-HJKMNP-TV-Z]{26}_[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** Find durable result ids in ordinary inputs and embedded Code Mode source. */
function resultIds(input: unknown, found = new Set<string>(), seen = new Set<object>()): Set<string> {
  if (typeof input === 'string') {
    for (const match of input.matchAll(RESULT_ID_PATTERN)) found.add(match[0]);
    return found;
  }
  if (!input || typeof input !== 'object' || seen.has(input as object)) return found;
  seen.add(input as object);
  if (Array.isArray(input)) {
    for (const value of input) resultIds(value, found, seen);
  } else {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      resultIds(key, found, seen);
      resultIds(value, found, seen);
    }
  }
  return found;
}

function sharesResultId(left: unknown, right: unknown): boolean {
  const leftIds = resultIds(left);
  if (leftIds.size === 0) return false;
  for (const id of resultIds(right)) {
    if (leftIds.has(id)) return true;
  }
  return false;
}

/**
 * Resolve explicit recovery links and conservative fallbacks.
 *
 * Explicit `recovers` metadata may target any earlier failed call. When the
 * model omits it, an immediately following call that references the same
 * durable result is treated as the next attempt, even across results and
 * code_exec. A later success then confirms the entire contiguous retry chain.
 * The older successful same-tool/corrected-input fallback remains for calls
 * without a durable result id.
 */
export function resolveToolRecoveryLinks(calls: readonly ToolRecoveryCandidate[]): ToolRecoveryLinks {
  const recoveryTargetByCallId = new Map<string, ToolRecoveryTarget>();
  const recoveryByFailedCallId = new Map<string, ToolRecoverySuccess>();
  const earlierFailures = new Map<string, ToolRecoveryCandidate>();
  const callById = new Map<string, ToolRecoveryCandidate>();
  let previous: ToolRecoveryCandidate | undefined;

  for (const call of calls) {
    let target: ToolRecoveryCandidate | undefined;
    let inferred = false;

    if (call.recoversCallId) {
      target = earlierFailures.get(call.recoversCallId);
    } else if (previous?.status === 'error') {
      if (sharesResultId(previous.input, call.input)) {
        target = previous;
        inferred = true;
      } else if (call.status === 'completed' && previous.tool === call.tool) {
        const failedInput = comparableInput(previous.input);
        const correctedInput = comparableInput(call.input);
        if (failedInput !== undefined && correctedInput !== undefined && failedInput !== correctedInput) {
          target = previous;
          inferred = true;
        }
      }
    }

    if (target) {
      recoveryTargetByCallId.set(call.callId, { failedCallId: target.callId, inferred });
      if (call.status === 'completed') {
        let failed: ToolRecoveryCandidate | undefined = target;
        let chainInferred = inferred;
        const visited = new Set<string>();
        while (failed?.status === 'error' && !visited.has(failed.callId)) {
          visited.add(failed.callId);
          if (!recoveryByFailedCallId.has(failed.callId)) {
            recoveryByFailedCallId.set(failed.callId, {
              recoveryCallId: call.callId,
              inferred: chainInferred,
            });
          }
          const previousTarget = recoveryTargetByCallId.get(failed.callId);
          if (!previousTarget) break;
          chainInferred ||= previousTarget.inferred;
          failed = callById.get(previousTarget.failedCallId);
        }
      }
    }

    if (call.status === 'error') earlierFailures.set(call.callId, call);
    callById.set(call.callId, call);
    previous = call;
  }

  return { recoveryTargetByCallId, recoveryByFailedCallId };
}
