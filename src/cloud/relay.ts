import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * What a dashboard request relayed from AgentUse Cloud may reach on this
 * daemon, and who sent it.
 *
 * Cloud signs the person in and names them in `X-AgentUse-User` and
 * `X-AgentUse-Role`. Those headers are believed only on requests that also
 * carry this process's relay secret, which only the tunnel in this same
 * process knows. Anything else is treated exactly as before: whoever holds
 * the API key (or anyone, on a keyless local daemon) is the owner.
 */

export const RELAY_SECRET_HEADER = 'x-agentuse-relay';
const USER_HEADER = 'x-agentuse-user';
const ROLE_HEADER = 'x-agentuse-role';

let secret: string | undefined;

/** A random secret for this process, made on first use. */
export function relaySecret(): string {
  secret ??= randomBytes(32).toString('base64url');
  return secret;
}

function isRelaySecret(value: string | undefined): boolean {
  if (!value || !secret) return false;
  const expected = Buffer.from(secret);
  const provided = Buffer.from(value);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Roles this daemon knows how to enforce. Cloud only sends `owner` today. */
export const KNOWN_RELAY_ROLES = ['owner'] as const;

export interface RequestActor {
  /** Cloud account id of the person, when the request came through Cloud. */
  user?: string;
  /** As Cloud sent it. Serve refuses a relayed request whose role it does not know. */
  role: string;
  via: 'cloud' | 'local';
}

type HeaderBag = Record<string, string | string[] | undefined>;

const header = (headers: HeaderBag, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Who made this request. A relayed request names its Cloud user and role;
 * anything else is the owner, as it always was.
 */
export function requestActor(headers: HeaderBag): RequestActor {
  if (!isRelaySecret(header(headers, RELAY_SECRET_HEADER))) return { role: 'owner', via: 'local' };
  const user = header(headers, USER_HEADER)?.trim().slice(0, 200);
  const role = header(headers, ROLE_HEADER)?.trim() || 'owner';
  return { ...(user && { user }), role, via: 'cloud' };
}

/** A role a newer Cloud may send that this daemon cannot enforce yet must not fall back to owner. */
export const isKnownRelayRole = (role: string): boolean => (KNOWN_RELAY_ROLES as readonly string[]).includes(role);

/**
 * Data routes the dashboard calls. `/api/*` is the main surface; the session,
 * approval and revision routes below are JSON twins that predate it and that
 * the web app still calls by their root paths. Pages, assets, `/mcp` (which
 * has its own frame) and its OAuth callback are not relayed.
 */
const RELAYABLE_ROOT_ROUTES: RegExp[] = [
  /^\/sessions\/events$/,
  /^\/sessions\/[^/]+\/(?:status|decision|continue|resume|stop|reviewed|reopen|events|revisions|learnings|learnings\/[^/]+\/discard|artifacts-list|artifacts\/.+|tool-artifacts\/.+|context|context-stack)$/,
  /^\/approvals\/[^/]+\/(?:status|decision|continue)$/,
  /^\/agent-revisions\/[^/]+(?:\/[^/]+)?$/,
];

export function isRelayablePath(pathname: string): boolean {
  if (pathname.includes('/../') || pathname.endsWith('/..')) return false;
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  return RELAYABLE_ROOT_ROUTES.some((route) => route.test(pathname));
}

/**
 * A link's dashboard path, the same on this daemon and on Cloud: the path,
 * query and hash of an absolute link, without its origin.
 */
export function dashboardPath(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

/**
 * The relayed actions worth a record of who did them: approval decisions,
 * steering a run, and starting one by hand. Returns the action's name, or
 * undefined for everything else (reads, settings).
 */
export function relayedActionName(method: string | undefined, pathname: string): string | undefined {
  if (method !== 'POST') return undefined;
  if (pathname === '/api/run' || pathname === '/api/onboarding/run') return 'run';
  const session = pathname.match(/^\/(?:sessions|approvals)\/[^/]+\/(decision|continue|resume|stop|reopen)$/);
  if (session) return session[1];
  if (/^\/agent-revisions\/[^/]+\/test-run$/.test(pathname)) return 'test-run';
  return undefined;
}

/** The session id a relayed action path names, if any. */
export function relayedSessionId(pathname: string): string | undefined {
  const match = pathname.match(/^\/(?:sessions|approvals|agent-revisions)\/([^/]+)\//);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

export interface RelayAuditEntry {
  at: string;
  user?: string;
  role: string;
  action: string;
  sessionId?: string;
  project?: string;
  status: number;
}

/**
 * One line per relayed action, so "who approved this from the dashboard" has
 * an answer. Best effort: a full disk must not fail the action itself.
 */
export function appendRelayAudit(file: string, entry: RelayAuditEntry): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Recording is secondary to the action.
  }
}
