import { parseAgentContent } from '../parser.js';
import { grantsArbitraryCode, grantsUnnamedSubcommands } from '../tools/effectful-heuristic.js';
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

/** Whether a bash pattern contains an unquoted |, ;, & or &&, which the per-segment matcher never matches. */
function chainsCommands(pattern: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '|' || char === ';') return true;
    // `2>&1` and `&>file` redirect rather than chain.
    if (char === '&' && pattern[i - 1] !== '>' && pattern[i - 1] !== '<' && pattern[i + 1] !== '>') return true;
  }
  return false;
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
  if (!source) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file is empty');
  if (source.length > AUTHOR_MAX_SOURCE_CHARS) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file is too large');
  }
  if (!source.startsWith('---')) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This is commentary instead of an AgentUse file: it must start with ---');
  }
  let parsed;
  try {
    parsed = parseAgentContent(source, '');
  } catch (error) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file is invalid: ${(error as Error).message}`);
  }
  if (!parsed.name) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file has no name. Add name: to its top section');
  try {
    validateAgentName(parsed.name);
  } catch (error) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file has an invalid name: ${(error as Error).message}`);
  }
  if (requestedName && parsed.name !== requestedName) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file must use the name ${requestedName}`);
  }
  if (!parsed.config.description?.trim()) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file has no description. Add description: to its top section');
  }
  if (!parsed.instructions.trim()) throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file has no instructions');
  if (!availableModels.includes(parsed.config.model)) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', availableModels.length === 0
      ? 'No AI is set up on this computer yet. Run `agentuse provider login`, then try again.'
      : `This agent uses a runtime model that is not available on this computer: ${parsed.config.model}. Available: ${availableModels.slice(0, 8).join(', ')}`);
  }
  if (requestedSchedule && parsed.config.schedule !== requestedSchedule) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file did not use the requested schedule ${requestedSchedule}`);
  }
  if (!requestedSchedule && parsed.config.schedule) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file added a schedule before the agent was reviewed');
  }
  const trustedSkills = parsed.config.skills?.trusted === true
    || Object.values(parsed.config.skills?.explicit ?? {}).some((skill) => skill.trusted === true);
  if (trustedSkills) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', 'This agent file trusted a skill before the agent was reviewed');
  }
  if (availableSkills) {
    const available = new Set(availableSkills);
    const unknownSkill = Object.keys(parsed.config.skills?.explicit ?? {}).find((name) => !available.has(name));
    if (unknownSkill) {
      throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file names an unavailable or ambiguous skill: ${unknownSkill}`);
    }
  }
  if (loadedSkills) {
    const loaded = new Set(loadedSkills);
    const unloadedSkill = Object.keys(parsed.config.skills?.explicit ?? {}).find((name) => !loaded.has(name));
    if (unloadedSkill) {
      throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file names ${unloadedSkill} without loading its complete SKILL.md first`);
    }
  }
  const gated = parsed.config.tools?.bash?.gated ?? [];
  const compoundPattern = [...(parsed.config.tools?.bash?.commands ?? []), ...gated].find(chainsCommands);
  if (compoundPattern) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file has a bash pattern that chains commands: ${compoundPattern}. `
      + 'Each segment of a pipeline or chain is checked on its own, so this pattern can never match. List each command as its own pattern instead.');
  }
  const unsafeCommand = (parsed.config.tools?.bash?.commands ?? []).find((command) =>
    !gated.some((pattern) => wildcardMatch(command, pattern))
      && (grantsArbitraryCode(command) || grantsUnnamedSubcommands(command)));
  if (unsafeCommand) {
    throw new AgentCreationError('INVALID_GENERATED_AGENT', `This agent file has an unsafe ungated command: ${unsafeCommand}`);
  }
  return { source: `${source}\n`, name: parsed.name, model: parsed.config.model };
}
