/** Budget for a best-effort terminal notice (a run card update) on a stop, timeout or reconcile path. */
export const TERMINAL_NOTICE_BUDGET_MS = 3_000;

/**
 * Wait for best-effort work, but no longer than `ms`: a Slack outage must not
 * hold up a stop response or a CLI exit. The work keeps going in the
 * background if the process lives on; its rejection is swallowed here.
 */
export async function settleWithin(work: Promise<unknown>, ms: number = TERMINAL_NOTICE_BUDGET_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
