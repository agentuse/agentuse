import { APICallError } from 'ai';

/** Cap on how much provider response body we persist into the session error. */
const MAX_ERROR_DETAIL_CHARS = 4000;

export interface ApiErrorDetail {
  statusCode?: number;
  url?: string;
  detail?: string;
}

/**
 * Extract provider/API-call detail from an error so a generic message like
 * "Bad Request" is actually diagnosable later. Returns undefined for non-API
 * errors. The response body is where the provider says *why* (e.g. an
 * "unsupported parameter" or "invalid reasoning item" message), which the bare
 * Error message ("Bad Request") drops on the floor.
 */
export function extractApiErrorDetail(error: unknown): ApiErrorDetail | undefined {
  if (!APICallError.isInstance(error)) return undefined;
  const body = error.responseBody;
  const detail = typeof body === 'string' && body.length > 0
    ? body.slice(0, MAX_ERROR_DETAIL_CHARS)
    : undefined;
  return {
    ...(typeof error.statusCode === 'number' && { statusCode: error.statusCode }),
    ...(error.url && { url: error.url }),
    ...(detail !== undefined && { detail }),
  };
}
