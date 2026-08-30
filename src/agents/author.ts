import { completeText, type CompleteTextOptions } from '../complete-text.js';
import { parseAgentContent } from '../parser.js';
import { helperSystemPrompt } from '../utils/anthropic.js';
import { AgentCreationError } from './create.js';

const AUTHOR_MAX_OUTPUT_TOKENS = 6_000;
const AUTHOR_MAX_SOURCE_CHARS = 64_000;

export interface AgentAuthoringRequest {
  objective: string;
  /** Model used for this one authoring call; it does not determine the agent runtime. */
  model: string;
  /** Runtime models reachable through the user's configured providers. */
  availableModels: readonly string[];
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

type CompleteAgentText = (model: string, options: CompleteTextOptions) => Promise<string>;

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Concise runtime prompt distilled from the version-matched AgentUse creator
 * skill. It asks for the minimum executable contract, not a catalog of syntax. */
export function buildAgentAuthoringPrompt(request: AgentAuthoringRequest): string {
  const availableModels = [...new Set(request.availableModels)];
  return `Create one production-ready AgentUse .agentuse file for this job:

<requested_job>
${xmlText(request.objective)}
</requested_job>

<available_runtime_models>
${availableModels.map((model) => `- ${xmlText(model)}`).join('\n')}
</available_runtime_models>

Authoring contract:
- Return only the complete .agentuse source. The first bytes must be ---; no code fence or commentary.
- Frontmatter must include a concise ASCII name, a short action-oriented description, and exactly one model from available_runtime_models.
- Choose the runtime model independently from the model authoring this file. Pick by the hardest reasoning the finished agent performs, not by perceived importance: small/fast for mechanical high-volume work, mid-tier for most well-specified multi-step work, and top-tier only for open-ended judgment, planning, debugging, adversarial review, or difficult drafting. Prefer the least expensive tier that can do the job reliably.
- Write the narrowest agent that can finish the requested job. Add frontmatter only when the job clearly requires it.
- The body is the recurring prompt: state the outcome, required input, deliverable, and material boundaries. Let the runtime model choose ordinary methods.
- If the job needs input or an integration that was not specified, accept it from the run prompt; do not invent credentials, paths, skills, tools, destinations, schedules, or subagents.
- Declare only capabilities the job clearly needs. Gate irreversible bash actions in tools.bash.gated; never rely on prose as the safety boundary.
- Do not add generic advice, speculative branches, runtime protocols, hidden HTML comments, or instructions to ask the user mid-run.`;
}

function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

export function validateAuthoredAgentSource(response: string, availableModels: readonly string[]): AuthoredAgent {
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
  if (!parsed.config.description?.trim()) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model did not describe the agent');
  }
  if (!parsed.instructions.trim()) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model did not write agent instructions');
  if (!availableModels.includes(parsed.config.model)) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model chose a runtime model that is not available: ${parsed.config.model}`);
  }
  return { source: `${source}\n`, model: parsed.config.model };
}

export async function authorAgentSource(
  request: AgentAuthoringRequest,
  complete: CompleteAgentText = completeText,
  options: AgentAuthoringOptions = {},
): Promise<AuthoredAgent> {
  const system = helperSystemPrompt(
    request.model,
    'You are an AgentUse agent author. Produce minimal, parser-valid, production-ready .agentuse source and nothing else. Choose the finished agent’s runtime model independently from the model running this authoring call.',
  );
  let response: string;
  try {
    options.onProgress?.({ type: 'status', message: 'Sending the brief to the selected model' });
    const abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000);
    response = await complete(request.model, {
      ...system,
      prompt: buildAgentAuthoringPrompt(request),
      maxOutputTokens: AUTHOR_MAX_OUTPUT_TOKENS,
      maxRetries: 2,
      abortSignal,
      onTextDelta: (text) => options.onProgress?.({ type: 'draft', text }),
    });
  } catch (error) {
    throw new AgentCreationError('GENERATION_FAILED', `The selected model could not create the agent: ${(error as Error).message}`);
  }
  options.onProgress?.({ type: 'status', message: 'Validating the generated agent' });
  return validateAuthoredAgentSource(response, request.availableModels);
}
