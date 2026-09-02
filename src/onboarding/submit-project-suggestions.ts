import type { Tool } from 'ai';
import { z } from 'zod';
import {
  parseProjectDiscoveryResponse,
  type ExistingProjectAgentSummary,
  type ProjectDiscoveryResult,
} from '../agents/discover.js';
import { STRUCTURED_DELIVERY_CHECKPOINT } from '../runner/effect-wal.js';
import type { EffectAuditSink } from '../tools/types.js';

export const SUBMIT_PROJECT_SUGGESTIONS_TOOL = 'submit_project_suggestions';

export const SUBMIT_PROJECT_SUGGESTIONS_NUDGE_PROMPT =
  '[runtime] The submit_project_suggestions tool is available in this session. ' +
  'Use the project evidence already gathered in this conversation and call it now with exactly three suggestions. ' +
  'Do not write JSON or prose and do not call report_incomplete. The runtime validates the submission immediately.';

export interface ProjectSuggestionsSubmission {
  result?: ProjectDiscoveryResult;
}

export interface ProjectSuggestionsSubmissionContract {
  projectName: string;
  inspectedFiles: number;
  existingAgents: ExistingProjectAgentSummary[];
}

export function projectSuggestionsSubmissionContract(
  metadata: Record<string, unknown> | undefined,
): ProjectSuggestionsSubmissionContract | undefined {
  if (metadata?.internal !== true || metadata.onboarding !== 'project-discovery') return undefined;
  const projectName = metadata.projectName;
  const inspectedFiles = metadata.inspectedFiles;
  const existingAgents = metadata.existingAgents;
  if (typeof projectName !== 'string' || !projectName.trim()) return undefined;
  if (typeof inspectedFiles !== 'number' || !Number.isSafeInteger(inspectedFiles) || inspectedFiles < 0) return undefined;
  if (!Array.isArray(existingAgents)) return undefined;
  const parsedExistingAgents: ExistingProjectAgentSummary[] = [];
  for (const entry of existingAgents) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const value = entry as Record<string, unknown>;
    if (typeof value.path !== 'string' || typeof value.name !== 'string' || typeof value.description !== 'string') return undefined;
    parsedExistingAgents.push({ path: value.path, name: value.name, description: value.description });
  }
  return { projectName, inspectedFiles, existingAgents: parsedExistingAgents };
}

const DUPLICATE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'agent', 'daily', 'for', 'in', 'of', 'on', 'project', 'the', 'to', 'weekly', 'with',
]);

function responsibilityTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/gu)?.filter((token) =>
    token.length > 2 && !DUPLICATE_STOP_WORDS.has(token)
  ) ?? []);
}

function substantiallyDuplicatesExistingAgent(
  suggestion: { name: string; description: string },
  existing: ExistingProjectAgentSummary,
): boolean {
  const suggestedName = suggestion.name.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  const existingName = existing.name.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  if (suggestedName === existingName) return true;
  const proposed = responsibilityTokens(`${suggestion.name} ${suggestion.description}`);
  const covered = responsibilityTokens(`${existing.name} ${existing.description}`);
  if (proposed.size === 0 || covered.size === 0) return false;
  let overlap = 0;
  for (const token of proposed) if (covered.has(token)) overlap += 1;
  return overlap >= 2 && overlap / Math.min(proposed.size, covered.size) >= 0.6;
}

const suggestionSchema = z.object({
  name: z.string().min(1).max(120).describe('Concise ASCII agent name.'),
  description: z.string().min(1).max(240).describe('One concrete recurring outcome.'),
  objective: z.string().min(1).max(8_000).describe(
    'Complete production prompt stating what to inspect, what judgment to make, any action to take, the approval boundary for consequential actions, and what concise result to return.'
  ),
  schedule: z.string().min(1).max(100).describe('Valid five-field cron expression.'),
  evidence: z.array(z.string().min(1).max(180)).min(1).max(3).describe(
    'One to three specific paths or project signals actually inspected.'
  ),
}).strict();

/** Structured, discovery-only handoff validated inside the model turn. */
export function createSubmitProjectSuggestionsTool(
  submission: ProjectSuggestionsSubmission,
  contract: ProjectSuggestionsSubmissionContract,
  recoverySink?: EffectAuditSink,
): Tool {
  return {
    description:
      'Submit the final project analysis and exactly three evidence-backed recurring agent suggestions. ' +
      'This is the only accepted handoff for onboarding project discovery. The host validates every field and schedule immediately. ' +
      'If rejected, correct the reported problem and call this tool again. After acceptance, call report_complete with a short headline.',
    inputSchema: z.object({
      summary: z.string().min(1).max(320).describe('One sentence describing the project and its current work.'),
      suggestions: z.array(suggestionSchema).length(3).describe(
        'Exactly three distinct suggestions, ordered by likely usefulness.'
      ),
    }).strict(),
    execute: async (input: { summary: string; suggestions: Array<z.infer<typeof suggestionSchema>> }) => {
      try {
        for (const suggestion of input.suggestions) {
          const duplicate = contract.existingAgents.find((existing) =>
            substantiallyDuplicatesExistingAgent(suggestion, existing)
          );
          if (duplicate) {
            throw new Error(
              `Suggestion ${suggestion.name} duplicates the existing agent ${duplicate.name}. ` +
              'Replace it with a materially distinct responsibility.'
            );
          }
        }
        submission.result = parseProjectDiscoveryResponse(
          JSON.stringify(input),
          contract.projectName,
          contract.inspectedFiles,
        );
        recoverySink?.checkpoint?.(STRUCTURED_DELIVERY_CHECKPOINT, {
          kind: 'project-suggestions',
          result: submission.result,
        });
        return 'Accepted: three valid project suggestions were submitted. Call report_complete now with a short confirmation headline and omit details.';
      } catch (error) {
        throw new Error(`Suggestions rejected: ${(error as Error).message}. Correct the submission and call submit_project_suggestions again.`);
      }
    },
  };
}
