import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Stateless per-session URL token: HMAC-SHA256(key = AGENTUSE_API_KEY,
 * msg = sessionId), base64url-encoded.
 *
 * This is the "session token" that makes a `/sessions/:id` link clickable
 * without pasting an `Authorization: Bearer` header. It grants both viewing the
 * run log and acting on a pending gate (one token, view + approve). It is
 * unguessable without the api key, scoped to a single session, and identical
 * for viewing and for every gate within that session.
 *
 * On localhost there is no api key, so there is no token to mint and links omit
 * it (the deployment invariant leaves local fully open). Returns '' in that
 * case so callers can `if (token) url.searchParams.set('token', token)`.
 */
export function sessionViewToken(sessionId: string, apiKey: string | undefined): string {
  if (!apiKey) return '';
  return createHmac('sha256', apiKey).update(sessionId).digest('base64url');
}

/**
 * Validate a `?token=` against the expected session token for `sessionId`.
 *
 * - When no api key is configured (local bind) every request is authorized,
 *   matching the deployment invariant that local needs no auth.
 * - Otherwise the provided token must equal `sessionViewToken(sessionId, key)`,
 *   compared with a length-guarded `timingSafeEqual` so a malformed token of
 *   the wrong length returns false instead of throwing.
 */
export function validateSessionToken(
  provided: string | undefined,
  sessionId: string,
  apiKey: string | undefined
): boolean {
  if (!apiKey) return true;
  if (!provided) return false;
  const expected = sessionViewToken(sessionId, apiKey);
  try {
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}
