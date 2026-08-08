import { z } from 'zod';

/**
 * Canonical learning config. `capture` writes lessons to the store (from
 * self-evaluation and from approval-gate comments); `apply` injects stored
 * lessons into the system prompt before each run.
 */
export interface CanonicalLearningConfig {
  capture: boolean;
  apply: boolean;
  criteria?: string; // optional guidance for the capture evaluator
  max?: number;      // injected-per-run cap (default MAX_INJECTED_LEARNINGS)
  model?: string;    // model for helper calls (capture + tidy); defaults to the agent's
}

const CanonicalLearningSchema = z
  .object({
    capture: z.boolean().default(true),
    apply: z.boolean().default(true),
    criteria: z.string().optional(),
    // No `file:` key. The corrections file is generated state with one computed
    // location (see resolveLearningFilePath); the supported way to get rules
    // into git is to let them graduate into the agent file. `.strict()` below
    // rejects it outright rather than accepting and ignoring it.
    //
    // How many rules this agent KEEPS, not merely how many of a larger pile get
    // injected. Capture enforces it at write time (see
    // `LearningStore.addOrEscalate`), so a full set forces a choice — supersede
    // an existing rule, or drop an auto-captured one — instead of appending a
    // near-copy nobody ever compares against the rest.
    //
    // Bounded on purpose: the cap keeps the guideline block from crowding out
    // the agent's own instructions, and every injected learning is paid for on
    // every model request. `agentuse doctor` prints the token cost next to the
    // count so raising it shows its own price.
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
 * Accepts `learning: true` (sugar for capture + apply) or the canonical object.
 *
 * The pre-0.15 `{ evaluate, apply? }` shape is gone: `evaluate` was only ever
 * translated into `capture` (true) / `criteria` (string), so there is nothing
 * left to carry. `.strict()` on the canonical schema rejects it by name rather
 * than accepting and ignoring it.
 */
export const LearningConfigSchema = z.union([
  z.literal(true).transform((): CanonicalLearningConfig => ({ capture: true, apply: true })),
  CanonicalLearningSchema,
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

/**
 * A learning on its way into the store, before the store has decided what to do
 * with it.
 *
 * Separate from {@link Learning} because `supersedes` is an instruction TO the
 * store, not a property OF the rule: it names the entry this draft is meant to
 * replace. Once the draft lands the relationship is already expressed — the
 * named entry is retired, the draft is active — so there is nothing left to
 * persist, and keeping the field off {@link Learning} is what guarantees the
 * serializer can never write a dangling id into a corrections file.
 */
export interface LearningDraft extends Learning {
  /**
   * Id of an existing ACTIVE entry this draft replaces.
   *
   * Set by the capture evaluator when the rule set is full. It covers both moves
   * the evaluator is allowed to make: folding (the named rule is about the same
   * thing and the new wording covers both) and eviction (the named rule is the
   * least valuable one and is being traded away for this one). The store treats
   * them identically — retire the named entry, insert this one — so the archive
   * records what was given up either way.
   *
   * Ignored when it names a graduated, retired, or unknown entry, or one whose
   * source outranks the draft's: a weaker source never evicts a stronger one.
   */
  supersedes?: string;
}
