import { z } from 'zod';

/**
 * A capture channel whose records are verified structurally in code, not by
 * prompt. `tool-errors` is the first and only launch entry: a failed tool call
 * followed by a corrected call and a confirmed success, all present in the
 * trace, or the candidate is never stored.
 */
export type CaptureAddon = 'tool-errors';

/**
 * Canonical automatic-capture config. Deliberate human learning through the
 * Learn checkbox, `--remember`, and manual add is a separate path: a reviewer
 * explicitly selects what becomes durable. Everything here is opt-in
 * observation of a run without that per-comment choice:
 * - `addons`: typed channels verified structurally in code.
 * - `custom`: scoped free-form observation capture via the built-in evaluator.
 * - `agent`: an .agentuse file replaces the built-in evaluator (the same
 *   pattern as `verify.judge`). Its output still passes the common vet.
 */
export interface CanonicalCaptureConfig {
  addons: readonly CaptureAddon[];
  custom?: string | undefined;
  agent?: string | undefined;
}

/**
 * Canonical learning config. `capture` writes vetted lessons to the store;
 * `apply` injects stored, vetted, active lessons into the system prompt before
 * each run.
 */
export interface CanonicalLearningConfig {
  capture: false | CanonicalCaptureConfig;
  apply: boolean;
  max?: number | undefined;      // injected-per-run cap (default MAX_INJECTED_LEARNINGS)
  model?: string | undefined;    // model for helper calls (capture + vet + tidy); defaults to the agent's
}

/** Whether this config opts into observing a run without a human choosing
 * Learn. Kept as one shared predicate so shorthand/default configs cannot
 * accidentally start automatic capture in a new caller. */
export function hasAutomaticLearningCapture(config: CanonicalLearningConfig | undefined): boolean {
  const capture = config?.capture;
  return Boolean(
    capture
    && (capture.addons.length > 0 || capture.custom !== undefined || capture.agent !== undefined),
  );
}

const CaptureObjectSchema = z
  .object({
    addons: z.array(z.enum(['tool-errors'])).default([]),
    custom: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Same message style as verify's criteria/judge conflict: a contradiction
    // the parser cannot resolve is a hard error, never a silent pick.
    if (value.custom && value.agent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'set either "custom" (built-in evaluator) or "agent" (agent file), not both',
      });
    }
  });

/**
 * `capture: true` still parses, but its meaning narrowed in 0.19: it used to
 * mean free-form auto-capture; it now enables no automatic observation
 * channels. Human feedback becomes durable only through Learn/--remember.
 * Free-form observation capture is unreachable without explicitly writing
 * `custom` or `agent`. An empty object is the same as `true`.
 *
 * `true` is normalized by preprocess rather than a union branch with a
 * `.transform`: a transform inside a union collapses every branch error to
 * "Invalid input", losing the named-key messages the strict object produces.
 */
const CaptureSchema = z.preprocess(
  (value) => (value === true ? {} : value),
  z.union([z.literal(false), CaptureObjectSchema]),
);

const CanonicalLearningSchema = z
  .object({
    capture: CaptureSchema.default(true),
    apply: z.boolean().default(true),
    // Removed in 0.19, declared only to reject it with a mapping the author can
    // act on. The one faithful mapping (`capture.custom`) would keep free-form
    // policy capture alive automatically — exactly what the redesign exists to
    // stop — so the author must consciously rewrite it.
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
    // Helper calls (capture, vet, tidy) run on the agent's own model by default:
    // whatever provider and auth the agent already works with is guaranteed to
    // work here too, and the model that will later FOLLOW these instructions is
    // the right one to write them. Override for an agent deliberately running a
    // cheap tier for high-volume work — you probably don't want that tier
    // deciding which corrections become permanent.
    model: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.criteria !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"criteria" was removed — free-form capture is opt-in now. To restore scoped free-form capture, move it to capture: { custom: "..." }',
      });
    }
  });

/**
 * Config schema for the learning feature in agent config.
 * Accepts `learning: true` (apply deliberate human learnings; automatic
 * observation off) or the canonical object. The boolean sugar is normalized by preprocess, not a union
 * branch — see the note on {@link CaptureSchema}.
 *
 * The pre-0.15 `{ evaluate, apply? }` shape is gone: `.strict()` on the
 * canonical schema rejects it by name rather than accepting and ignoring it.
 */
export const LearningConfigSchema: z.ZodType<CanonicalLearningConfig, z.ZodTypeDef, unknown> = z.preprocess(
  (value) => (value === true ? {} : value),
  CanonicalLearningSchema,
);

export type LearningConfig = CanonicalLearningConfig;

/**
 * One-time upgrade notices for legacy `learning:` forms whose faithful mapping
 * is strictly SAFER than what the author had — these warn and continue, per the
 * dividing rule: hard-error only when honoring the key would resurrect risky
 * behavior (that path lives in the schema above as the `criteria` parse error).
 *
 * Called on the RAW frontmatter (before zod normalizes the sugar away) by the
 * parser (warn once per agent) and by `agentuse doctor` (echoed every run, so
 * the mapping stays discoverable after the one warning scrolled away).
 */
export function legacyLearningConfigNotices(rawLearning: unknown): string[] {
  const notices: string[] = [];
  if (rawLearning === true) {
    notices.push(
      'learning: true now learns human feedback only when the reviewer explicitly chooses Learn (or uses --remember); ordinary comments stay with the current run. Free-form auto-capture no longer runs. '
      + 'Explicit form: learning: { capture: true, apply: true }. '
      + 'To restore scoped free-form capture, set capture: { custom: "..." }',
    );
  } else if (
    rawLearning !== null
    && typeof rawLearning === 'object'
    && (rawLearning as { capture?: unknown }).capture === true
  ) {
    notices.push(
      'learning.capture: true enables no automatic observation channels. Human feedback is saved only through Learn/--remember; free-form auto-capture no longer runs. '
      + 'To restore scoped free-form capture, set capture: { custom: "..." }',
    );
  }
  return notices;
}

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

/** What one capture channel did in one pass. `captured` counts what became (or
 *  refreshed) an active rule; `vettedOut` counts candidates the vet rejected
 *  outright; `quarantined` counts candidates stored but set aside with a
 *  reason. Junk production per channel is measurable, not anecdotal. */
export interface ChannelCounts {
  captured: number;
  vettedOut: number;
  quarantined: number;
}

export interface LearningOutcome {
  status: LearningOutcomeStatus;
  source: LearningSource;
  count: number;       // lessons captured this run
  titles: string[];    // titles of captured lessons (for the log message)
  detail?: string;     // error message when status is 'failed'
  /** Per-channel counts for this pass. Absent when the pass never ran. */
  channels?: Partial<Record<LearningChannel, ChannelCounts>>;
  /** Candidates quarantined this pass, re-vetted stored entries included. */
  quarantined?: number;
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
 * - quarantined: failed the vet (contradicts the contract, duplicates it, or is
 *   unsupported by the trace it was captured from). Never injected, never
 *   deleted; kept visible with its reason in the CLI, serve UI, and doctor.
 *
 * Absent on files written before the lifecycle existed, which load as active.
 */
export type LearningState = 'active' | 'graduated' | 'retired' | 'quarantined';

/**
 * Which capture channel produced a learning.
 * - corrections: human feedback explicitly saved through Learn, --remember, or manual add
 * - tool-errors: typed, structurally-verified recovery records
 * - custom: scoped free-form capture via the built-in evaluator
 * - agent: free-form capture via a replacement evaluator agent
 * Absent on entries written before channels existed (legacy free-form).
 */
export type LearningChannel = 'corrections' | 'tool-errors' | 'custom' | 'agent';

/**
 * Learning item stored in markdown
 */
export interface Learning {
  id: string;           // Short ID (8 chars)
  category: LearningCategory;
  title: string;        // One-line summary
  instruction: string;  // The actual learning text
  confidence: number;   // 0-1
  /**
   * Times injected into a run's prompt. Renamed from `appliedCount`, and the
   * old name must never come back: injection counts COST, not value, and
   * presenting it as evidence a learning worked is exactly the confusion the
   * rename exists to end. `approvedRuns` is the effectiveness signal.
   * Existing store files carrying `applied:` load through a read-alias.
   */
  injectedCount: number;
  extractedAt: string;  // ISO date
  source: LearningSource; // Provenance (defaults to 'auto' for legacy files)
  sessionId?: string;   // Session the learning was captured in (absent for legacy files and agent-level manual rules)
  state?: LearningState; // Lifecycle position; absent means active
  /** Capture channel; absent on entries written before channels existed. */
  channel?: LearningChannel;
  /**
   * Hash of the effective agent instructions this learning was captured (or
   * last re-vetted) against. A mismatch at injection time means the contract
   * changed since: the learning is stale and is re-vetted rather than silently
   * injected against a contract it has never seen. Absent on legacy entries,
   * which stay injectable until the first capture or tidy backfills it.
   */
  instructionsHash?: string;
  /** Why the vet quarantined this entry. Present only when state is 'quarantined'. */
  quarantineReason?: string;
  /** tool-errors channel: the tool whose failed call was recovered. */
  tool?: string;
  /** tool-errors channel: normalized failure signature; with `tool`, the
   *  structural dedupe key — a matching (tool, signature) pair supersedes. */
  failureSignature?: string;
  /** One-line evidence trail (e.g. the failed and corrected calls). */
  evidence?: string;
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
