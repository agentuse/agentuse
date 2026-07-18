/**
 * Shared duration parsing for every user-facing timeout field.
 *
 * Accepted forms:
 * - Suffixed string: "500ms", "30s", "2m", "1h", "1d" (case-insensitive,
 *   optional whitespace before the suffix, decimals allowed: "1.5m").
 * - Bare number (or numeric string): interpreted in the field's historical
 *   unit, passed as `bareUnit` by the caller. New fields should use seconds.
 *
 * Callers that keep a non-seconds bare unit for backward compatibility (the
 * bash tool's ms) pass `onBareNumber` to emit a deprecation warning.
 */

import { z } from 'zod';

const SUFFIX_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

export interface ParseDurationOptions {
  /** Unit applied to bare numbers and suffix-less numeric strings. */
  bareUnit: 'seconds' | 'milliseconds';
  /** Field name used in error messages, e.g. "tools.bash.timeout". */
  field: string;
  /** Called when the value was bare (no unit suffix), before returning. */
  onBareNumber?: (value: number) => void;
}

/**
 * Parse a duration into milliseconds. Throws on invalid or non-positive input
 * so a typo fails the run loudly instead of producing a near-zero timeout.
 */
export function parseDurationMs(
  value: number | string,
  options: ParseDurationOptions
): number {
  const { bareUnit, field, onBareNumber } = options;
  const bareMultiplier = bareUnit === 'seconds' ? 1000 : 1;

  let amount: number;
  let suffix: string | undefined;

  if (typeof value === 'number') {
    amount = value;
  } else {
    const match = value.trim().match(DURATION_RE);
    if (!match) {
      throw new Error(
        `Invalid duration for ${field}: "${value}". Use a number or a suffixed string like "30s", "2m", "500ms".`
      );
    }
    amount = Number(match[1]);
    suffix = match[2]?.toLowerCase();
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid duration for ${field}: must be a positive number, got ${value}`);
  }

  if (suffix) {
    return Math.round(amount * SUFFIX_MS[suffix]);
  }

  onBareNumber?.(amount);
  return Math.round(amount * bareMultiplier);
}

/**
 * Zod schema for a duration field normalized to whole SECONDS. Accepts a bare
 * number (seconds) or a suffixed string ("30s", "2m"); output is always a
 * number of seconds, so downstream code is unchanged.
 */
export function durationSecondsSchema(field: string) {
  return z.union([z.number(), z.string()]).transform((value, ctx) => {
    try {
      return parseDurationSeconds(value, { bareUnit: 'seconds', field });
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}

/** Convenience wrapper returning whole seconds (rounded up so sub-second values don't truncate to 0). */
export function parseDurationSeconds(
  value: number | string,
  options: ParseDurationOptions
): number {
  return Math.ceil(parseDurationMs(value, options) / 1000);
}
