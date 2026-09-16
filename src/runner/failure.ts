import { ConfigError } from '../parser';
import { AuthenticationError } from '../models';
import { toErrorMessage } from '../utils/error-message';
import { extractApiErrorDetail } from './api-error';
import { ModelStreamStallError, ModelStreamTransportError } from './model-stall';
import type { SessionInfo } from '../session/types';
import type { FailureCause } from '../session/failure-label';

export type ClassifiedFailure = Omit<NonNullable<SessionInfo['error']>, 'time' | 'cause'> & { cause: FailureCause };

/** Explicit run cancellation evidence. Keep AbortError semantics for unwinding. */
export class RunAbortError extends Error {
  constructor(readonly causeCode: 'run_deadline' | 'user_stopped' | 'user_interrupt', message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

export function runDeadline(seconds: number): RunAbortError {
  return new RunAbortError('run_deadline', `Agent execution timed out after ${seconds}s`);
}

/** Classification is diagnostic only. It must not grant permission to retry. */
export function classifyFailure(error: unknown, signal?: AbortSignal): ClassifiedFailure {
  const reason = signal?.aborted ? signal.reason : undefined;
  const explicit = reason instanceof RunAbortError ? reason : error instanceof RunAbortError ? error : undefined;
  if (explicit) {
    return {
      code: explicit.causeCode === 'run_deadline' ? 'TIMEOUT' : explicit.causeCode === 'user_stopped' ? 'USER_STOPPED' : 'USER_INTERRUPT',
      cause: explicit.causeCode,
      message: explicit.message,
    };
  }
  const api = extractApiErrorDetail(error);
  const base = { code: 'EXECUTION_ERROR', message: toErrorMessage(error), ...api };
  // Prefer typed errors over incidental provider details in their cause chain.
  let current = error;
  let aborted = signal?.aborted ?? false;
  const seen = new Set<unknown>();
  for (let depth = 0; current instanceof Error && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof RunAbortError) return classifyFailure(current);
    aborted ||= current.name === 'AbortError';
    if (current instanceof ConfigError) return { ...base, code: 'CONFIG_ERROR', cause: 'configuration' };
    if (current instanceof AuthenticationError) return { ...base, code: 'AUTH_ERROR', cause: 'authentication' };
    if (current instanceof ModelStreamStallError) {
      return { ...base, cause: 'model_stall', phase: current.phase,
        ...(current.attempts !== undefined && { attempts: current.attempts }) };
    }
    if (current instanceof ModelStreamTransportError) {
      return { ...base, cause: 'model_transport',
        ...(current.attempts !== undefined && { attempts: current.attempts }) };
    }
    current = current.cause;
  }
  if (api) {
    let providerType: unknown;
    try {
      const body = JSON.parse(api.detail ?? '{}');
      providerType = body?.error?.type ?? body?.error?.code ?? body?.type;
    } catch { /* Unstructured provider bodies are not classification evidence. */ }
    if (api.statusCode === 401) return { ...base, code: 'AUTH_ERROR', cause: 'authentication' };
    if (api.statusCode === 403) return { ...base, cause: 'provider_permission' };
    if (api.statusCode === 429) return { ...base, cause: 'provider_rate_limit' };
    if (providerType === 'overloaded_error') return { ...base, cause: 'provider_overloaded' };
    if (api.statusCode === 408 || api.statusCode === 504) return { ...base, cause: 'provider_timeout' };
    if (api.statusCode !== undefined && api.statusCode >= 500) return { ...base, cause: 'provider_server' };
    return { ...base, cause: 'provider_request' };
  }
  if (aborted) {
    return { code: 'EXECUTION_ERROR', cause: 'interrupted_unknown', message: 'Execution interrupted; cancellation reason is unknown' };
  }
  return { ...base, cause: 'unknown' };
}
