import ora from 'ora';
import type { AgentCompleteEvent } from '../plugin/types';
import type { LearningConfig } from './types';
import { evaluateExecution } from './evaluator';
import { LearningStore } from './store';
import { logger } from '../utils/logger';

export interface ExtractLearningsOptions {
  event: AgentCompleteEvent;
  agentInstructions: string;
  agentModel: string;
  agentFilePath: string;
  config: LearningConfig;
}

/**
 * Extract learnings from a completed agent execution
 * Called after agent completion when learning.evaluate is enabled
 */
export async function extractLearnings(options: ExtractLearningsOptions): Promise<void> {
  const { event, agentInstructions, agentModel, agentFilePath, config } = options;

  // Skip if evaluate is not enabled (shouldn't happen, but safety check)
  if (!config.evaluate) return;

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
    const store = LearningStore.fromAgentFile(agentFilePath, event.agent.name, config.file);
    const existingLearnings = await store.load();

    const learnings = await evaluateExecution(
      event,
      agentInstructions,
      agentModel,
      config.evaluate,
      existingLearnings,
    );

    if (learnings.length === 0) {
      spinner.succeed('No new learnings extracted');
      return;
    }

    await store.add(learnings);
    spinner.succeed(`Extracted ${learnings.length} learning(s) → ${store.filePath}`);
  } catch (error) {
    spinner.fail('Failed to extract learnings');
    logger.debug(`[Learning] Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { LearningStore, resolveLearningFilePath } from './store';
export type { Learning, LearningConfig } from './types';
export { LearningConfigSchema } from './types';
