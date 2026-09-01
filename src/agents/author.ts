import { parseAgentContent } from '../parser.js';
import { grantsArbitraryCode, grantsUnnamedSubcommands, looksEffectful } from '../tools/effectful-heuristic.js';
import { match as wildcardMatch } from '../tools/wildcard.js';
import { AgentCreationError, validateAgentName } from './create.js';

const AUTHOR_MAX_SOURCE_CHARS = 64_000;

export interface AuthoredAgent {
  source: string;
  name: string;
  model: string;
}

function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

export function validateAuthoredAgentSource(
  response: string,
  availableModels: readonly string[],
  requestedName?: string,
  requestedSchedule?: string,
  availableSkills?: readonly string[],
  loadedSkills?: readonly string[],
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
  const trustedSkills = parsed.config.skills?.trusted === true
    || Object.values(parsed.config.skills?.explicit ?? {}).some((skill) => skill.trusted === true);
  if (trustedSkills) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'The selected model trusted a skill before the agent was reviewed');
  }
  if (availableSkills) {
    const available = new Set(availableSkills);
    const unknownSkill = Object.keys(parsed.config.skills?.explicit ?? {}).find((name) => !available.has(name));
    if (unknownSkill) {
      throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model referenced an unavailable or ambiguous skill: ${unknownSkill}`);
    }
  }
  if (loadedSkills) {
    const loaded = new Set(loadedSkills);
    const unloadedSkill = Object.keys(parsed.config.skills?.explicit ?? {}).find((name) => !loaded.has(name));
    if (unloadedSkill) {
      throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model referenced ${unloadedSkill} without loading its complete SKILL.md first`);
    }
  }
  const gated = parsed.config.tools?.bash?.gated ?? [];
  const unsafeCommand = (parsed.config.tools?.bash?.commands ?? []).find((command) =>
    !gated.some((pattern) => wildcardMatch(command, pattern))
      && (looksEffectful(command) || grantsArbitraryCode(command) || grantsUnnamedSubcommands(command)));
  if (unsafeCommand) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `The selected model added an unsafe ungated command: ${unsafeCommand}`);
  }
  return { source: `${source}\n`, name: parsed.name, model: parsed.config.model };
}
