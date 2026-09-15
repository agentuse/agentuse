/**
 * Paging, log limits and small predicates shared by the session and approval
 * list surfaces, plus the run transcript a manual learning is grounded in.
 * Moved verbatim out of serve.ts.
 */
import { isTerminalSessionStatus } from "../../session/status";

export const LOGGED_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export function shouldLogApprovalRequest(logged: Map<string, number>, key: string, now = Date.now()): boolean {
  for (const [existingKey, loggedAt] of logged) {
    if (now - loggedAt > LOGGED_APPROVAL_REQUEST_TTL_MS) {
      logged.delete(existingKey);
    }
  }
  if (logged.has(key)) return false;
  logged.set(key, now);
  return true;
}

export { buildRunTranscript } from '../../session/run-transcript';

/** Every filter captured by the first SSE subscriber must partition the hub. */
export function sessionListStreamKey(requestUrl: URL): string {
  return [
    'sessions',
    requestUrl.searchParams.get('window') ?? '',
    requestUrl.searchParams.get('days') ?? '',
    requestUrl.searchParams.get('hours') ?? '',
    requestUrl.searchParams.get('status') ?? '',
    requestUrl.searchParams.get('triage') ?? '',
    requestUrl.searchParams.get('trigger') ?? '',
    requestUrl.searchParams.get('agent') ?? '',
    requestUrl.searchParams.get('approval') ?? '',
    requestUrl.searchParams.get('q') ?? '',
    requestUrl.searchParams.get('mock') ?? '',
    requestUrl.searchParams.get('metric') ?? '',
    requestUrl.searchParams.get('results') ?? '',
    requestUrl.searchParams.get('detail') ?? '',
    requestUrl.searchParams.get('limit') ?? '',
    requestUrl.searchParams.get('cursor') ?? '',
  ].join(':');
}

export const LIST_PAGE_DEFAULT_LIMIT = 50;

export const LIST_PAGE_MAX_LIMIT = 100;

export const SESSION_LOG_DEFAULT_LIMIT = 400;

export const SESSION_LOG_MAX_LIMIT = 5_000;

export function sessionLogLimit(requestUrl: URL): number {
  const parsed = Number(requestUrl.searchParams.get('logsLimit'));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), SESSION_LOG_MAX_LIMIT)
    : SESSION_LOG_DEFAULT_LIMIT;
}

export type CursorPage<T> = { items: T[]; nextCursor?: string; limit?: number };

/**
 * Cursor pagination is deliberately opt-in: integrations which omit `limit`
 * keep receiving the historical complete arrays. Cursors carry the complete
 * sort key plus a filter fingerprint, preventing a cursor for one filtered
 * view from silently skipping rows in another.
 */
export function cursorPage<T>(
  requestUrl: URL,
  fingerprint: string,
  rows: T[],
  key: (row: T) => string
): CursorPage<T> {
  const rawLimit = requestUrl.searchParams.get('limit');
  if (rawLimit === null) return { items: rows };
  const parsed = Number(rawLimit);
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), LIST_PAGE_MAX_LIMIT)
    : LIST_PAGE_DEFAULT_LIMIT;
  const rawCursor = requestUrl.searchParams.get('cursor');
  let start = 0;
  if (rawCursor) {
    try {
      const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as { f?: string; k?: string };
      if (decoded.f !== fingerprint || typeof decoded.k !== 'string') throw new Error('mismatched cursor');
      const index = rows.findIndex((row) => key(row) === decoded.k);
      if (index < 0) throw new Error('cursor row no longer exists');
      start = index + 1;
    } catch {
      // A stale cursor is safe to restart from the current first page. This is
      // friendlier than failing a dashboard reload after retention cleanup.
      start = 0;
    }
  }
  const items = rows.slice(start, start + limit);
  const last = items.at(-1);
  const nextCursor = last && start + items.length < rows.length
    ? Buffer.from(JSON.stringify({ f: fingerprint, k: key(last) })).toString('base64url')
    : undefined;
  return { items, ...(nextCursor && { nextCursor }), limit };
}

export function isEndedSessionStatus(status: string | undefined): boolean {
  return isTerminalSessionStatus(status);
}

/**
 * Whose learnings a session view shows: always THIS session's agent, never the
 * cascade's origin agent.
 *
 * A manager parked on a delegated child ran under its own learnings. They are
 * what the log's "N of M applied" badge counts, and the page is titled with that
 * agent, so they are the rules a reviewer is judging the run against. Reading
 * the leaf's store instead showed nothing at all whenever the leaf had not
 * captured anything yet, which hid the manager's own over-cap warning on the one
 * page where it changes a decision.
 *
 * A `remember` correction left at the gate still belongs to `originAgent`: that
 * note is about the draft on screen, so it goes to whoever wrote it. The two
 * deliberately differ, and the panel names the agent it is showing.
 */
export function sessionLearningTargetAgent<T>(approval: { agent: T; originAgent?: T }): T {
  return approval.agent;
}
