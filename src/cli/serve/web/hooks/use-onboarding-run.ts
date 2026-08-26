import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { runOnboardingDetached } from '../lib/api';

/** Launch the in-memory guide and move straight into its live session. */
export function useOnboardingRun(projectId: string | undefined) {
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runOnboardingDetached(projectId);
      const params = new URLSearchParams({ pending: '1' });
      if (projectId) params.set('project', projectId);
      if (result.token) params.set('token', result.token);
      location.route(`/sessions/${encodeURIComponent(result.sessionId)}?${params.toString()}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return { run, busy, error };
}
