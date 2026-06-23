import { APICallError, RetryError } from 'ai';

/** Cap on how much provider response body we persist into the session error. */
const MAX_ERROR_DETAIL_CHARS = 4000;
/** Stop unwrapping pathological cause chains. */
const MAX_UNWRAP_DEPTH = 8;

export interface ApiErrorDetail {
  statusCode?: number;
  url?: string;
  detail?: string;
  /** The underlying provider error message, recovered from any retry wrapper. */
  message?: string;
}

/**
 * Find the underlying provider {@link APICallError}, unwrapping the AI SDK
 * {@link RetryError} (whose own message is only "Failed after N attempts. Last
 * error: …") and any `cause` chain. The deepest API error is where the status
 * code and response body live — i.e. the actual reason the provider rejected
 * the call. Without this, a rate-limited or 400'd helper call (mock execution,
 * compaction, judges) collapses to a useless "Error" in the session log.
 */
function findApiCallError(error: unknown, depth = 0): APICallError | undefined {
  if (error == null || depth > MAX_UNWRAP_DEPTH) return undefined;
  if (APICallError.isInstance(error)) return error;
  if (RetryError.isInstance(error)) {
    // Walk attempts newest-first: the last failure is the most representative.
    const attempts = error.errors ?? [];
    for (let i = attempts.length - 1; i >= 0; i--) {
      const found = findApiCallError(attempts[i], depth + 1);
      if (found) return found;
    }
    return findApiCallError(error.lastError, depth + 1);
  }
  if (error instanceof Error && error.cause != null && error.cause !== error) {
    return findApiCallError(error.cause, depth + 1);
  }
  return undefined;
}

/**
 * Extract provider/API-call detail from an error so a generic message like
 * "Bad Request" — or a retry wrapper's "Failed after 3 attempts. Last error:
 * Error" — is actually diagnosable later. Returns undefined for non-API errors.
 * The response body is where the provider says *why* (e.g. an "unsupported
 * parameter" or "rate_limit_error" message), which the bare Error message drops
 * on the floor.
 */
export function extractApiErrorDetail(error: unknown): ApiErrorDetail | undefined {
  const apiError = findApiCallError(error);
  if (!apiError) return undefined;
  const body = apiError.responseBody;
  const detail = typeof body === 'string' && body.length > 0
    ? body.slice(0, MAX_ERROR_DETAIL_CHARS)
    : undefined;
  return {
    ...(typeof apiError.statusCode === 'number' && { statusCode: apiError.statusCode }),
    ...(apiError.url && { url: apiError.url }),
    ...(detail !== undefined && { detail }),
    ...(typeof apiError.message === 'string' && apiError.message.length > 0 && { message: apiError.message }),
  };
}
