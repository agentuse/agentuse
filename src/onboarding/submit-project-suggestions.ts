import type { Tool } from 'ai';
import { z } from 'zod';
import {
  parseProjectDiscoveryResponse,
  type ProjectDiscoveryResult,
} from '../agents/discover.js';

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
}

export function projectSuggestionsSubmissionContract(
  metadata: Record<string, unknown> | undefined,
): ProjectSuggestionsSubmissionContract | undefined {
  if (metadata?.internal !== true || metadata.onboarding !== 'project-discovery') return undefined;
  const projectName = metadata.projectName;
  const inspectedFiles = metadata.inspectedFiles;
  if (typeof projectName !== 'string' || !projectName.trim()) return undefined;
  if (typeof inspectedFiles !== 'number' || !Number.isSafeInteger(inspectedFiles) || inspectedFiles < 0) return undefined;
  return { projectName, inspectedFiles };
}

const suggestionSchema = z.object({
  name: z.string().min(1).max(120).describe('Concise ASCII agent name.'),
  description: z.string().min(1).max(240).describe('One concrete recurring outcome.'),
  objective: z.string().min(1).max(8_000).describe(
    'Complete production prompt stating what to inspect, what judgment to make, and what concise result to return.'
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
        submission.result = parseProjectDiscoveryResponse(
          JSON.stringify(input),
          contract.projectName,
          contract.inspectedFiles,
        );
        return 'Accepted: three valid project suggestions were submitted. Call report_complete now with a short confirmation headline and omit details.';
      } catch (error) {
        throw new Error(`Suggestions rejected: ${(error as Error).message}. Correct the submission and call submit_project_suggestions again.`);
      }
    },
  };
}
