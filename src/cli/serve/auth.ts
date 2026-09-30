/**
 * Who may reach which serve route.
 *
 * The API-key header gate, the per-session capability gate, and the two route
 * classifiers that decide which paths are exempt from the header gate. Moved
 * verbatim out of serve.ts so every route module goes through the same checks.
 */
import { validateSessionToken } from "../../utils/session-token";
import { timingSafeEqual } from "crypto";
import { IncomingMessage } from "http";

/**
 * Whether a request bypasses the global `Authorization: Bearer` header gate.
 *
 * Exempt: any `/approvals/*` route (legacy, token-authenticated) and, only on
 * the non-API surface, the unified session page `/sessions/:id`, its action
 * subroutes `/sessions/:id/{decision,continue,status,stop,started,finished,
 * reopen,learnings}`, the artifact
 * listing `/sessions/:id/artifacts-list`, and artifact
 * viewer subpaths `/sessions/:id/{artifacts,tool-artifacts}/*`. These carry their own capability
 * auth (session token / api key / local); the artifact handler validates the
 * `?token=` session token via `sessionAuthorized` before serving any file.
 *
 * NOT exempt (stays header-gated): `/sessions` (the list page), and every
 * `/api/*` route including `/api/sessions` and `/api/sessions/:id`. The `isApi`
 * qualifier on the session branch is the security boundary that keeps the JSON
 * session endpoints authenticated on an exposed host.
 */
export function isHeaderGateExemptRoute(routePath: string, isApi: boolean): boolean {
  const legacyApprovalRoute = routePath.match(/^\/approvals\/([^/?#]+)(?:\/(requested|status|decision|continue))?$/);
  if (legacyApprovalRoute && legacyApprovalRoute[1] !== 'events') return true;
  if (isApi) return false;
  if (routePath === '/sessions/events') return false;
  return /^\/sessions\/[^/?#]+(?:\/(?:decision|continue|resume|status|stop|started|finished|reopen|events|learnings|learnings\/[^/?#]+\/discard|artifacts-list|artifacts\/.+|tool-artifacts\/.+|context|context-stack))?$/.test(routePath);
}

/**
 * GET routes that render a browser page and therefore serve the SPA shell
 * (the client routes by URL and fetches its own data). Mirrors the set of
 * server-rendered pages: home, agents (+single-project view), schedules,
 * stores (+item/detail), sessions, the approvals list, and the client-local
 * settings page. The single-project
 * route `/agents/:project` is one segment; the detail hub `/agents/:project/:agent*`
 * is two or more. `/approvals/:id` is excluded so it keeps
 * 302-redirecting; `/sessions/:id` is excluded too because it needs a dedicated
 * branch that converts a legacy gate token into a session-view token before
 * serving the shell (see sessionPageMatch).
 */
export function isSpaPageRoute(routePath: string): boolean {
  switch (routePath) {
    case '/':
    case '/onboarding':
    case '/agents':
    case '/schedules':
    case '/stores':
    case '/sessions':
    case '/approvals':
    case '/settings':
    /** The tidy-up progress/result page, addressed by ?project=&path=&job=
     *  rather than by path segments so an agent path containing slashes stays
     *  unambiguous against the `/agents/:project/:agent*` hub. */
    case '/learnings/tidy':
      return true;
  }
  if (/^\/stores\/[^/?#]+(?:\/[^/?#]+)?$/.test(routePath)) return true; // /stores/:s and /stores/:s/:item
  if (/^\/agents\/[^/?#]+$/.test(routePath)) return true; // /agents/:project (single-project view)
  if (/^\/agents\/[^/?#]+\/.+$/.test(routePath)) return true; // /agents/:project/:agent* (detail hub)
  if (/^\/projects\/[^/?#]+\/changesets\/[^/?#]+$/.test(routePath)) return true; // changeset review
  return false;
}

export function isExposedHost(host: string): boolean {
  return host !== "127.0.0.1" && host !== "localhost";
}

export function validateApiKeyHeader(
  authHeader: string | undefined,
  expectedKey: string | undefined
): boolean {
  if (!expectedKey) return true;

  if (!authHeader?.startsWith("Bearer ")) return false;

  const providedKey = authHeader.slice(7);
  if (!providedKey) return false;

  // Constant-time comparison to prevent timing attacks
  try {
    const expected = Buffer.from(expectedKey);
    const provided = Buffer.from(providedKey);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export function validateApiKey(req: IncomingMessage, expectedKey: string | undefined): boolean {
  return validateApiKeyHeader(req.headers.authorization, expectedKey);
}

/**
 * Actions a session link must not reach. A `?token=` link can view a run and
 * decide its gates; only an operator may steer the agent with a new prompt,
 * change its learnings or source, spend tokens on a revision, or walk up to a
 * parent session. True on a keyless (local) daemon, otherwise only with the
 * API key header.
 */
export function isOperatorRequest(
  authorization: string | undefined,
  apiKey: string | undefined,
): boolean {
  return validateApiKeyHeader(authorization, apiKey);
}

export function isSessionCapabilityAuthorized(options: {
  authorization?: string | undefined;
  sessionToken?: string | undefined;
  sessionId: string;
  apiKey?: string | undefined;
}): boolean {
  const { authorization, sessionToken, sessionId, apiKey } = options;
  return !apiKey
    || validateApiKeyHeader(authorization, apiKey)
    || validateSessionToken(sessionToken, sessionId, apiKey);
}
