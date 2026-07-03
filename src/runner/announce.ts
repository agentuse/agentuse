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
  if (!options.sessionId || typeof fetch !== 'function') return;
  try {
    const sessionUrl = getSessionUrl(options.sessionId, options.projectRoot);
    if (!sessionUrl) return;
    const url = new URL(sessionUrl);
    const token = url.searchParams.get('token');
    url.pathname = `/sessions/${encodeURIComponent(options.sessionId)}/finished`;
    url.search = '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        status: options.status,
        ...(token && { token }),
        ...(options.agentName && { agentName: options.agentName }),
      }),
    });
    clearTimeout(timeout);
  } catch {
    // Best-effort by design; see above.
  }
}
