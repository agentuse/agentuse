/**
 * Learning module - extract and apply learnings from agent executions
 * @experimental This feature is experimental and may change in future versions.
 */

import ora from 'ora';
import type { AgentCompleteEvent } from '../plugin/types';
import type { ApprovalReview, LearningCategory, LearningConfig, LearningOutcome, LearningSource } from './types';
import { evaluateExecution, refineManualLearning } from './evaluator';
import { LearningStore } from './store';
import { activeLearnings, effectiveCap } from './ranking';
import { writeLearnedBlock } from './graduate';
import { logger } from '../utils/logger';

export interface ExtractLearningsOptions {
  event: AgentCompleteEvent;
  agentInstructions: string;
  agentModel: string;
  agentFilePath: string;
  /** The agent file's own project root (`resolveProjectContext().stateRoot`),
   *  which decides where the corrections file lives. Deliberately not the
   *  cwd-derived project root: one agent must have one store no matter which
   *  shell the run started from. */
  stateRoot: string;
  config: LearningConfig;
  /** Reviewer comments from this run's approval gates (paired with the work). */
  reviews?: ApprovalReview[];
  /** Session the run belongs to; stamped on captured learnings so the session
   *  view can show only the lessons that run produced. */
  sessionId?: string | undefined;
}

/**
 * Extract learnings from a completed agent execution
 * Called after agent completion when learning.capture is enabled.
 *
 * Returns a {@link LearningOutcome} describing the result (including failures)
 * so the caller can surface a marker in the session log. A failure — e.g. the
 * helper LLM call being rejected — is reported as `status: 'failed'` rather than
 * being swallowed, which previously made learning look like a silent no-op.
 */
export async function extractLearnings(options: ExtractLearningsOptions): Promise<LearningOutcome> {
  const { event, agentInstructions, agentModel, agentFilePath, config } = options;

  // Skip if capture is not enabled (shouldn't happen, but safety check)
  if (!config.capture) return { status: 'none', source: 'auto', count: 0, titles: [] };

  const reviews = options.reviews ?? [];
  const hadReviews = reviews.length > 0;

  const spinner = ora({
    text: 'Extracting learnings...',
    stream: process.stderr,
    spinner: {
      interval: 120,
      frames: ['⋮', '⋰', '⋯', '⋱']
    },
  }).start();

  try {
    const store = LearningStore.fromAgentFile(agentFilePath, options.stateRoot, event.agent.name);
    const stored = await store.load();

    const cap = effectiveCap(config);

    // The evaluator gets the WHOLE active set, not just the slice that fit the
    // injection cap. It is being asked to reconcile — to notice that its new
    // rule restates or contradicts one already stored — and it cannot reconcile
    // against rules it was never shown. Under the cap the two are the same list
    // anyway; they diverge only for a store built before the cap existed, and
    // there the full set is exactly what the reconciling is for.
    const active = activeLearnings(stored);

    // Graduated rules were not injected, but they ARE in force: they live in the
    // agent's own instructions. Omitting them here would have the evaluator
    // re-extract every rule the last tidy-up made permanent, undoing the tidy-up
    // one run later. Passed separately because they are not revisable — only an
    // active rule can be superseded.
    const graduated = stored.filter((l) => l.state === 'graduated');

    const learnings = await evaluateExecution(
      event,
      agentInstructions,
      config.model ?? agentModel,
      config.criteria,
      active,
      reviews,
      { cap, graduated },
    );

    if (learnings.length === 0) {
      spinner.succeed('No new learnings extracted');
      return { status: 'none', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [] };
    }

    if (options.sessionId) {
      for (const l of learnings) l.sessionId = options.sessionId;
    }
    const { inserted, escalated, retired, refused, overCap } = await store.addOrEscalate(
      learnings,
      { cap },
    );
    const persisted = [...inserted, ...escalated];

    // Report what landed, not what the evaluator proposed. The old code reported
    // the evaluator's count before the store dropped similars, so the session
    // marker could claim "Learned 2 lessons" when nothing was written.
    if (persisted.length === 0) {
      spinner.succeed('No new learnings extracted');
      if (refused.length > 0) {
        logger.debug(`[Learning] ${refused.length} auto learning(s) refused: rule set full at ${cap}`);
      }
      return { status: 'none', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [] };
    }

    const reasserted = escalated.length > 0 ? `, ${escalated.length} re-asserted` : '';
    const madeRoom = retired.length > 0 ? `, ${retired.length} retired to stay under ${cap}` : '';
    spinner.succeed(`Extracted ${persisted.length} learning(s)${reasserted}${madeRoom} → ${store.filePath}`);
    if (refused.length > 0) {
      logger.debug(`[Learning] ${refused.length} auto learning(s) refused: rule set full at ${cap}`);
    }

    // Say it at the moment it matters. The user has just corrected the agent and
    // reasonably believes the correction took; if the set is over cap it may not
    // have. A count of what is being ignored, not a scolding about file hygiene.
    warnIfCorrectionsAreIgnored(overCap, cap, agentFilePath);
    // A run can yield both reviewer-sourced and execution-sourced learnings;
    // label the marker by the higher-signal source when any is present.
    const source = persisted.some(l => l.source === 'approval') ? 'approval' : 'auto';
    return {
      status: 'captured',
      source,
      count: persisted.length,
      titles: persisted.map(l => l.title),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    spinner.fail('Failed to extract learnings');
    logger.debug(`[Learning] Error: ${detail}`);
    return { status: 'failed', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [], detail };
  }
}

/**
 * Say, at the moment a human has just corrected the agent, that the correction
 * did not reach it.
 *
 * A full set is supposed to absorb a correction by folding it into an existing
 * rule, which keeps the set at its size. This fires only when that did not
 * happen: the capture model returned a correction without naming a rule to fold
 * it into, and there was no auto-extracted rule left to trade away. The
 * correction was kept rather than dropped, but it landed outside the cap, and
 * rules outside the cap are never injected.
 *
 * So this is not a nag about file hygiene, and it is not routine. It means a
 * specific correction is sitting there having no effect, and the one thing that
 * reliably fixes it is folding the set down by hand.
 *
 * `logger.warn` mirrors into the session log sink, so the same line reaches both
 * the terminal and the serve session view without a second call site.
 */
function warnIfCorrectionsAreIgnored(overCap: number, cap: number, agentFilePath: string): void {
  if (overCap <= 0) return;
  logger.warn(
    `${overCap} correction(s) sit outside this agent's ${cap}-rule limit and do NOT reach it — `
    + `they could not be folded into an existing rule, and no auto-extracted rule was left to trade away. `
    + `Fold the set down: agentuse learnings tidy ${agentFilePath}`
  );
}

function manualLearningTitle(instruction: string): string {
  const firstLine = instruction.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';
  if (!firstLine) return 'Manual rule';
  const chars = Array.from(firstLine); // code points, not UTF-16 units
  return chars.length > 80 ? `${chars.slice(0, 77).join('').trim()}...` : firstLine;
}

export async function saveManualLearning(options: {
  agentFilePath: string;
  /** The agent file's own project root, which decides where the corrections
   *  file lives. See {@link ExtractLearningsOptions.stateRoot}. */
  stateRoot: string;
  instruction: string;
  /** Agent model used to distill the note into a grounded additional
   *  instruction. Omit to store the note verbatim. */
  model?: string | undefined;
  /** Agent instructions — the note becomes an extension of these. */
  agentInstructions?: string | undefined;
  /** A compact transcript of what the agent did this run (its output + tool
   *  calls), so the instruction is grounded in the run the reviewer saw. */
  sessionTranscript?: string | undefined;
  /** Session the rule was added from (absent for agent-level rules). */
  sessionId?: string | undefined;
}): Promise<LearningOutcome> {
  const raw = options.instruction.trim();
  if (!raw) {
    return { status: 'none', source: 'manual', count: 0, titles: [] };
  }

  const store = LearningStore.fromAgentFile(options.agentFilePath, options.stateRoot);

  // Turn the note into a grounded additional instruction, using the agent's own
  // instructions + what it did this run + the already-saved instructions. Any
  // model or parse failure falls back to storing the note verbatim — an explicit
  // human instruction must never be dropped because a helper LLM call hiccuped.
  let category: LearningCategory = 'tip';
  let title = manualLearningTitle(raw);
  let instruction = raw;
  if (options.model) {
    try {
      const existing = await store.load();
      const refined = await refineManualLearning(raw, options.model, {
        agentInstructions: options.agentInstructions,
        sessionTranscript: options.sessionTranscript,
        existingInstructions: existing.map((l) => l.instruction),
      });
      if (refined) {
        category = refined.category;
        title = manualLearningTitle(refined.title);
        instruction = refined.instruction;
      }
    } catch (error) {
      logger.debug(`[Learning] Manual refine failed, storing verbatim: ${(error as Error).message}`);
    }
  }

  const { graduated } = await store.upsertManual({
    id: '',
    category,
    title,
    instruction,
    confidence: 1,
    appliedCount: 0,
    extractedAt: new Date().toISOString(),
    source: 'manual',
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    reasserted: 0,
    approvedRuns: 0,
  });

  // The reviewer re-worded a rule that already lives in the agent file. The
  // store now holds the new wording but the copy actually in force is the one in
  // the agent file, so re-render the block or the correction reaches nothing.
  if (graduated) {
    try {
      const all = await store.load();
      await writeLearnedBlock(options.agentFilePath, all.filter((l) => l.state === 'graduated'));
    } catch (error) {
      logger.debug(`[Learning] Could not refresh the graduated block: ${(error as Error).message}`);
    }
  }

  return { status: 'captured', source: 'manual', count: 1, titles: [title] };
}

/**
 * Render a learning capture outcome (or persisted learning marker) into a
 * one-line title + message for the session log. Shared by the CLI session view
 * and the serve web log so both read identically.
 */
export function describeLearningOutcome(o: {
  status: 'captured' | 'none' | 'failed';
  source: LearningSource;
  count: number;
  titles?: string[] | undefined;
  detail?: string | undefined;
}): { title: string; message: string } {
  const sourceLabel = o.source === 'manual'
    ? 'from manual rule'
    : o.source === 'approval'
      ? 'from reviewer comment'
      : 'from this run';
  if (o.status === 'failed') {
    return {
      title: 'Learning capture failed',
      message: o.detail ? `${o.detail} (${sourceLabel})` : `Capture error (${sourceLabel})`,
    };
  }
  if (o.status === 'none') {
    return { title: 'No new learnings', message: sourceLabel };
  }
  const titles = o.titles && o.titles.length > 0 ? `: ${o.titles.join('; ')}` : '';
  return {
    title: `Learned ${o.count} ${o.count === 1 ? 'lesson' : 'lessons'}`,
    message: `${sourceLabel}${titles}`,
  };
}

export { LearningStore, resolveLearningFilePath, generateLearningId, strandedLearningsFile } from './store';
export { applyLearningMigration, deleteMigrationSource, findAgentFiles, findOrphanedLearningFiles, legacyLearningFilePath, planLearningMigration } from './migrate';
export type { MigrationEntry, MigrationStatus } from './migrate';
export { MAX_INJECTED_LEARNINGS, activeLearnings, effectiveCap, learningSourceRank, partitionLearnings, rankLearnings } from './ranking';
export { LEARNED_BLOCK_START, LEARNED_BLOCK_END, renderLearnedBlock, spliceLearnedBlock, writeLearnedBlock } from './graduate';
export { consolidateLearnings, describeConsolidation, isGraduationEligible, undoConsolidation, readTidyRecord, writeTidyRecord, clearTidyRecord } from './consolidate';
export type { ConsolidationResult, ConsolidationChange, TidyProgress, TidyRecord } from './consolidate';
export type { ApprovalReview, Learning, LearningConfig, LearningDraft, LearningOutcome, LearningSource } from './types';
export { LearningConfigSchema } from './types';
