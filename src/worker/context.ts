/**
 * Cross-handler worker state.
 *
 * These live for the process: one worker serves one project and handles many
 * requests concurrently, so a run started by `executeAgent` must stay reachable
 * to `stopSession`, to the cascade walk-up, and to the released-worker stop
 * watch. Passed to handlers explicitly rather than captured from a closure.
 */
export interface WorkerContext {
  /** Sessions currently executing here, by session id, so a stop can abort them. */
  activeExecutionControllers: Map<string, AbortController>;
  /** Sessions already aborted by a stop, so the abort is only taken once. */
  activeStoppedSessions: Set<string>;
  /**
   * Execute requests currently in flight (covers the whole request, including
   * the pre-session-write setup window that activeExecutionControllers misses
   * for fresh runs). Drives the short list-cache TTL in ./cache.
   */
  activeExecuteRequests: number;
}

export function createWorkerContext(): WorkerContext {
  return {
    activeExecutionControllers: new Map<string, AbortController>(),
    activeStoppedSessions: new Set<string>(),
    activeExecuteRequests: 0,
  };
}
