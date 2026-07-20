import { z } from 'zod';

/**
 * Canonical verify config. The judge evaluates the run's final output before
 * it ships; on a failed verdict the runner injects the critique as a synthetic
 * user turn and lets the agent redo the output in-session, up to `maxRedos`.
 *
 * Evaluator selection (exactly one):
 * - `criteria` (or none): the built-in one-shot judge scores the output
 *   against the rubric (a generic task-fulfillment rubric when omitted).
 * - `judge`: another .agentuse file acts as the evaluator, resolved relative
 *   to the verifying agent's file. Its own frontmatter governs model/tools.
 */
/**
 * Where the judge runs:
 * - `gate`: judge each `await_human` payload BEFORE the run suspends. A failed
 *   verdict returns a rejection-with-comment tool result (the same protocol as
 *   a human rejection), so the agent revises and re-gates without the human
 *   ever seeing the draft. After `maxRedos` rejections the gate fails OPEN to
 *   the human with the unresolved critique logged.
 * - `output`: judge the run's final output before it ships (post-run).
 * - `both`: both placements.
 * Default: `gate` when the agent has an approval gate, `output` otherwise.
 */
export type VerifyPlacement = 'gate' | 'output' | 'both';

export interface CanonicalVerifyConfig {
  criteria?: string | undefined;
  judge?: string | undefined;
  at?: VerifyPlacement | undefined;
  maxRedos: number;
  model?: string | undefined; // built-in judge model override; invalid with `judge`
}

const CanonicalVerifySchema = z
  .object({
    criteria: z.string().min(1).optional(),
    judge: z.string().min(1).optional(),
    at: z.enum(['gate', 'output', 'both']).optional(),
    maxRedos: z.number().int().min(0).max(10).default(1),
    model: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.criteria && value.judge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verify: set either "criteria" (built-in judge) or "judge" (agent file), not both',
      });
    }
    if (value.judge && value.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verify: "model" configures the built-in judge and cannot be combined with "judge" (the judge agent declares its own model)',
      });
    }
  });

/**
 * Config schema for the verify feature in agent config.
 * Accepts `verify: true` (generic rubric), a criteria string shorthand,
 * or the canonical object.
 */
export const VerifyConfigSchema = z.union([
  z.literal(true).transform((): CanonicalVerifyConfig => ({ maxRedos: 1 })),
  z
    .string()
    .min(1)
    .transform((criteria): CanonicalVerifyConfig => ({ criteria, maxRedos: 1 })),
  CanonicalVerifySchema,
]);

export type VerifyConfig = z.infer<typeof VerifyConfigSchema>;

/**
 * A judge verdict. On `pass: false` the critique must be concrete enough to
 * act on in one revision — it is injected verbatim into the redo turn.
 */
export interface VerifyVerdict {
  pass: boolean;
  critique?: string;
}
