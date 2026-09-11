import { resolve } from 'path';
import type { SessionInfo, ToolPart } from '../session';
import type { WorkerContext } from './context.js';
import type { ApprovalInfoResponse } from './approval.js';
import type { ExecuteRequest } from './types.js';

export type { ApprovalInfoResponse };

export const approvalPartCache = new Map<string, {
  updatedAt: number;
  part: ToolPart | null;
  round: number;
}>();
export const APPROVAL_INFO_CACHE_TTL_MS = 10_000;
// Non-terminal (running/suspended) responses are reused while their change
// signature is unchanged; this ceiling bounds staleness from inputs the
// signature can't observe (e.g. the agent file's learning config).
export const APPROVAL_INFO_SIGNATURE_MAX_AGE_MS = 60_000;
export const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
// While an execution is in flight the on-disk lists are actively changing
// (session created, status flips, approvals suspend). The invalidate at
// execute start can race the first session write: a scan landing in that gap
// would otherwise cache a "nothing running" list for the whole run, so live
// dashboards never see the session until it ends. Cap staleness hard here.
export const LIST_CACHE_ACTIVE_TTL_MS = 1_000;
// A list that claims something is running is a promise the daemon can't keep
// on its own: runs started by another process (a plain `agentuse run`) finish
// without touching any of our invalidation hooks, so a full-TTL entry would
// keep showing a live dot long after the run ended. Bound those the same way,
// whoever started them — the backstop for announcements that never arrive
// because the run was killed.
export const LIST_CACHE_LIVE_TTL_MS = 2_000;
// How long a start poke keeps a project "hot". Invalidating on the poke alone
// isn't enough: the poke races the session write, so the very next scan can
// still see nothing running and cache that emptiness for the full TTL. This
// is the out-of-process twin of activeExecuteRequests — for the daemon's own
// runs that counter stays raised for the whole run; here we only get an edge,
// so hold the short TTL for a window after it.
export const EXTERNAL_ACTIVITY_WINDOW_MS = 15_000;
/** projectRoot -> timestamp until which external activity is assumed. */
export const externalActivityUntil = new Map<string, number>();
export type ApprovalInfoCacheEntry = {
  expiresAt: number;
  response?: Omit<ApprovalInfoResponse, 'id'>;
  promise?: Promise<ApprovalInfoResponse>;
  /** Change signature the response was computed against (non-terminal sessions only). */
  signature?: string;
};
export type ListResponse = { id: string; success: boolean; [key: string]: unknown };
export type ListCacheEntry<T extends ListResponse> = {
  expiresAt: number;
  response?: Omit<T, 'id'>;
  promise?: Promise<T>;
};
export const approvalInfoResponseCache = new Map<string, ApprovalInfoCacheEntry>();
export const listResponseCache = new Map<string, ListCacheEntry<ListResponse>>();
// These three hold whole responses -- an approval-info entry carries the
// session's entire built transcript -- and their TTLs are lazy: an expired
// entry is only dropped when that same key is read again. A dashboard that
// browses many sessions would otherwise leave every one of them resident for
// the worker's lifetime, so cap the entry count too. Sized for the live views
// a daemon actually serves; older entries just re-read from storage.
export const MAX_CACHED_APPROVAL_INFO = 8;
export const MAX_CACHED_LISTS = 16;
export const MAX_CACHED_APPROVAL_PARTS = 256;

/** Set an entry, evicting least-recently-set keys past `max`. */
export function boundedCacheSet<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  // Re-insert so the most recently used entry sorts last for eviction.
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
export function approvalPartCacheKey(projectRoot: string, session: SessionInfo, agentId: string): string {
  return `${projectRoot}\0${session.id}\0${agentId}`;
}

export function approvalInfoCacheKey(req: ExecuteRequest): string {
  return [
    'approval-info',
    req.projectRoot,
    req.sessionId ?? '',
    req.resumeToken ?? '',
    req.allowHistorical ? 'historical' : 'latest',
    req.skipTokenCheck ? 'trusted' : 'token'
  ].join('\0');
}

export function listCacheKey(req: ExecuteRequest, kind: 'approvals' | 'sessions'): string {
  return [
    kind,
    req.projectRoot,
    req.approvalCreatedAfter ?? '',
    req.sessionsUpdatedAfter ?? '',
    req.includeSubagents ? 'subagents' : 'top',
    req.sessionsLimit ?? '',
    req.sessionsPerAgent ?? '',
    req.sessionsMock ?? ''
  ].join('\0');
}

export function invalidateListCaches(projectRoot?: string): void {
  approvalPartCache.clear();
  if (!projectRoot) {
    approvalInfoResponseCache.clear();
    listResponseCache.clear();
    return;
  }
  for (const key of [...approvalInfoResponseCache.keys()]) {
    if (key.includes(`\0${projectRoot}\0`)) approvalInfoResponseCache.delete(key);
  }
  for (const key of [...listResponseCache.keys()]) {
    if (key.includes(`\0${projectRoot}\0`)) listResponseCache.delete(key);
  }
}

export function shouldCacheApprovalInfoResponse(
  response: ApprovalInfoResponse
): response is ApprovalInfoResponse & { success: true; approval: { sessionStatus: string } } {
  if (!response.success || !response.approval) return false;
  const status = response.approval.sessionStatus;
  return status === 'completed' || status === 'error';
}

export async function withApprovalInfoCache(
  key: string,
  requestId: string,
  loader: () => Promise<ApprovalInfoResponse>,
  getSignature?: () => Promise<string | null>
): Promise<ApprovalInfoResponse> {
  const now = Date.now();
  const cached = approvalInfoResponseCache.get(key);
  if (cached?.response && cached.expiresAt > now && !cached.signature) {
    return { ...cached.response, id: requestId } as ApprovalInfoResponse;
  }

  // Probe before any rebuild: a write that lands mid-rebuild bumps a
  // directory mtime past this signature, so the next poll re-reads instead
  // of reusing a torn snapshot.
  const signature = getSignature ? await getSignature() : null;
  if (
    cached?.response && cached.expiresAt > now &&
    cached.signature && signature !== null && signature === cached.signature
  ) {
    return { ...cached.response, id: requestId } as ApprovalInfoResponse;
  }
  if (cached?.promise) {
    const response = await cached.promise;
    return { ...response, id: requestId } as ApprovalInfoResponse;
  }

  const promise = loader();
  boundedCacheSet(
    approvalInfoResponseCache,
    key,
    { expiresAt: now + APPROVAL_INFO_CACHE_TTL_MS, promise },
    MAX_CACHED_APPROVAL_INFO
  );
  try {
    const response = await promise;
    const { id: _id, ...rest } = response;
    if (shouldCacheApprovalInfoResponse(response)) {
      boundedCacheSet(approvalInfoResponseCache, key, {
        expiresAt: Date.now() + APPROVAL_INFO_CACHE_TTL_MS,
        response: rest as Omit<ApprovalInfoResponse, 'id'>
      }, MAX_CACHED_APPROVAL_INFO);
    } else if (response.success && signature !== null) {
      // Running/suspended sessions: reuse this snapshot until the on-disk
      // state changes. The SSE loop polls at 500ms/10s; without this every
      // tick re-reads and re-serializes the whole transcript.
      boundedCacheSet(approvalInfoResponseCache, key, {
        expiresAt: Date.now() + APPROVAL_INFO_SIGNATURE_MAX_AGE_MS,
        response: rest as Omit<ApprovalInfoResponse, 'id'>,
        signature
      }, MAX_CACHED_APPROVAL_INFO);
    } else {
      approvalInfoResponseCache.delete(key);
    }
    return response;
  } catch (error) {
    approvalInfoResponseCache.delete(key);
    throw error;
  }
}

/** Is a project this cache key belongs to inside its post-poke activity window? */
export function externallyActive(cacheKey: string): boolean {
  if (externalActivityUntil.size === 0) return false;
  const now = Date.now();
  for (const [projectRoot, until] of externalActivityUntil) {
    if (until <= now) {
      externalActivityUntil.delete(projectRoot);
      continue;
    }
    if (cacheKey.includes(`\0${projectRoot}\0`)) return true;
  }
  return false;
}

/** Does this list payload assert that something is live right now? Mirrors the
 *  web client's isRunningStatus so the cache and the UI agree on "live". */
export function containsLiveRow(response: ListResponse): boolean {
  const rows = response.sessions;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    if (typeof row !== 'object' || row === null) return false;
    const { status, subagentActive } = row as { status?: unknown; subagentActive?: unknown };
    return subagentActive === true
      || status === 'preparing' || status === 'running' || status === 'resuming' || status === 'continuing';
  });
}

export async function withListCache<T extends ListResponse>(
  ctx: WorkerContext,
  key: string,
  requestId: string,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const cached = listResponseCache.get(key) as ListCacheEntry<T> | undefined;
  if (cached?.response && cached.expiresAt > now) {
    return { ...cached.response, id: requestId } as T;
  }
  if (cached?.promise) {
    const response = await cached.promise;
    return { ...response, id: requestId };
  }

  const promise = loader();
  boundedCacheSet(
    listResponseCache,
    key,
    { expiresAt: now + LIST_CACHE_TTL_MS, promise } as ListCacheEntry<ListResponse>,
    MAX_CACHED_LISTS
  );
  try {
    const response = await promise;
    if (response.success) {
      const { id: _id, ...rest } = response;
      // While an execution is in flight, this scan may have raced a session
      // write; cap how long it can be served so live views track the run.
      const ttlMs = ctx.activeExecuteRequests > 0 || externallyActive(key)
        ? LIST_CACHE_ACTIVE_TTL_MS
        : containsLiveRow(response) ? LIST_CACHE_LIVE_TTL_MS : LIST_CACHE_TTL_MS;
      boundedCacheSet(listResponseCache, key, {
        expiresAt: Date.now() + ttlMs,
        response: rest as Omit<T, 'id'>
      } as ListCacheEntry<ListResponse>, MAX_CACHED_LISTS);
    } else {
      listResponseCache.delete(key);
    }
    return response;
  } catch (error) {
    listResponseCache.delete(key);
    throw error;
  }
}

// Several served projects can share one session store: storage is keyed by
// git root, so multiple -C project dirs inside the same repository all land in
// the same store. Attribute a session to a project only when its recorded
// project.root matches the requesting project; records from older versions
// without the field stay visible to every project (previous behavior).
export function sessionBelongsToProject(session: Pick<SessionInfo, 'project'> | { projectRoot?: string }, projectRoot: string): boolean {
  const recordedRoot = 'projectRoot' in session
    ? session.projectRoot
    : (session as Pick<SessionInfo, 'project'>).project?.root;
  if (!recordedRoot) return true;
  return resolve(recordedRoot) === resolve(projectRoot);
}
