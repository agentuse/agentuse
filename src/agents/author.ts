import { completeText, type CompleteTextOptions } from '../complete-text.js';
import { parseAgentContent } from '../parser.js';
import { helperSystemPrompt } from '../utils/anthropic.js';
import { loadBuiltinSkillSource } from '../skill/builtin.js';
import { grantsArbitraryCode, grantsUnnamedSubcommands, looksEffectful } from '../tools/effectful-heuristic.js';
import { match as wildcardMatch } from '../tools/wildcard.js';
import { AgentCreationError, validateAgentName } from './create.js';

const AUTHOR_MAX_OUTPUT_TOKENS = 6_000;
const AUTHOR_MAX_SOURCE_CHARS = 64_000;

export interface AgentAuthoringRequest {
  /** Exact user-requested frontmatter name, when supplied. */
  name?: string;
  objective: string;
  /** Model used for this one authoring call; it does not determine the agent runtime. */
  model: string;
  /** Runtime models reachable through the user's configured providers. */
  availableModels: readonly string[];
  /** Exact schedule selected from project discovery, when this agent is being
   * created from a reviewed onboarding suggestion. */
  schedule?: string;
}

export interface AuthoredAgent {
  source: string;
  model: string;
}

export type AgentAuthoringProgress =
  | { type: 'status'; message: string }
  | { type: 'draft'; text: string };

export interface AgentAuthoringOptions {
  abortSignal?: AbortSignal;
  onProgress?: (event: AgentAuthoringProgress) => void;
}

export interface GuidedAgentInstructionsRequest {
  objective: string;
  model: string;
}

type CompleteAgentText = (model: string, options: CompleteTextOptions) => Promise<string>;

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Concise runtime prompt distilled from the version-matched AgentUse creator
 * skill. It asks for the minimum executable contract, not a catalog of syntax. */
export function buildAgentAuthoringPrompt(request: AgentAuthoringRequest): string {
  const availableModels = [...new Set(request.availableModels)];
  const requestedName = request.name ? `\n<requested_name>\n${xmlText(request.name)}\n</requested_name>\n` : '';
  const requestedSchedule = request.schedule ? `\n<requested_schedule>\n${xmlText(request.schedule)}\n</requested_schedule>\n` : '';
  return `Create one production-ready AgentUse .agentuse file for this job:
${requestedName}${requestedSchedule}

<requested_job>
${xmlText(request.objective)}
</requested_job>

<available_runtime_models>
${availableModels.map((model) => `- ${xmlText(model)}`).join('\n')}
</available_runtime_models>

Authoring contract:
- Return only the complete .agentuse source. The first bytes must be ---; no code fence or commentary.
- Frontmatter: concise ASCII name, short action-oriented description, and one model copied byte-for-byte from available_runtime_models. This auth-filtered list is exhaustive; never use outside model knowledge or aliases. Preserve requested_name exactly.
- Choose the runtime model independently from the model authoring this file. Pick by the hardest reasoning the finished agent performs, not by perceived importance: small/fast for mechanical high-volume work, mid-tier for most well-specified multi-step work, and top-tier only for open-ended judgment, planning, debugging, adversarial review, or difficult drafting. Prefer the least expensive tier that can do the job reliably.
- Write the narrowest agent that can finish the requested job. Add frontmatter only when the job clearly requires it.
- The body is the recurring prompt: state the outcome, required input, deliverable, and material boundaries. Let the runtime model choose ordinary methods.
- If the job needs input or an integration that was not specified, accept it from the run prompt; do not invent credentials, paths, skills, tools, destinations, schedules, or subagents.
- Declare only capabilities the job clearly needs. Gate irreversible bash actions in tools.bash.gated; never rely on prose as the safety boundary.
- ${request.schedule ? 'Add frontmatter schedule copied byte-for-byte from requested_schedule. This read-only recurring workflow was explicitly selected by the user. Do not add a notification channel.' : 'Do not add a schedule or notification channel in this guided flow. The user reviews and enables automation separately.'}
- Do not add generic advice, speculative branches, runtime protocols, hidden HTML comments, or instructions to ask the user mid-run.`;
}

function buildAgentRepairPrompt(request: AgentAuthoringRequest, invalidSource: string, validationError: string): string {
  return `Repair the AgentUse source below so it satisfies the original authoring request and parses successfully.

Validation error:
${xmlText(validationError)}

Return only the complete corrected .agentuse source. The first bytes must be ---; no code fence or commentary.

<original_request>
${buildAgentAuthoringPrompt(request)}
</original_request>

<invalid_source>
${xmlText(invalidSource.slice(0, AUTHOR_MAX_SOURCE_CHARS))}
</invalid_source>`;
}

function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function normalizeGuidedInstructions(response: string): string {
  let instructions = stripSingleFence(response);
  if (instructions.startsWith('---')) {
    const closing = instructions.indexOf('\n---', 3);
    if (closing >= 0) instructions = instructions.slice(closing + 4).trim();
  }
  if (!instructions) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model returned empty agent instructions');
  if (instructions.length > AUTHOR_MAX_SOURCE_CHARS) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model returned agent instructions that are too large');
  }
  return `${instructions}\n`;
}

/** The guided flow asks the model only for the useful Markdown body. AgentUse
 * owns all schema-sensitive frontmatter, tools, model, and schedule fields. */
export async function authorGuidedAgentInstructions(
  request: GuidedAgentInstructionsRequest,
  complete: CompleteAgentText = completeText,
  options: AgentAuthoringOptions = {},
): Promise<string> {
  let creatorSkill: string;
  try {
    creatorSkill = await loadBuiltinSkillSource('creator');
  } catch (error) {
    throw new AgentCreationError('GENERATION_FAILED', `Could not load the AgentUse Creator skill: ${(error as Error).message}`);
  }
  const system = helperSystemPrompt(
    request.model,
    `You are an AgentUse agent instruction writer. Apply the version-matched Creator skill below, but write only the agent's Markdown instruction body. AgentUse will add validated frontmatter separately.\n\n## AgentUse Creator skill\n\n${creatorSkill.trim()}`,
  );
  const prompt = `Turn this reviewed project suggestion into concise, production-ready recurring agent instructions.

<reviewed_suggestion>
${xmlText(request.objective)}
</reviewed_suggestion>

Return Markdown only, with exactly these sections:
- ## Goal
- ## What to inspect
- ## Output
- ## Boundaries

The output is Markdown shown in the AgentUse session. Do not invent dashboard cards, files to save, messages to send, tools, credentials, or external destinations. Preserve useful concrete project paths from the suggestion. Keep the workflow read-only.`;
  options.onProgress?.({ type: 'status', message: 'Sending the reviewed suggestion to the selected model' });
  const abortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(90_000)])
    : AbortSignal.timeout(90_000);
  try {
    const response = await complete(request.model, {
      ...system,
      prompt,
      maxOutputTokens: 3_500,
      maxRetries: 2,
      abortSignal,
      onTextDelta: (text) => options.onProgress?.({ type: 'draft', text }),
    });
    options.onProgress?.({ type: 'status', message: 'Validating the generated instructions' });
    return normalizeGuidedInstructions(response);
  } catch (error) {
    if (error instanceof AgentCreationError) throw error;
    throw new AgentCreationError('GENERATION_FAILED', `The selected model could not write the agent instructions: ${(error as Error).message}`);
  }
}

export function validateAuthoredAgentSource(
  response: string,
  availableModels: readonly string[],
  requestedName?: string,
  requestedSchedule?: string,
): AuthoredAgent {
  const source = stripSingleFence(response);
  if (!source) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model returned an empty agent');
  if (source.length > AUTHOR_MAX_SOURCE_CHARS) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model returned an agent that is too large');
  }
  if (!source.startsWith('---')) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model returned commentary instead of an AgentUse file');
  }
  let parsed;
  try {
    parsed = parseAgentContent(source, '');
  } catch (error) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model returned invalid AgentUse source: ${(error as Error).message}`);
  }
  if (!parsed.name) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model did not name the agent');
  try {
    validateAgentName(parsed.name);
  } catch (error) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model used an invalid agent name: ${(error as Error).message}`);
  }
  if (requestedName && parsed.name !== requestedName) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model did not use the requested agent name ${requestedName}`);
  }
  if (!parsed.config.description?.trim()) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model did not describe the agent');
  }
  if (!parsed.instructions.trim()) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model did not write agent instructions');
  if (!availableModels.includes(parsed.config.model)) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model chose a runtime model that is not available: ${parsed.config.model}`);
  }
  if (requestedSchedule && parsed.config.schedule !== requestedSchedule) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model did not use the requested schedule ${requestedSchedule}`);
  }
  if (!requestedSchedule && parsed.config.schedule) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model added a schedule before the agent was reviewed');
  }
  if (parsed.config.channels) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model added a notification channel before the agent was reviewed');
  }
  const trustedSkills = parsed.config.skills?.trusted === true
    || Object.values(parsed.config.skills?.explicit ?? {}).some((skill) => skill.trusted === true);
  if (trustedSkills) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model trusted a skill before the agent was reviewed');
  }
  const gated = parsed.config.tools?.bash?.gated ?? [];
  const unsafeCommand = (parsed.config.tools?.bash?.commands ?? []).find((command) =>
    !gated.some((pattern) => wildcardMatch(command, pattern))
      && (looksEffectful(command) || grantsArbitraryCode(command) || grantsUnnamedSubcommands(command)));
  if (unsafeCommand) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model added an unsafe ungated command: ${unsafeCommand}`);
  }
  return { source: `${source}\n`, model: parsed.config.model };
}

export async function authorAgentSource(
  request: AgentAuthoringRequest,
  complete: CompleteAgentText = completeText,
  options: AgentAuthoringOptions = {},
): Promise<AuthoredAgent> {
  let creatorSkill: string;
  try {
    creatorSkill = await loadBuiltinSkillSource('creator');
  } catch (error) {
    throw new AgentCreationError('GENERATION_FAILED', `Could not load the AgentUse Creator skill: ${(error as Error).message}`);
  }
  const system = helperSystemPrompt(
    request.model,
    `You are an AgentUse agent author. Apply the complete version-matched Creator skill below. Produce parser-valid, production-ready .agentuse source and nothing else. Choose the finished agent’s runtime model independently from the model running this authoring call.

## AgentUse Creator skill

${creatorSkill.trim()}`,
  );
  const completeDraft = async (prompt: string): Promise<string> => {
    const abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000);
    try {
      return await complete(request.model, {
        ...system,
        prompt,
        maxOutputTokens: AUTHOR_MAX_OUTPUT_TOKENS,
        maxRetries: 2,
        abortSignal,
        onTextDelta: (text) => options.onProgress?.({ type: 'draft', text }),
      });
    } catch (error) {
      throw new AgentCreationError('GENERATION_FAILED', `The selected model could not create the agent: ${(error as Error).message}`);
    }
  };

  options.onProgress?.({ type: 'status', message: 'Sending the brief to the selected model' });
  const response = await completeDraft(buildAgentAuthoringPrompt(request));
  options.onProgress?.({ type: 'status', message: 'Validating the generated agent' });
  try {
    return validateAuthoredAgentSource(response, request.availableModels, request.name, request.schedule);
  } catch (error) {
    if (!(error instanceof AgentCreationError) || error.code !== 'INVALID_GENERATED_AGENT') throw error;
    options.onProgress?.({ type: 'status', message: 'The first draft needs a format repair; asking the model to correct it' });
    const repaired = await completeDraft(buildAgentRepairPrompt(request, response, error.message));
    options.onProgress?.({ type: 'status', message: 'Validating the repaired agent' });
    try {
      return validateAuthoredAgentSource(repaired, request.availableModels, request.name, request.schedule);
    } catch (repairError) {
      if (!(repairError instanceof AgentCreationError) || repairError.code !== 'INVALID_GENERATED_AGENT') throw repairError;
      throw new AgentCreationError(
        'INVALID_GENERATED_AGENT',
        `The selected model could not produce valid AgentUse source after one repair attempt: ${repairError.message.replace(/^The selected model returned invalid AgentUse source:\s*/u, '')}`,
      );
    }
  }
}
