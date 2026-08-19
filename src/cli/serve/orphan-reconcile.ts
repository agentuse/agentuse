/** How quickly a replacement daemon notices that a released predecessor died. */
export const ORPHAN_RECONCILE_INTERVAL_MS = 10_000;

export interface OrphanReconcileLoop {
  /** Request a sweep now. Concurrent requests collapse into one trailing sweep. */
  runNow(): void;
  stop(): void;
}

/**
 * Keep orphan reconciliation alive after the startup pass.
 *
 * A clean restart deliberately leaves busy workers running under their old pid.
 * The replacement daemon's startup sweep must ignore those live owners, but one
 * can die later without generating an event in the replacement process. A
 * periodic, single-flight pass closes that otherwise permanent orphan window.
 */
export function startOrphanReconcileLoop(
  runSweep: () => Promise<void>,
  options: {
    intervalMs?: number;
    onError?: (error: unknown) => void;
  } = {}
): OrphanReconcileLoop {
  const intervalMs = options.intervalMs ?? ORPHAN_RECONCILE_INTERVAL_MS;
  let running = false;
  let rerun = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      runNow();
    }, intervalMs);
    timer.unref?.();
  };

  const runNow = (): void => {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = true;
    void Promise.resolve()
      .then(runSweep)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = false;
        if (stopped) return;
        if (rerun) {
          rerun = false;
          runNow();
          return;
        }
        // Schedule relative to completion, not the previous start. A sweep
        // slower than the interval must not create a permanent immediate-rerun
        // loop that monopolizes the session store.
        schedule();
      });
  };

  schedule();

  return {
    runNow,
    stop() {
      if (stopped) return;
      stopped = true;
      rerun = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
