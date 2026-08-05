import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { ApiRequestError, fetchApprovals, type ApprovalsListPayload } from '../lib/api';
import { useApprovalsStream } from './use-approvals-stream';

interface GlobalApprovalsState {
  data: ApprovalsListPayload | null;
  error: ApiRequestError | null;
  loading: boolean;
  live: boolean;
}

const EMPTY: GlobalApprovalsState = { data: null, error: null, loading: false, live: false };
const GlobalApprovalsContext = createContext<GlobalApprovalsState>(EMPTY);

/** One operator-wide approval snapshot and SSE connection shared by the shell,
 * Home, and the arrival toast. Capability-scoped session links deliberately do
 * not open this operator-only stream. */
export function GlobalApprovalsProvider(props: { children: ComponentChildren }) {
  const scoped = typeof location !== 'undefined' && new URLSearchParams(location.search).has('token');
  const [data, setData] = useState<ApprovalsListPayload | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [fallback, setFallback] = useState(false);

  useApprovalsStream({
    days: undefined,
    project: undefined,
    enabled: !scoped && !fallback,
    onData: (payload) => {
      setData(payload);
      setError(null);
    },
    onError: setError,
    onFallback: () => setFallback(true),
  });

  useEffect(() => {
    if (scoped || !fallback) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const payload = await fetchApprovals();
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof ApiRequestError
            ? nextError
            : new ApiRequestError(0, 'REQUEST_FAILED', (nextError as Error).message));
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scoped, fallback]);

  return (
    <GlobalApprovalsContext.Provider value={{
      data,
      error,
      loading: !scoped && data === null && error === null,
      live: !scoped && !fallback,
    }}>
      {props.children}
    </GlobalApprovalsContext.Provider>
  );
}

export function useGlobalApprovals(): GlobalApprovalsState {
  return useContext(GlobalApprovalsContext);
}
