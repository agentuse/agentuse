import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiRequestError } from '../lib/api';

export interface FetchState<T> {
  data: T | null;
  error: ApiRequestError | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Fetches `fn` whenever `key` changes. Optional `refreshMs` re-fetches on an
 * interval and on tab visibility changes (the SPA replacement for the old
 * meta-refresh). Stale responses from superseded keys are dropped.
 */
export function useFetch<T>(
  key: string,
  fn: () => Promise<T>,
  options: { refreshMs?: number; enabled?: boolean } = {}
): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enabled = options.enabled !== false;

  const load = useCallback(async (showLoading: boolean) => {
    const id = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const result = await fnRef.current();
      if (generation.current !== id) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (generation.current !== id) return;
      setError(err instanceof ApiRequestError ? err : new ApiRequestError(0, 'NETWORK', (err as Error).message));
    } finally {
      if (generation.current === id) setLoading(false);
    }
  }, []);

  // Guard against duplicate initial fetches when the router re-runs the
  // mount effect for the same key (lazy-route resolution can render twice).
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (loadedKeyRef.current === key) return;
    // A key change means a different resource (e.g. navigating between two
    // agent-detail pages that reuse the mounted route component). Drop the
    // previous key's data so consumers show their loading state instead of
    // the stale resource under it.
    if (loadedKeyRef.current !== null) {
      setData(null);
      setError(null);
    }
    loadedKeyRef.current = key;
    void load(true);
  }, [key, enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const refreshMs = options.refreshMs;
    if (!refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, refreshMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, enabled, options.refreshMs, load]);

  const refetch = useCallback(() => void load(false), [load]);
  return { data, error, loading, refetch };
}
