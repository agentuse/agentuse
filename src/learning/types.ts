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
  max?: number;      // injected-per-run cap (default MAX_INJECTED_LEARNINGS)
  model?: string;    // model for helper calls (capture + tidy); defaults to the agent's
}

const CanonicalLearningSchema = z
  .object({
    capture: z.boolean().default(true),
    apply: z.boolean().default(true),
    criteria: z.string().optional(),
    file: z.string().optional(),
    // Bounded on purpose: the cap exists to keep the guideline block from
    // crowding out the agent's own instructions, and every injected learning is
    // paid for on every model request. `agentuse doctor` prints the token cost
    // next to the count so raising it shows its own price.
    max: z.number().int().min(1).max(50).optional(),
    // Helper calls (capture, tidy) run on the agent's own model by default:
    // whatever provider and auth the agent already works with is guaranteed to
    // work here too, and the model that will later FOLLOW these instructions is
    // the right one to write them. Override for an agent deliberately running a
    // cheap tier for high-volume work — you probably don't want that tier
    // deciding which corrections become permanent.
    model: z.string().optional(),
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
 * - manual: explicitly saved by a human reviewer as a durable rule
 */
export type LearningSource = 'auto' | 'approval' | 'manual';

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
 * A resolved approval gate that carried a reviewer comment: the reviewer's
 * comment plus the work that was shown to them at that gate. The unified
 * evaluator uses these to ground a deictic comment ("too long", "cite this") in
 * the actual output instead of judging it in a vacuum.
 */
export interface ApprovalReview {
  comment: string;
  work?: string;
}

/**
 * Where a learning sits in its lifecycle.
 * - active: eligible for injection, subject to the per-run cap
 * - graduated: written into the agent file's own instructions, so it applies on
 *   every run without consuming a cap slot. Never injected again.
 * - retired: superseded or stale. Kept in the file (nothing is ever deleted by
 *   the system) and revived automatically if a human re-asserts it.
 *
 * Absent on files written before the lifecycle existed, which load as active.
 */
export type LearningState = 'active' | 'graduated' | 'retired';

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
  sessionId?: string;   // Session the learning was captured in (absent for legacy files and agent-level manual rules)
  state?: LearningState; // Lifecycle position; absent means active
  /**
   * Times a human repeated this correction after it was already stored.
   *
   * Evidence that the WORDING is not landing — the agent has the rule and made
   * the mistake anyway — so a re-asserted entry is a candidate to be rewritten,
   * never to be retired.
   */
  reasserted: number;
  /**
   * Runs this learning was injected into that ended with an approval and no
   * reviewer comment.
   *
   * This is the only evidence the system has that a rule actually WORKS, as
   * opposed to `appliedCount`, which counts injections and so measures cost, not
   * value. Graduating a rule into the agent file permanently is gated on it.
   */
  approvedRuns: number;
}
