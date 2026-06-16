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
    const source = new EventSource(approvalsEventUrl({ days: options.days, project: options.project }));

    source.addEventListener('approvals', (event) => {
      errorTimes = [];
      const payload = JSON.parse((event as MessageEvent).data) as ApprovalsListPayload;
      handlersRef.current.onData(payload);
    });

    source.addEventListener('stream-error', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { code?: string; message?: string };
      handlersRef.current.onError(new ApiRequestError(0, payload.code ?? 'STREAM_ERROR', payload.message ?? 'Approval stream failed'));
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
  }, [options.days, options.project, options.enabled]);
}
