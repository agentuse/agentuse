import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { runAgentDetached } from '../lib/api';
import type { RunCustomization } from '../components/run-custom-dialog';

/**
 * Starts a detached run (optionally with a one-off instruction appended to the
 * agent's prompt and/or a different model) and navigates to its live session
 * view. Shared by the agents list (inline Run + "Run with custom…"), the agent
 * detail hub and the session view's ⋯ menu.
 *
 * The run endpoint pre-assigns the session id and returns it before the run
 * produces anything, so the redirect can carry it (plus a view token on
 * token-gated daemons) and the session page streams the run as it happens.
 */
export function useRunAgent(agentPath: string, projectId: string | undefined) {
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (custom?: RunCustomization) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await runAgentDetached(agentPath, projectId, custom);
      const params = new URLSearchParams({ pending: '1' });
      if (projectId) params.set('project', projectId);
      if (res.token) params.set('token', res.token);
      location.route(`/sessions/${encodeURIComponent(res.sessionId)}?${params.toString()}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return { run, busy, error };
}
