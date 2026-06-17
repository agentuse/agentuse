import { useEffect, useRef } from 'preact/hooks';
import { ApiRequestError, sessionsEventUrl, type SessionsPayload } from '../lib/api';

const SSE_FAILURE_WINDOW_MS = 10_000;
const SSE_FAILURES_BEFORE_FALLBACK = 2;

export function useSessionsStream(options: {
  agent: string | undefined;
  status: string | undefined;
  trigger: string | undefined;
  approval: string | undefined;
  window: string | undefined;
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
    const source = new EventSource(sessionsEventUrl({
      agent: options.agent,
      status: options.status,
      trigger: options.trigger,
      approval: options.approval,
      window: options.window,
    }));

    source.addEventListener('sessions', (event) => {
      errorTimes = [];
      const payload = JSON.parse((event as MessageEvent).data) as SessionsPayload;
      handlersRef.current.onData(payload);
    });

    source.addEventListener('stream-error', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { code?: string; message?: string };
      handlersRef.current.onError(new ApiRequestError(0, payload.code ?? 'STREAM_ERROR', payload.message ?? 'Session stream failed'));
    });

    source.addEventListener('error', () => {
      if (closed) return;
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        handlersRef.current.onFallback();
        return;
      }
      const now = Date.now();
      errorTimes = [...errorTimes.filter((time) => now - time < SSE_FAILURE_WINDOW_MS), now];
      if (errorTimes.length >= SSE_FAILURES_BEFORE_FALLBACK) {
        source.close();
        handlersRef.current.onFallback();
      }
    });

    return () => {
      closed = true;
      source.close();
    };
  }, [options.agent, options.status, options.trigger, options.approval, options.window, options.enabled]);
}
