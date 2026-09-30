import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Process-wide slot for the key. Not a module variable: the bundle can hold
 * more than one copy of this module (lazily imported chunks), and a copy that
 * found the env var already scrubbed by another copy would see no key and run
 * the daemon unauthenticated.
 */
const API_KEY_SLOT = Symbol.for('agentuse.apiKey');
type ApiKeySlot = { [API_KEY_SLOT]?: { value: string | undefined } };

/**
 * The daemon API key. Read from AGENTUSE_API_KEY, then removed from
 * process.env so no child process inherits it: the bash tool, MCP servers and
 * skill scripts spawn with the parent environment, and an agent that can run
 * `env` must not be able to print the operator credential into a session log
 * that any link holder can read. Checked again on every call so a key loaded
 * later from an env file is also taken and scrubbed.
 */
export function readApiKey(): string | undefined {
  const slot = globalThis as ApiKeySlot;
  const fromEnv = process.env.AGENTUSE_API_KEY;
  if (fromEnv !== undefined) {
    slot[API_KEY_SLOT] = { value: fromEnv || undefined };
    delete process.env.AGENTUSE_API_KEY;
  }
  return slot[API_KEY_SLOT]?.value;
}

/** Env for the serve worker process only, which needs the key to mint session links. */
export function apiKeyWorkerEnv(): NodeJS.ProcessEnv {
  const apiKey = readApiKey();
  return apiKey ? { AGENTUSE_API_KEY: apiKey } : {};
}

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
