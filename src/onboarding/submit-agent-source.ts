import type { Tool } from 'ai';
import { z } from 'zod';
import { validateAuthoredAgentSource } from '../agents/author.js';
import { AgentCreationError, validateAgentFileName, validateAgentName } from '../agents/create.js';

export const SUBMIT_AGENT_SOURCE_TOOL = 'submit_agent_source';

export const SUBMIT_AGENT_SOURCE_NUDGE_PROMPT =
  '[runtime] The submit_agent_source tool is available in this session. Your preceding claim that it was missing or unavailable was incorrect. ' +
  'Use the work and project context already in this conversation to choose a human-facing name, a separate lowercase kebab-case .agentuse filename, and the complete file now, then call submit_agent_source with all three values. ' +
  'Do not write prose and do not call report_incomplete. This recovery turn exposes only submit_agent_source, and the runtime will validate the source immediately.';

export interface AgentSourceSubmission {
  source?: string;
  name?: string;
  fileName?: string;
  model?: string;
}

export interface AgentSourceSubmissionContract {
  requestedName?: string;
  requestedSchedule?: string;
  availableModels: string[];
  availableSkills?: string[];
}

/**
 * Read the private contract carried by the in-memory creator agent. The
 * metadata is authored by the host, not inferred from model output, and keeps
 * this specialized tool out of ordinary AgentUse runs.
 */
export function agentSourceSubmissionContract(metadata: Record<string, unknown> | undefined): AgentSourceSubmissionContract | undefined {
  const isCreator = metadata?.internal === true
    && (metadata.creator === 'agent' || metadata.onboarding === 'agent-creator');
  if (!isCreator) return undefined;
  const requestedName = metadata.requestedName;
  const requestedSchedule = metadata.requestedSchedule;
  const availableModels = metadata.availableModels;
  if (requestedName !== undefined && typeof requestedName !== 'string') return undefined;
  if (requestedSchedule !== undefined && typeof requestedSchedule !== 'string') return undefined;
  if (!Array.isArray(availableModels) || !availableModels.every((model) => typeof model === 'string')) return undefined;
  const availableSkills = metadata.availableSkills;
  if (availableSkills !== undefined && (!Array.isArray(availableSkills) || !availableSkills.every((skill) => typeof skill === 'string'))) return undefined;
  return {
    ...(requestedName && { requestedName }),
    ...(requestedSchedule && { requestedSchedule }),
    availableModels,
    ...(availableSkills && { availableSkills }),
  };
}

/**
 * A creator-only structured handoff. Validation happens inside the tool call,
 * so a rejected draft returns to the model as a tool error while the same
 * session still has project context and steps available for a correction.
 */
export function createSubmitAgentSourceTool(
  submission: AgentSourceSubmission,
  contract: AgentSourceSubmissionContract,
  loadedSkillNames?: () => readonly string[],
): Tool {
  return {
    description:
      'Submit the friendly agent name, safe filename, and complete AgentUse file you authored. This is the only accepted handoff for the internal creator. ' +
      'The host validates the file immediately; if the call is rejected, correct the reported problem and call this tool again. ' +
      'After it is accepted, call report_complete with a short headline and no source in details.',
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe(
        'The concise human-facing agent name. Use readable title-style words with spaces, not a filename or kebab-case slug. It must exactly match the name field in the source frontmatter.'
      ),
      filename: z.string().min(1).max(160).describe(
        'The project-local agent filename as lowercase kebab-case ending in .agentuse, for example weekly-support-triage.agentuse. Do not include a directory.'
      ),
      source: z.string().min(1).max(64_000).describe(
        'The complete raw .agentuse file as one string. It must begin with --- and contain parser-valid YAML frontmatter followed by the Markdown instruction body. Do not use a code fence or add commentary.'
      ),
    }).strict(),
    execute: async ({ name, filename, source }: { name: string; filename: string; source: string }) => {
      try {
        const authored = validateAuthoredAgentSource(
          source,
          contract.availableModels,
          contract.requestedName,
          contract.requestedSchedule,
          contract.availableSkills,
          loadedSkillNames?.(),
        );
        const submittedName = validateAgentName(name);
        if (submittedName !== authored.name) {
          throw new AgentCreationError(
            'INVALID_GENERATED_AGENT',
            `The submitted agent name must exactly match the source frontmatter name ${authored.name}`,
          );
        }
        const fileName = validateAgentFileName(filename);
        submission.source = authored.source;
        submission.name = authored.name;
        submission.fileName = fileName;
        submission.model = authored.model;
        return `Accepted: ${authored.name} is valid and will be saved as ${fileName}. Call report_complete now with a short confirmation headline and omit details.`;
      } catch (error) {
        if (error instanceof AgentCreationError) {
          throw new Error(`Source rejected: ${error.message}. Correct the source and call submit_agent_source again.`);
        }
        throw error;
      }
    },
  };
}
