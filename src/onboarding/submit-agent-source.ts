import type { Tool } from 'ai';
import { z } from 'zod';
import { validateAuthoredAgentSource } from '../agents/author.js';
import { AgentCreationError } from '../agents/create.js';

export const SUBMIT_AGENT_SOURCE_TOOL = 'submit_agent_source';

export const SUBMIT_AGENT_SOURCE_NUDGE_PROMPT =
  '[runtime] The submit_agent_source tool is available in this session. Your preceding claim that it was missing or unavailable was incorrect. ' +
  'Use the work and project context already in this conversation to produce the complete .agentuse file now, then call submit_agent_source with that source. ' +
  'Do not write prose and do not call report_incomplete. This recovery turn exposes only submit_agent_source, and the runtime will validate the source immediately.';

export interface AgentSourceSubmission {
  source?: string;
  model?: string;
}

export interface AgentSourceSubmissionContract {
  requestedName: string;
  requestedSchedule: string;
  availableModels: string[];
}

/**
 * Read the private contract carried by the in-memory onboarding creator. The
 * metadata is authored by the host, not inferred from model output, and keeps
 * this specialized tool out of ordinary AgentUse runs.
 */
export function agentSourceSubmissionContract(metadata: Record<string, unknown> | undefined): AgentSourceSubmissionContract | undefined {
  if (metadata?.internal !== true || metadata.onboarding !== 'agent-creator') return undefined;
  const requestedName = metadata.requestedName;
  const requestedSchedule = metadata.requestedSchedule;
  const availableModels = metadata.availableModels;
  if (typeof requestedName !== 'string' || typeof requestedSchedule !== 'string') return undefined;
  if (!Array.isArray(availableModels) || !availableModels.every((model) => typeof model === 'string')) return undefined;
  return { requestedName, requestedSchedule, availableModels };
}

/**
 * A creator-only structured handoff. Validation happens inside the tool call,
 * so a rejected draft returns to the model as a tool error while the same
 * session still has project context and steps available for a correction.
 */
export function createSubmitAgentSourceTool(
  submission: AgentSourceSubmission,
  contract: AgentSourceSubmissionContract,
): Tool {
  return {
    description:
      'Submit the complete AgentUse file you authored. This is the only accepted handoff for the onboarding creator. ' +
      'The host validates the file immediately; if the call is rejected, correct the reported problem and call this tool again. ' +
      'After it is accepted, call report_complete with a short headline and no source in details.',
    inputSchema: z.object({
      source: z.string().min(1).max(64_000).describe(
        'The complete raw .agentuse file as one string. It must begin with --- and contain parser-valid YAML frontmatter followed by the Markdown instruction body. Do not use a code fence or add commentary.'
      ),
    }).strict(),
    execute: async ({ source }: { source: string }) => {
      try {
        const authored = validateAuthoredAgentSource(
          source,
          contract.availableModels,
          contract.requestedName,
          contract.requestedSchedule,
        );
        submission.source = authored.source;
        submission.model = authored.model;
        return 'Accepted: the AgentUse source is valid. Call report_complete now with a short confirmation headline and omit details.';
      } catch (error) {
        if (error instanceof AgentCreationError) {
          throw new Error(`Source rejected: ${error.message}. Correct the source and call submit_agent_source again.`);
        }
        throw error;
      }
    },
  };
}
