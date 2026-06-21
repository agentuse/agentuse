/**
 * Learning module - extract and apply learnings from agent executions
 * @experimental This feature is experimental and may change in future versions.
 */

import ora from 'ora';
import type { AgentCompleteEvent } from '../plugin/types';
import type { ApprovalReview, LearningConfig, LearningOutcome } from './types';
import { evaluateExecution } from './evaluator';
import { LearningStore } from './store';
import { logger } from '../utils/logger';

export interface ExtractLearningsOptions {
  event: AgentCompleteEvent;
  agentInstructions: string;
  agentModel: string;
  agentFilePath: string;
  config: LearningConfig;
  /** Reviewer comments from this run's approval gates (paired with the work). */
  reviews?: ApprovalReview[];
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
    // Load existing learnings to avoid duplicates
    const store = LearningStore.fromAgentFile(agentFilePath, config.file);
    const existingLearnings = await store.load();

    const learnings = await evaluateExecution(
      event,
      agentInstructions,
      agentModel,
      config.criteria,
      existingLearnings,
      reviews,
    );

    if (learnings.length === 0) {
      spinner.succeed('No new learnings extracted');
      return { status: 'none', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [] };
    }

    await store.add(learnings);
    spinner.succeed(`Extracted ${learnings.length} learning(s) → ${store.filePath}`);
    // A run can yield both reviewer-sourced and execution-sourced learnings;
    // label the marker by the higher-signal source when any is present.
    const source = learnings.some(l => l.source === 'approval') ? 'approval' : 'auto';
    return {
      status: 'captured',
      source,
      count: learnings.length,
      titles: learnings.map(l => l.title),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    spinner.fail('Failed to extract learnings');
    logger.debug(`[Learning] Error: ${detail}`);
    return { status: 'failed', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [], detail };
  }
}

/**
 * Render a learning capture outcome (or persisted learning marker) into a
 * one-line title + message for the session log. Shared by the CLI session view
 * and the serve web log so both read identically.
 */
export function describeLearningOutcome(o: {
  status: 'captured' | 'none' | 'failed';
  source: 'auto' | 'approval';
  count: number;
  titles?: string[] | undefined;
  detail?: string | undefined;
}): { title: string; message: string } {
  const sourceLabel = o.source === 'approval' ? 'from reviewer comment' : 'from this run';
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

export { LearningStore, resolveLearningFilePath } from './store';
export type { ApprovalReview, Learning, LearningConfig, LearningOutcome } from './types';
export { LearningConfigSchema } from './types';
