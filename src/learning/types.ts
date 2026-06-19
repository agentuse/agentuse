import { z } from 'zod';
// DEPRECATED-COMPAT(learning.evaluate) — delete this import with src/learning/legacy.ts
import { LegacyLearningSchema, migrateLegacyLearning } from './legacy';

/**
 * Canonical learning config. `capture` writes lessons to the store (from
 * self-evaluation and from approval-gate comments); `apply` injects stored
 * lessons into the system prompt before each run.
 */
export interface CanonicalLearningConfig {
  capture: boolean;
  apply: boolean;
  criteria?: string; // optional guidance for the capture evaluator
  file?: string;     // custom store path, relative to the agent file
}

const CanonicalLearningSchema = z
  .object({
    capture: z.boolean().default(true),
    apply: z.boolean().default(true),
    criteria: z.string().optional(),
    file: z.string().optional(),
  })
  .strict();

/**
 * Config schema for the learning feature in agent config.
 * Accepts `learning: true` (sugar for capture + apply), the canonical object,
 * or the deprecated `{ evaluate, ... }` shape (migrated in ./legacy).
 */
export const LearningConfigSchema = z.union([
  z.literal(true).transform((): CanonicalLearningConfig => ({ capture: true, apply: true })),
  CanonicalLearningSchema,
  // DEPRECATED-COMPAT(learning.evaluate) — delete this branch with src/learning/legacy.ts
  LegacyLearningSchema.transform(migrateLegacyLearning),
]);

export type LearningConfig = z.infer<typeof LearningConfigSchema>;

/**
 * Learning category types
 */
export type LearningCategory = 'tip' | 'warning' | 'pattern' | 'tool-usage' | 'error-fix';

/**
 * How a learning entered the store.
 * - auto: extracted by self-evaluation of an execution
 * - approval: promoted from a human reviewer's approval-gate comment
 */
export type LearningSource = 'auto' | 'approval';

/**
 * Outcome of a learning capture attempt, used to surface a marker in the
 * session log so a silent failure (e.g. the Codex backend rejecting the helper
 * LLM call) is visible instead of looking like "nothing was learned".
 * - captured: one or more lessons written to the store
 * - none: the evaluator ran but produced nothing new (or judged a comment one-off)
 * - failed: the capture attempt threw (model/auth/parse error in `detail`)
 */
export type LearningOutcomeStatus = 'captured' | 'none' | 'failed';

export interface LearningOutcome {
  status: LearningOutcomeStatus;
  source: LearningSource;
  count: number;       // lessons captured this run
  titles: string[];    // titles of captured lessons (for the log message)
  detail?: string;     // error message when status is 'failed'
}

/**
 * Learning item stored in markdown
 */
export interface Learning {
  id: string;           // Short ID (8 chars)
  category: LearningCategory;
  title: string;        // One-line summary
  instruction: string;  // The actual learning text
  confidence: number;   // 0-1
  appliedCount: number; // Times injected
  extractedAt: string;  // ISO date
  source: LearningSource; // Provenance (defaults to 'auto' for legacy files)
}
