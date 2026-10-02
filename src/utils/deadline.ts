/**
 * Core-owned bounds for awaiting third-party code (plugin hooks, MCP calls,
 * provider discovery). They bound the wait only: abandoned code may keep
 * running, so each caller decides what an abandoned outcome means.
 */

/**
 * Await `value`, but settle as soon as `signal` aborts, rejecting with its
 * reason. A late rejection of `value` is still observed, so abandoning it
 * never surfaces as an unhandled rejection.
 */
export async function awaitAbortable<T>(value: PromiseLike<T> | T, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
  if (!signal) return await value;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function deadlineError(ms: number): Error {
  const error = new Error(`Timed out after ${ms}ms`);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Run `run` with its own signal that aborts after `ms` (or when `parent`
 * aborts), and stop waiting at that moment. On the deadline the signal is
 * aborted with, and the call rejects with, `options.error()` (a TimeoutError
 * by default), so callers can tell their own deadline from a parent abort.
 */
export async function withDeadline<T>(
  run: (signal: AbortSignal) => PromiseLike<T> | T,
  ms: number,
  options: { parent?: AbortSignal | undefined; error?: () => Error } = {},
): Promise<T> {
  const controller = new AbortController();
  const signal = options.parent ? AbortSignal.any([options.parent, controller.signal]) : controller.signal;
  if (signal.aborted) throw signal.reason;
  const timer = setTimeout(() => controller.abort(options.error?.() ?? deadlineError(ms)), ms);
  try {
    return await awaitAbortable(run(signal), signal);
  } finally {
    clearTimeout(timer);
  }
}
