import { randomBytes, timingSafeEqual } from 'node:crypto';

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
 * Cloud reaches this daemon's `/api/*` and nothing else: pages, assets,
 * `/mcp` (which has its own frame), its OAuth callback and the root-path
 * session routes kept for old links are not relayed.
 */
export function isRelayablePath(pathname: string): boolean {
  if (pathname.includes('/../') || pathname.endsWith('/..')) return false;
  return pathname === '/api' || pathname.startsWith('/api/');
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
 * The requests that change something on this computer: approval decisions,
 * steering a run, and starting one by hand. The access log marks them with
 * this name; reads and settings return undefined.
 */
export function relayedActionName(method: string | undefined, pathname: string): string | undefined {
  if (method !== 'POST') return undefined;
  if (pathname === '/api/run' || pathname === '/api/onboarding/run') return 'run';
  const session = pathname.match(/^\/api\/(?:sessions|approvals)\/[^/]+\/(decision|continue|resume|stop|reopen)$/);
  if (session) return session[1];
  if (/^\/api\/agent-revisions\/[^/]+\/test-run$/.test(pathname)) return 'test-run';
  return undefined;
}

/** The session id a relayed action path names, if any. */
export function relayedSessionId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/(?:sessions|approvals|agent-revisions)\/([^/]+)\//);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}
