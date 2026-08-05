import { useEffect, useRef } from 'preact/hooks';
import { ApiRequestError, sessionsEventUrl, type SessionsPayload } from '../lib/api';

const SSE_FAILURE_WINDOW_MS = 10_000;
const SSE_FAILURES_BEFORE_FALLBACK = 2;

export function useSessionsStream(options: {
  agent: string | undefined;
  status: string | undefined;
  triage: string | undefined;
  trigger: string | undefined;
  approval: string | undefined;
  window: string | undefined;
  limit?: number | undefined;
  detail?: 'feed' | 'agents' | undefined;
  mock?: 'include' | 'only' | undefined;
  enabled: boolean;
  onData: (payload: SessionsPayload) => void;
  onError: (error: ApiRequestError) => void;
  onFallback: () => void;
}): void {
  const handlersRef = useRef({
    onData: options.onData,
    onError: options.onError,
    onFallback: options.onFallback,
  });
  handlersRef.current = {
    onData: options.onData,
    onError: options.onError,
    onFallback: options.onFallback,
  };

  useEffect(() => {
    if (!options.enabled) return;

    let closed = false;
    let errorTimes: number[] = [];
    let source: EventSource | null = null;

    const connect = () => {
      const es = new EventSource(sessionsEventUrl({
        agent: options.agent,
        status: options.status,
        triage: options.triage,
        trigger: options.trigger,
        approval: options.approval,
        window: options.window,
        limit: options.limit,
        detail: options.detail,
        mock: options.mock,
      }));
      source = es;

      es.addEventListener('sessions', (event) => {
        errorTimes = [];
        const payload = JSON.parse((event as MessageEvent).data) as SessionsPayload;
        handlersRef.current.onData(payload);
      });

      es.addEventListener('stream-error', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { code?: string; message?: string };
        handlersRef.current.onError(new ApiRequestError(0, payload.code ?? 'STREAM_ERROR', payload.message ?? 'Session stream failed'));
      });

      es.addEventListener('error', () => {
        if (closed || source !== es) return;
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          handlersRef.current.onFallback();
          return;
        }
        const now = Date.now();
        errorTimes = [...errorTimes.filter((time) => now - time < SSE_FAILURE_WINDOW_MS), now];
        if (errorTimes.length >= SSE_FAILURES_BEFORE_FALLBACK) {
          es.close();
          handlersRef.current.onFallback();
        }
      });
    };

    // iOS (home-screen PWAs especially) kills background connections without
    // firing an error, leaving a dead stream behind a healthy-looking page.
    // Reconnect whenever the page returns to the foreground; the hub replays
    // the current snapshot on subscribe, so this also refreshes instantly.
    const onVisible = () => {
      if (closed || document.visibilityState !== 'visible') return;
      source?.close();
      errorTimes = [];
      connect();
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      source?.close();
    };
  }, [options.agent, options.status, options.triage, options.trigger, options.approval, options.window, options.limit, options.detail, options.mock, options.enabled]);
}
