import { getSessionUrl } from '../tools/await-human';

/**
 * Tells the serve daemon a run reached a terminal state so it can fan out
 * Web Push notifications. Mirrors announceApprovalRequested in stream.ts:
 * best-effort with a short timeout — a run must never fail (or hang) because
 * the daemon is absent, restarting, or an older build without the endpoint.
 *
 * The session view token minted by getSessionUrl doubles as the capability
 * for the callback: the daemon validates it with the same sessionAuthorized
 * check the session action routes use.
 */
export async function announceSessionFinished(options: {
  sessionId?: string;
  status: 'completed' | 'failed';
  agentName?: string;
  projectRoot?: string;
}): Promise<void> {
  await poke('finished', options.sessionId, options.projectRoot, {
    status: options.status,
    ...(options.agentName && { agentName: options.agentName }),
  });
}

/**
 * Tells the daemon a run just started. Without this a run launched outside the
 * daemon (a plain `agentuse run`) is invisible to dashboards until a cached
 * list happens to expire, because none of the daemon's own invalidation hooks
 * fire for it. Same best-effort contract as the finished poke: a run must never
 * fail or hang because the daemon is absent.
 */
export async function announceSessionStarted(options: {
  sessionId?: string;
  agentName?: string;
  projectRoot?: string;
}): Promise<void> {
  await poke('started', options.sessionId, options.projectRoot, {
    ...(options.agentName && { agentName: options.agentName }),
  });
}

async function poke(
  event: 'started' | 'finished',
  sessionId: string | undefined,
  projectRoot: string | undefined,
  body: Record<string, unknown>
): Promise<void> {
  if (!sessionId || typeof fetch !== 'function') return;
  try {
    const sessionUrl = getSessionUrl(sessionId, projectRoot);
    if (!sessionUrl) return;
    const url = new URL(sessionUrl);
    const token = url.searchParams.get('token');
    url.pathname = `/sessions/${encodeURIComponent(sessionId)}/${event}`;
    url.search = '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ ...body, ...(token && { token }) }),
    });
    clearTimeout(timeout);
  } catch {
    // Best-effort by design; see above.
  }
}
