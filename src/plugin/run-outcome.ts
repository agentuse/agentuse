import type { PluginEvents } from './types';
import type { PluginManager } from './index';
import { logger } from '../utils/logger';
import { toErrorMessage } from '../utils/error-message';

/** How long `agent:error` and `agent:suspend` handlers may run once the run's signal has aborted. */
export const AFTER_ABORT_HOOK_GRACE_MS = 5_000;

/**
 * Emit a hook that reports how a run ended (`agent:error`, `agent:suspend`).
 * These often fire because the run's signal aborted, and an aborted signal
 * would skip every handler, so they get a short grace deadline instead. A
 * handler that outlives its signal is abandoned with a warning and never
 * replaces the run's own outcome.
 */
export async function emitRunOutcome<E extends 'agent:error' | 'agent:suspend'>(
  plugins: Pick<PluginManager, 'emit'>,
  name: E,
  event: PluginEvents[E],
  signal: AbortSignal | undefined,
): Promise<void> {
  const hookSignal = signal?.aborted ? AbortSignal.timeout(AFTER_ABORT_HOOK_GRACE_MS) : signal;
  try {
    await plugins.emit(name, event, hookSignal);
  } catch (error) {
    if (!hookSignal?.aborted) throw error;
    logger.warn(`Plugin ${name} handlers abandoned: ${toErrorMessage(error)}`);
  }
}
