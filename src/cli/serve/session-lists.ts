/**
 * Paging, log limits and small predicates shared by the session and approval
 * list surfaces, plus the run transcript a manual learning is grounded in.
 * Moved verbatim out of serve.ts.
 */
import { isTerminalSessionStatus } from "../../session/status";
import { ApprovalLogEntry } from "./session-log";

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

// Compact transcript of what the agent did in a run — its text output, tool
// calls (name + truncated input/output), and any reviewed draft — pulled from
// the session log the daemon already holds in-process. Used to ground a manual
// instruction in the run the reviewer was looking at.
export function buildRunTranscript(
  logs: ApprovalLogEntry[] | undefined,
  maxChars = 6000,
  options: {
    focus?: 'earliest' | 'latest' | 'latest-attempt';
    terminal?: { status?: string; errorCode?: string; errorMessage?: string };
  } = {},
): string {
  const clip = (s: string | undefined, n: number): string => {
    if (!s) return '';
    const t = s.trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const blocks: string[] = [];
  const allLogs = logs ?? [];
  let latestContinuationIndex = -1;
  if (options.focus === 'latest-attempt') {
    for (let index = allLogs.length - 1; index >= 0; index -= 1) {
      const entry = allLogs[index]!;
      if (entry.type === 'text' && entry.title === 'User response') {
        latestContinuationIndex = index;
        break;
      }
    }
  }
  const scopedLogs = latestContinuationIndex >= 0 ? allLogs.slice(latestContinuationIndex) : allLogs;
  if (options.focus === 'latest-attempt') {
    blocks.push(latestContinuationIndex >= 0
      ? 'Transcript scope: latest execution attempt after the most recent user continuation.'
      : 'Transcript scope: latest execution attempt.');
  }
  for (const e of scopedLogs) {
    if (e.type === 'text' && e.message?.trim()) {
      const label = e.title === 'User response' ? 'User continuation' : 'Agent output';
      blocks.push(`${label}:\n${clip(e.message, 4000)}`);
    } else if (e.type === 'tool') {
      const io = [
        e.details?.input ? `input ${clip(e.details.input, 300)}` : '',
        e.details?.output ? `output ${clip(e.details.output, 500)}` : '',
        e.details?.errorMessage ? `error ${clip(e.details.errorMessage, 500)}` : '',
        !e.details && e.status === 'error' && e.message ? `error ${clip(e.message, 500)}` : '',
      ].filter(Boolean).join(' → ');
      blocks.push(`Tool ${e.tool ?? e.title}${io ? `: ${io}` : ''}`);
    } else if (e.type === 'error' || (e.type === 'log' && e.level === 'error')) {
      blocks.push(`Error ${e.title}${e.message?.trim() ? `:\n${clip(e.message, 1000)}` : ''}`);
    } else if (e.details?.draft?.trim()) {
      blocks.push(`Reviewed work:\n${clip(e.details.draft, 1500)}`);
    }
  }

  const terminal = options.terminal;
  if (terminal?.status === 'error' && terminal.errorMessage) {
    const code = terminal.errorCode ? ` (${terminal.errorCode})` : '';
    blocks.push(`Current terminal error${code}:\n${clip(terminal.errorMessage, 4000)}`);
  }

  const out = blocks.join('\n\n');
  if (out.length <= maxChars) return out;
  if (options.focus !== 'latest' && options.focus !== 'latest-attempt') {
    return out.slice(0, maxChars) + '\n…(truncated)';
  }

  const marker = '…(earlier activity omitted; showing the latest session activity)';
  const budget = Math.max(0, maxChars - marker.length - 2);
  const selected: string[] = [];
  let selectedLength = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const separatorLength = selected.length > 0 ? 2 : 0;
    if (selectedLength + separatorLength + block.length > budget) continue;
    selected.unshift(block);
    selectedLength += separatorLength + block.length;
  }
  return `${marker}\n\n${selected.join('\n\n')}`;
}

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
