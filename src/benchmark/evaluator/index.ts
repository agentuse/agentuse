export { evaluateCompletion, type CompletionEvalResult } from './completion.js';
export { evaluateArtifacts, type ArtifactsEvalResult, type ArtifactCheckResult } from './artifacts.js';

import { evaluateCompletion } from './completion.js';
import { evaluateArtifacts } from './artifacts.js';
import type { Scenario, TrialResult } from '../types.js';

/**
 * The one verdict for a trial: valid only when the run succeeded and both the
 * output check and every artifact expectation pass. Artifacts are read from
 * `workspace`, the directory the agent ran in.
 */
export async function evaluateTrial(
  trial: TrialResult,
  scenario: Scenario,
  workspace: string
): Promise<TrialResult> {
  if (!trial.execution.success) {
    return { ...trial, output: { ...trial.output, valid: false } };
  }

  let valid = true;
  const details: string[] = [];

  if (scenario.expected.output) {
    const outputResult = await evaluateCompletion(trial.output.text, scenario.expected.output);
    valid = outputResult.valid;
    if (outputResult.details) details.push(outputResult.details);
  }

  let artifacts = trial.artifacts;
  if (scenario.expected.artifacts && scenario.expected.artifacts.length > 0) {
    const artifactResult = await evaluateArtifacts(scenario.expected.artifacts, workspace);
    artifacts = {
      checked: artifactResult.checked,
      passed: artifactResult.passed,
      details: artifactResult.details.map((d) => ({
        path: d.path,
        exists: d.exists,
        containsMatch: d.containsMatch,
      })),
    };
    valid = valid && artifactResult.valid;
    if (!artifactResult.valid) {
      const failed = artifactResult.details.filter((d) => !d.containsMatch).map((d) => d.path);
      details.push(`Artifact failures: ${failed.join(', ')}`);
    }
  }

  return {
    ...trial,
    artifacts,
    output: {
      text: trial.output.text,
      valid,
      ...(details.length > 0 && { validationDetails: details.join(' | ') }),
    },
  };
}
