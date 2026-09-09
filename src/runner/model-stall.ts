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
 * A watchdog keeps separate first-progress, post-progress idle, and hard-limit
 * timers. If one fires, only the per-attempt controller is aborted — never the
 * run's own abort signal — so the caller can retry the step instead of ending
 * the session.
 */

/** Default post-progress idle window for every model stream. */
export const MODEL_IDLE_TIMEOUT_SECONDS = 300;
/** First-progress budget for explicitly high-reasoning model calls. */
export const HIGH_REASONING_FIRST_PROGRESS_TIMEOUT_SECONDS = 600;
/** First-progress budget for high-reasoning calls with a large prompt. */
export const LARGE_CONTEXT_FIRST_PROGRESS_TIMEOUT_SECONDS = 900;
/** Absolute ceiling for one provider/model step, excluding tool execution. */
export const MODEL_STEP_HARD_TIMEOUT_SECONDS = 1500;
/** Total attempts (initial + retries) a stalled agent-loop model step gets. */
export const MODEL_STALL_MAX_ATTEMPTS = 3;
/** Total attempts a model step gets when its transport keeps dropping. */
export const MODEL_TRANSPORT_MAX_ATTEMPTS = 3;
/** Agent-visible retry backoff. Attempts 2 and 3 wait 2s and 4s. */
export const MODEL_STALL_RETRY_BASE_DELAY_MS = 2000;

const ENV_VAR = 'AGENTUSE_MODEL_IDLE_TIMEOUT';
const RETRY_DELAY_ENV_VAR = 'AGENTUSE_MODEL_STALL_RETRY_BASE_DELAY';

export type ModelStallPhase = 'first-progress' | 'idle' | 'hard-limit';

export interface ModelStallPolicy {
  /** Time allowed until the first substantive model delta. */
  firstProgressMs: number;
  /** Maximum silence after substantive model progress begins. */
  idleMs: number;
  /** Absolute duration of one model step. Zero disables the ceiling. */
  hardTimeoutMs: number;
}

export interface ResolveModelStallPolicyOptions {
  modelString: string;
  contextTokens?: number | undefined;
  reasoning?: string | undefined;
  anthropicThinking?: boolean | undefined;
  codexBackend?: boolean | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export class ModelStreamStallError extends Error {
  readonly idleMs: number;
  readonly attempts: number | undefined;
  readonly phase: ModelStallPhase;

  constructor(idleMs: number, attempts?: number, phase: ModelStallPhase = 'idle') {
    const seconds = Math.round(idleMs / 1000);
    const suffix = attempts === undefined
      ? ''
      : ` (${attempts} attempt${attempts === 1 ? '' : 's'})`;
    const detail = phase === 'hard-limit'
      ? `model step exceeded its ${seconds}s hard limit`
      : phase === 'first-progress'
        ? `no model progress for ${seconds}s`
        : `no output for ${seconds}s`;
    super(`Model stream stalled: ${detail}${suffix}`);
    this.name = 'ModelStreamStallError';
    this.idleMs = idleMs;
    this.attempts = attempts;
    this.phase = phase;
  }
}

export function isModelStreamStallError(error: unknown): error is ModelStreamStallError {
  return error instanceof Error && error.name === 'ModelStreamStallError';
}

/**
 * A live model stream whose transport died underneath it.
 *
 * Distinct from a stall: the provider accepted the request and was emitting,
 * then the connection dropped. undici surfaces this as `TypeError: terminated`
 * (cause `SocketError: other side closed`), which carries no model verdict at
 * all. Production data 2026-09: 17 runs across 8 agents ended fatally this way
 * in eight weeks, ~2 per week and rising, each abandoning a run mid-flight.
 */
export class ModelStreamTransportError extends Error {
  readonly attempts: number | undefined;
  readonly detail: string;

  constructor(detail: string, attempts?: number) {
    const suffix = attempts === undefined
      ? ''
      : ` (${attempts} attempt${attempts === 1 ? '' : 's'})`;
    super(`Model stream connection dropped: ${detail}${suffix}`);
    this.name = 'ModelStreamTransportError';
    this.attempts = attempts;
    this.detail = detail;
  }
}

/** Socket-level codes that mean the connection died, not that a request failed. */
const TRANSPORT_DROP_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** Message shapes for the same failure, since not every layer preserves a code. */
const TRANSPORT_DROP_PATTERNS = [
  /^terminated$/,
  /socket hang up/,
  /other side closed/,
  /premature close/,
  /connection reset/,
  /network socket disconnected/,
];

/**
 * Was this error the transport dying under a stream that had already opened?
 *
 * Deliberately narrow. Cancellation (`AbortError`, `UND_ERR_ABORTED`) and a
 * stall both mean something specific and are handled by their own paths, so
 * they are excluded here rather than swept into a retry.
 */
export function isModelStreamTransportDrop(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message.trim().toLowerCase() : '';
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'UND_ERR_ABORTED') return false;
    if (name === 'ModelStreamStallError') return false;
    if (TRANSPORT_DROP_CODES.has(code)) return true;
    if (TRANSPORT_DROP_PATTERNS.some((pattern) => pattern.test(message))) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Resolve the idle window in milliseconds. `AGENTUSE_MODEL_IDLE_TIMEOUT` is in
 * seconds and overrides both defaults; `0` disables stall detection entirely.
 */
function configuredIdleOverride(env: Record<string, string | undefined>): number | undefined {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(`Ignoring invalid ${ENV_VAR}="${raw}"; using adaptive model timeouts.`);
    return undefined;
  }
  return Math.round(parsed * 1000);
}

/**
 * Resolve a model-step timeout policy. A single explicit legacy override keeps
 * its old meaning: use exactly that idle window everywhere, or disable with 0.
 * Otherwise the first-progress budget grows for costly reasoning/prefill while
 * the post-progress detector remains a predictable five-minute idle window.
 */
export function resolveModelStallPolicy(options: ResolveModelStallPolicyOptions): ModelStallPolicy {
  const env = options.env ?? process.env;
  const overrideMs = configuredIdleOverride(env);
  if (overrideMs !== undefined) {
    return { firstProgressMs: overrideMs, idleMs: overrideMs, hardTimeoutMs: 0 };
  }

  const normalizedReasoning = options.reasoning?.trim().toLowerCase();
  const highReasoning = options.codexBackend === true
    || options.anthropicThinking === true
    || normalizedReasoning === 'high'
    || normalizedReasoning === 'xhigh'
    || normalizedReasoning === 'max';
  const largeContext = (options.contextTokens ?? 0) > 50_000;
  const firstProgressSeconds = highReasoning
    ? largeContext
      ? LARGE_CONTEXT_FIRST_PROGRESS_TIMEOUT_SECONDS
      : HIGH_REASONING_FIRST_PROGRESS_TIMEOUT_SECONDS
    : MODEL_IDLE_TIMEOUT_SECONDS;

  return {
    firstProgressMs: firstProgressSeconds * 1000,
    idleMs: MODEL_IDLE_TIMEOUT_SECONDS * 1000,
    hardTimeoutMs: MODEL_STEP_HARD_TIMEOUT_SECONDS * 1000,
  };
}

/** Conservative fallback when ContextManager is disabled or unavailable. */
export function estimateModelContextTokens(messages: unknown): number {
  try {
    const serialized = JSON.stringify(messages, (_key, value) => {
      if (typeof value === 'string' && value.startsWith('data:') && value.length > 256) {
        return `[inline media: ${value.length} bytes]`;
      }
      return value;
    });
    return Math.ceil((serialized?.length ?? 0) / 4);
  } catch {
    return 0;
  }
}

export function modelStallRetryDelayMs(
  retryNumber: number,
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[RETRY_DELAY_ENV_VAR];
  const parsed = raw === undefined ? MODEL_STALL_RETRY_BASE_DELAY_MS : Number(raw);
  const base = Number.isFinite(parsed) && parsed >= 0 ? parsed : MODEL_STALL_RETRY_BASE_DELAY_MS;
  return Math.min(60_000, Math.round(base * (2 ** Math.max(0, retryNumber - 1))));
}

export async function waitForModelStallRetry(retryNumber: number, signal?: AbortSignal): Promise<void> {
  const delayMs = modelStallRetryDelayMs(retryNumber);
  if (delayMs <= 0) {
    signal?.throwIfAborted();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    timer.unref?.();
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Model stall retry cancelled'));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

export interface StallWatchdog {
  /** Signal to hand to the provider: the caller's signal combined with the stall controller. */
  readonly signal: AbortSignal;
  /** True once the idle timer fired (so an abort can be told apart from a user cancel). */
  readonly stalled: boolean;
  /** The precise deadline that fired. */
  readonly failure: ModelStreamStallError | undefined;
  /** Start a new provider/model step and replace its timeout policy. */
  beginStep(policy?: ModelStallPolicy): void;
  /** Record substantive model progress and re-arm the post-progress timer. */
  notify(progress?: boolean): void;
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
export function createStallWatchdog(policyOrIdleMs: ModelStallPolicy | number, upstream?: AbortSignal): StallWatchdog {
  const controller = new AbortController();
  const signal = upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal;
  let policy = typeof policyOrIdleMs === 'number'
    ? { firstProgressMs: policyOrIdleMs, idleMs: policyOrIdleMs, hardTimeoutMs: 0 }
    : policyOrIdleMs;

  if (!(policy.firstProgressMs > 0) && !(policy.idleMs > 0) && !(policy.hardTimeoutMs > 0)) {
    // Disabled: still hand back a combined signal so callers stay uniform.
    return {
      signal,
      stalled: false,
      failure: undefined,
      beginStep: () => {},
      notify: () => {},
      pause: () => {},
      resume: () => {},
      dispose: () => {},
    };
  }

  let stalled = false;
  let failure: ModelStreamStallError | undefined;
  let disposed = false;
  let paused = false;
  let sawProgress = false;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (activityTimer) clearTimeout(activityTimer);
    if (hardTimer) clearTimeout(hardTimer);
    activityTimer = undefined;
    hardTimer = undefined;
  };

  const fail = (timeoutMs: number, phase: ModelStallPhase): void => {
    if (disposed || stalled || paused) return;
    stalled = true;
    clearTimers();
    failure = new ModelStreamStallError(timeoutMs, undefined, phase);
    controller.abort(failure);
  };

  const armActivity = (): void => {
    if (disposed || stalled || paused) return;
    if (activityTimer) clearTimeout(activityTimer);
    const timeoutMs = sawProgress ? policy.idleMs : policy.firstProgressMs;
    if (!(timeoutMs > 0)) return;
    activityTimer = setTimeout(
      () => fail(timeoutMs, sawProgress ? 'idle' : 'first-progress'),
      timeoutMs
    );
    activityTimer.unref?.();
  };

  const beginStep = (nextPolicy: ModelStallPolicy = policy): void => {
    if (disposed || stalled) return;
    policy = nextPolicy;
    paused = false;
    sawProgress = false;
    clearTimers();
    armActivity();
    if (policy.hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => fail(policy.hardTimeoutMs, 'hard-limit'), policy.hardTimeoutMs);
      hardTimer.unref?.();
    }
  };

  beginStep();

  return {
    signal,
    get stalled() {
      return stalled;
    },
    get failure() {
      return failure;
    },
    beginStep,
    notify(progress = true) {
      if (!progress || disposed || stalled || paused) return;
      sawProgress = true;
      armActivity();
    },
    pause() {
      paused = true;
      clearTimers();
    },
    resume() {
      if (disposed || stalled || !paused) return;
      paused = false;
      armActivity();
      if (policy.hardTimeoutMs > 0) {
        hardTimer = setTimeout(() => fail(policy.hardTimeoutMs, 'hard-limit'), policy.hardTimeoutMs);
        hardTimer.unref?.();
      }
    },
    dispose() {
      disposed = true;
      clearTimers();
    },
  };
}
