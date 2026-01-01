export { evaluateCompletion, type CompletionEvalResult } from './completion.js';
export { evaluateArtifacts, type ArtifactsEvalResult, type ArtifactCheckResult } from './artifacts.js';

import { evaluateCompletion } from './completion.js';
import { evaluateArtifacts } from './artifacts.js';
import type { Scenario, TrialResult } from '../types.js';

/**
 * Full evaluation of a trial result against scenario expectations
 */
export async function evaluateTrial(
  trial: TrialResult,
  scenario: Scenario,
  trialDir: string
): Promise<TrialResult> {
  const updatedTrial = { ...trial };

  // Skip evaluation if execution failed
  if (!trial.execution.success) {
    updatedTrial.output.valid = false;
    return updatedTrial;
  }

  let outputValid = true;
  let outputDetails = '';

  // Evaluate output if validation is specified
  if (scenario.expected.output) {
    const outputResult = await evaluateCompletion(
      trial.output.text,
      scenario.expected.output
    );
    outputValid = outputResult.valid;
    outputDetails = outputResult.details;
  }

  // Evaluate artifacts if specified
  if (scenario.expected.artifacts && scenario.expected.artifacts.length > 0) {
    const artifactResult = await evaluateArtifacts(
      scenario.expected.artifacts,
      trialDir
    );

    updatedTrial.artifacts = {
      checked: artifactResult.checked,
      passed: artifactResult.passed,
      details: artifactResult.details,
    };

    // Overall validity requires both output and artifacts to pass
    outputValid = outputValid && artifactResult.valid;

    if (!artifactResult.valid) {
      const failedArtifacts = artifactResult.details
        .filter((d) => !d.containsMatch)
        .map((d) => d.path);
      outputDetails += ` | Artifact failures: ${failedArtifacts.join(', ')}`;
    }
  }

  updatedTrial.output.valid = outputValid;
  updatedTrial.output.validationDetails = outputDetails.trim();

  return updatedTrial;
}

/**
 * Calculate pass^k metric
 * pass^k = probability of at least one success in k trials
 * pass^k = 1 - (1 - p)^k where p is single-trial success rate
 */
export function calculatePassK(trials: TrialResult[], k: number): number {
  if (trials.length === 0) return 0;

  const successRate =
    trials.filter((t) => t.execution.success && t.output.valid).length /
    trials.length;

  return 1 - Math.pow(1 - successRate, k);
}

/**
 * Calculate consistency score
 * High consistency = low variance in outcomes
 */
export function calculateConsistency(trials: TrialResult[]): number {
  if (trials.length === 0) return 0;

  const outcomes: number[] = trials.map((t) =>
    t.execution.success && t.output.valid ? 1 : 0
  );

  const mean = outcomes.reduce((a: number, b: number) => a + b, 0) / outcomes.length;
  const variance =
    outcomes.reduce((sum: number, val: number) => sum + Math.pow(val - mean, 2), 0) /
    outcomes.length;

  // Consistency is inverse of standard deviation (normalized to 0-1)
  return 1 - Math.sqrt(variance);
}
