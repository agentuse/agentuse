import { logger } from '../utils/logger';

/**
 * Idle (stall) detection for model streams.
 *
 * The AI SDK's `maxRetries` covers network-level failures, and the session
 * timeout covers the whole run, but nothing covered the middle case: a request
 * that is accepted, opens a stream, and then never emits a chunk. Observed in
 * production on 2026-09-08, where a call sat silent for ~400s until the 8-minute
 * session timeout killed the entire run with no explanation.
 *
 * A watchdog arms a timer that is re-armed on every chunk. If it fires, only the
 * per-attempt controller is aborted — never the run's own abort signal — so the
 * caller can retry the step instead of ending the session.
 */

/** Default idle window for the agent loop's `streamText` calls. */
export const AGENT_LOOP_IDLE_TIMEOUT_SECONDS = 120;
/** Default idle window for one-shot helper calls (`completeText`). */
export const HELPER_IDLE_TIMEOUT_SECONDS = 60;
/** Total attempts (initial + retries) a stalled agent-loop segment gets. */
export const MODEL_STALL_MAX_ATTEMPTS = 3;

const ENV_VAR = 'AGENTUSE_MODEL_IDLE_TIMEOUT';

export class ModelStreamStallError extends Error {
  readonly idleMs: number;
  readonly attempts: number | undefined;

  constructor(idleMs: number, attempts?: number) {
    const seconds = Math.round(idleMs / 1000);
    const suffix = attempts === undefined
      ? ''
      : ` (${attempts} attempt${attempts === 1 ? '' : 's'})`;
    super(`Model stream stalled: no output for ${seconds}s${suffix}`);
    this.name = 'ModelStreamStallError';
    this.idleMs = idleMs;
    this.attempts = attempts;
  }
}

export function isModelStreamStallError(error: unknown): error is ModelStreamStallError {
  return error instanceof Error && error.name === 'ModelStreamStallError';
}

/**
 * Resolve the idle window in milliseconds. `AGENTUSE_MODEL_IDLE_TIMEOUT` is in
 * seconds and overrides both defaults; `0` disables stall detection entirely.
 */
export function resolveModelIdleTimeoutMs(
  defaultSeconds: number,
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') return defaultSeconds * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(`Ignoring invalid ${ENV_VAR}="${raw}"; using ${defaultSeconds}s.`);
    return defaultSeconds * 1000;
  }
  return Math.round(parsed * 1000);
}

export interface StallWatchdog {
  /** Signal to hand to the provider: the caller's signal combined with the stall controller. */
  readonly signal: AbortSignal;
  /** True once the idle timer fired (so an abort can be told apart from a user cancel). */
  readonly stalled: boolean;
  /** Re-arm the idle timer. Call on every chunk received. */
  notify(): void;
  /** Pause model-idle detection while the stream is executing tools. */
  pause(): void;
  /** Resume model-idle detection when the model can emit again. */
  resume(): void;
  /** Stop the timer. Safe to call more than once. */
  dispose(): void;
}

/**
 * Build a watchdog whose signal aborts only this attempt. `upstream` (the run's
 * own abort signal) is combined in, never replaced, so user cancellation and the
 * session timeout keep working.
 */
export function createStallWatchdog(idleMs: number, upstream?: AbortSignal): StallWatchdog {
  const controller = new AbortController();
  const signal = upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal;

  if (!(idleMs > 0)) {
    // Disabled: still hand back a combined signal so callers stay uniform.
    return {
      signal,
      stalled: false,
      notify: () => {},
      pause: () => {},
      resume: () => {},
      dispose: () => {},
    };
  }

  let stalled = false;
  let disposed = false;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (disposed || stalled || paused) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort(new ModelStreamStallError(idleMs));
    }, idleMs);
    timer.unref?.();
  };

  arm();

  return {
    signal,
    get stalled() {
      return stalled;
    },
    notify: arm,
    pause() {
      paused = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    resume() {
      if (disposed || stalled || !paused) return;
      paused = false;
      arm();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
