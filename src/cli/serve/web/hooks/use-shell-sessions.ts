import { useCallback, useEffect, useState } from 'preact/hooks';
import { fetchSessions, type SessionRow } from '../lib/api';
import { isRunningStatus } from '../lib/format';
import { useSessionsStream } from './use-sessions-stream';

/** How many rows the shell asks for. Enough to fill the recent list after
 *  in-flight runs are pulled to the top, small enough to stay cheap. */
const SHELL_SESSION_LIMIT = 12;
const SHELL_RECENT_COUNT = 5;
const FALLBACK_POLL_MS = 20_000;

export interface ShellSessions {
  running: number;
  recent: SessionRow[];
}

const EMPTY: ShellSessions = { running: 0, recent: [] };

export function shellSessionsFromRows(rows: readonly SessionRow[]): ShellSessions {
  const visible = rows.filter((row) => !row.mock);
  const running = visible.filter((row) => isRunningStatus(row.status));
  const rest = visible.filter((row) => !isRunningStatus(row.status));
  const byRecency = (a: SessionRow, b: SessionRow) => b.updatedAt - a.updatedAt;
  const ordered = [...running.sort(byRecency), ...rest.sort(byRecency)];
  return { running: running.length, recent: ordered.slice(0, SHELL_RECENT_COUNT) };
}

/**
 * One small session snapshot for the app shell: how many runs are in flight
 * right now, plus the handful of sessions worth one-click access. Shares the
 * same SSE endpoint as the sessions list and degrades to polling.
 */
export function useShellSessions(enabled: boolean): ShellSessions {
  const [sessions, setSessions] = useState<ShellSessions>(EMPTY);
  const [fallback, setFallback] = useState(false);

  const accept = useCallback((rows: readonly SessionRow[]) => {
    setSessions(shellSessionsFromRows(rows));
  }, []);

  useSessionsStream({
    agent: undefined,
    status: undefined,
    triage: undefined,
    trigger: undefined,
    approval: undefined,
    window: undefined,
    limit: SHELL_SESSION_LIMIT,
    enabled: enabled && !fallback,
    onData: (payload) => accept(payload.sessions),
    onError: () => {},
    onFallback: () => setFallback(true),
  });

  useEffect(() => {
    if (!enabled || !fallback) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const payload = await fetchSessions({ limit: SHELL_SESSION_LIMIT });
        if (!cancelled) accept(payload.sessions);
      } catch {
        // The shell nav is decorative here; the sessions page reports failures.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, fallback, accept]);

  return enabled ? sessions : EMPTY;
}
