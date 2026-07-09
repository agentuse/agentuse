import { useEffect, useRef } from 'preact/hooks';
import { ApiRequestError, approvalsEventUrl, type ApprovalsListPayload } from '../lib/api';

const SSE_FAILURE_WINDOW_MS = 10_000;
const SSE_FAILURES_BEFORE_FALLBACK = 2;

export function useApprovalsStream(options: {
  days: string | undefined;
  project: string | undefined;
  enabled: boolean;
  onData: (payload: ApprovalsListPayload) => void;
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
      const es = new EventSource(approvalsEventUrl({ days: options.days, project: options.project }));
      source = es;

      es.addEventListener('approvals', (event) => {
        errorTimes = [];
        const payload = JSON.parse((event as MessageEvent).data) as ApprovalsListPayload;
        handlersRef.current.onData(payload);
      });

      es.addEventListener('stream-error', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { code?: string; message?: string };
        handlersRef.current.onError(new ApiRequestError(0, payload.code ?? 'STREAM_ERROR', payload.message ?? 'Approval stream failed'));
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

    // See use-sessions-stream: iOS kills background connections silently, so
    // reconnect (and thereby refresh) whenever the page becomes visible again.
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
  }, [options.days, options.project, options.enabled]);
}
