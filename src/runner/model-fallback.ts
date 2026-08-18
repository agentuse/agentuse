import { extractApiErrorDetail, isRetryableApiError } from './api-error';
import { toErrorMessage } from '../utils/error-message';

/** Concrete model -> epoch milliseconds when this process may try it again. */
const cooldowns = new Map<string, number>();

export function isTransientModelError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;

  const api = extractApiErrorDetail(error);
  if (api?.statusCode !== undefined) {
    return api.statusCode === 408 || api.statusCode === 429 || api.statusCode >= 500;
  }
  const apiRetryable = isRetryableApiError(error);
  if (apiRetryable !== undefined) return apiRetryable;

  const message = toErrorMessage(error).toLowerCase();
  if (/\b(?:408|429|5\d\d)\b/.test(message)) return true;
  return [
    'rate limit',
    'too many requests',
    'service unavailable',
    'temporarily unavailable',
    'overloaded',
    'timed out',
    'timeout',
    'network error',
    'connection reset',
    'connection refused',
    'fetch failed',
    'socket hang up',
    'econnreset',
    'econnrefused',
    'etimedout',
  ].some((needle) => message.includes(needle));
}

/**
 * Can this model not be used at all on this machine right now? A missing login,
 * an OAuth token that would not refresh, a 401/403. Unlike a transient failure
 * this will not clear on its own, but it is still per-candidate and raised
 * before a single request leaves the process, so it is the safest possible
 * moment to move on: naming a second candidate is precisely the instruction to
 * use it when the first one cannot run.
 */
export function isModelUnusableError(error: unknown): boolean {
  // Name rather than instanceof: the same error crosses module and process
  // boundaries (subagents, the serve daemon) where the class identity does not
  // survive but the name does.
  if (error instanceof Error && (error.name === 'AuthenticationError' || error.name === 'AnthropicRefreshFailed')) {
    return true;
  }
  const api = extractApiErrorDetail(error);
  return api?.statusCode === 401 || api?.statusCode === 403;
}

/** Whether an ordered alias should move to its next candidate. */
export function shouldTryNextModel(error: unknown): boolean {
  return isTransientModelError(error) || isModelUnusableError(error);
}

/**
 * Return configured candidates that are not cooling down. If every candidate
 * is cooling down, try the one closest to recovery so fallback never turns a
 * temporary health hint into a synthetic outage.
 */
export function availableModelCandidates(candidates: string[], now = Date.now()): string[] {
  if (candidates.length === 0) return [];
  const active = candidates.filter((model) => (cooldowns.get(model) ?? 0) <= now);
  if (active.length > 0) return active;
  const earliest = candidates.reduce((best, model) =>
    (cooldowns.get(model) ?? 0) < (cooldowns.get(best) ?? 0) ? model : best
  );
  return [earliest];
}

export function markModelCooldown(model: string, cooldownMs: number | undefined, now = Date.now()): void {
  if (cooldownMs === undefined || cooldownMs <= 0) return;
  cooldowns.set(model, now + cooldownMs);
}

export function clearModelCooldown(model: string): void {
  cooldowns.delete(model);
}

export function modelCooldownUntil(model: string): number | undefined {
  return cooldowns.get(model);
}

/** Test seam; cooldown is intentionally process-local and otherwise immortal. */
export function resetModelCooldowns(): void {
  cooldowns.clear();
}
