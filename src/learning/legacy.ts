/**
 * ⚠️ DEPRECATED-COMPAT(learning.evaluate)
 *
 * This module is the ONLY place that understands the legacy `learning.evaluate`
 * config shape. Everything downstream sees the canonical
 * { capture, apply, criteria?, file? } config produced here.
 *
 * Introduced: v0.15  •  Remove in: v0.16
 * To remove: delete this file, drop the legacy branch + import in types.ts,
 * and delete tests/legacy-learning-config.test.ts. Grep the removal checklist
 * with: DEPRECATED-COMPAT(learning.evaluate)
 */
import { z } from 'zod';
import { logger } from '../utils/logger';
import type { CanonicalLearningConfig } from './types';

export const LEARNING_COMPAT_REMOVE_IN = '0.16';

const warnedLegacyKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedLegacyKeys.has(key)) return;
  warnedLegacyKeys.add(key);
  logger.warn(message);
}

/**
 * Legacy shape: `evaluate` was the capture switch (true or a criteria string),
 * `apply` defaulted to false, `file` was the custom store path.
 */
export const LegacyLearningSchema = z
  .object({
    evaluate: z.union([z.literal(true), z.string()]),
    apply: z.boolean().optional(),
    file: z.string().optional(),
  })
  .strict();

/**
 * Map the legacy `{ evaluate, apply?, file? }` shape onto the canonical config.
 * - evaluate: true   → capture: true
 * - evaluate: string → capture: true, criteria: <string>
 * - apply preserves the old default (false) when omitted
 */
export function migrateLegacyLearning(
  raw: z.infer<typeof LegacyLearningSchema>
): CanonicalLearningConfig {
  warnOnce(
    'deprecated:learning.evaluate',
    `The "learning.evaluate" field is deprecated. Use "learning.capture" (and "learning.criteria" for custom guidance). Removed in v${LEARNING_COMPAT_REMOVE_IN}.`
  );
  return {
    capture: true,
    apply: raw.apply ?? false,
    ...(typeof raw.evaluate === 'string' && { criteria: raw.evaluate }),
    ...(raw.file && { file: raw.file }),
  };
}
