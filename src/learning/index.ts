/**
 * Learning module - extract and apply learnings from agent executions
 * @experimental This feature is experimental and may change in future versions.
 */

import ora from 'ora';
import type { AgentCompleteEvent } from '../plugin/types';
import type { ApprovalReview, LearningCategory, LearningConfig, LearningOutcome, LearningSource } from './types';
import { evaluateExecution, refineManualLearning } from './evaluator';
import { LearningStore } from './store';
import { partitionLearnings } from './ranking';
import { logger } from '../utils/logger';

export interface ExtractLearningsOptions {
  event: AgentCompleteEvent;
  agentInstructions: string;
  agentModel: string;
  agentFilePath: string;
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
    const store = LearningStore.fromAgentFile(agentFilePath, config.file);
    const stored = await store.load();

    // Deduplicate against the learnings the model was ACTUALLY given, not the
    // whole file. Anything past the injection cap is dormant: it had no effect on
    // this run, so a reviewer re-asserting it is new information, not a
    // duplicate. Passing the full file here is what silently discarded repeat
    // corrections; addOrEscalate below then folds a genuine repeat onto the
    // existing entry instead of appending a near-copy.
    const { injected } = partitionLearnings(stored);

    const learnings = await evaluateExecution(
      event,
      agentInstructions,
      agentModel,
      config.criteria,
      injected,
      reviews,
    );

    if (learnings.length === 0) {
      spinner.succeed('No new learnings extracted');
      return { status: 'none', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [] };
    }

    if (options.sessionId) {
      for (const l of learnings) l.sessionId = options.sessionId;
    }
    const { inserted, escalated } = await store.addOrEscalate(learnings);
    const persisted = [...inserted, ...escalated];

    // Report what landed, not what the evaluator proposed. The old code reported
    // the evaluator's count before the store dropped similars, so the session
    // marker could claim "Learned 2 lessons" when nothing was written.
    if (persisted.length === 0) {
      spinner.succeed('No new learnings extracted');
      return { status: 'none', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [] };
    }

    const reasserted = escalated.length > 0 ? `, ${escalated.length} re-asserted` : '';
    spinner.succeed(`Extracted ${persisted.length} learning(s)${reasserted} → ${store.filePath}`);
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

function manualLearningTitle(instruction: string): string {
  const firstLine = instruction.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';
  if (!firstLine) return 'Manual rule';
  const chars = Array.from(firstLine); // code points, not UTF-16 units
  return chars.length > 80 ? `${chars.slice(0, 77).join('').trim()}...` : firstLine;
}

export async function saveManualLearning(options: {
  agentFilePath: string;
  /** Optional: only used to resolve a custom learnings-file path. A manual rule
   *  is a human opt-in, so saving it needs no learning config. */
  config?: LearningConfig | undefined;
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

  const store = LearningStore.fromAgentFile(options.agentFilePath, options.config?.file);

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

  await store.upsertManual({
    id: '',
    category,
    title,
    instruction,
    confidence: 1,
    appliedCount: 0,
    extractedAt: new Date().toISOString(),
    source: 'manual',
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });

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

export { LearningStore, resolveLearningFilePath, generateLearningId } from './store';
export { MAX_INJECTED_LEARNINGS, learningSourceRank, partitionLearnings, rankLearnings } from './ranking';
export type { ApprovalReview, Learning, LearningConfig, LearningOutcome, LearningSource } from './types';
export { LearningConfigSchema } from './types';
