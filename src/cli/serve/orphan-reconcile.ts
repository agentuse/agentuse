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

  const runNow = (): void => {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void Promise.resolve()
      .then(runSweep)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = false;
        if (!rerun || stopped) return;
        rerun = false;
        runNow();
      });
  };

  const timer = setInterval(runNow, intervalMs);
  timer.unref?.();

  return {
    runNow,
    stop() {
      if (stopped) return;
      stopped = true;
      rerun = false;
      clearInterval(timer);
    },
  };
}
