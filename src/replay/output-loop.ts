import { createHash } from 'node:crypto';
import { z } from 'zod';

export const outputJudgmentSchema = z.object({
  pass: z.boolean(),
  understanding: z.string().min(1),
  critique: z.string(),
}).strict().refine(value => value.pass || value.critique.trim().length > 0, { message: 'A failure needs a substantive critique', path: ['critique'] });
export const instructionRevisionSchema = z.object({
  guidance: z.string().min(1).max(3000),
  reason: z.string().min(1),
}).strict();
export type OutputJudgment = z.infer<typeof outputJudgmentSchema>;
export type InstructionRevision = z.infer<typeof instructionRevisionSchema>;
export interface OutputRound {
  round: number;
  guidance: string;
  guidanceSha256: string;
  output: string;
  judgment: OutputJudgment;
  revision?: InstructionRevision;
}
export type OutputLoopResult = { status: 'passed' | 'exhausted' | 'stalled'; rounds: OutputRound[] };
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Fresh output each round. Only revised instructions cross the generator
 * boundary; prior drafts and critique stay with the evaluator/reviser. */
export async function runOutputLoop(options: {
  maxRounds: number;
  generate: (request: { round: number; guidance: string }) => Promise<string>;
  evaluate: (output: string, round: number) => Promise<OutputJudgment>;
  revise: (request: { round: number; guidance: string; output: string; judgment: OutputJudgment }) => Promise<InstructionRevision>;
  saveRound: (round: OutputRound) => Promise<void>;
}): Promise<OutputLoopResult> {
  if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 10) throw new Error('maxRounds must be an integer from 1 to 10');
  const rounds: OutputRound[] = [];
  let guidance = '';
  for (let round = 1; round <= options.maxRounds; round++) {
    const output = (await options.generate({ round, guidance })).trim();
    if (!output) throw new Error(`Round ${round} generated no output`);
    const judgment = outputJudgmentSchema.parse(await options.evaluate(output, round));
    const entry: OutputRound = { round, guidance, guidanceSha256: sha256(guidance), output, judgment };
    rounds.push(entry);
    await options.saveRound(entry);
    if (judgment.pass) return { status: 'passed', rounds };
    if (round === options.maxRounds) return { status: 'exhausted', rounds };
    const revision = instructionRevisionSchema.parse(await options.revise({ round, guidance, output, judgment }));
    entry.revision = revision;
    await options.saveRound(entry);
    if (revision.guidance.trim() === guidance.trim()) return { status: 'stalled', rounds };
    guidance = revision.guidance;
  }
  throw new Error('Unreachable loop state');
}
