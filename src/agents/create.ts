import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as YAML from 'yaml';
import { getSuggestedModelIds } from '../generated/models.js';
import { parseAgentContent } from '../parser.js';
import { OPENCODE_GO_MODELS, OPENCODE_GO_PROVIDER_ID } from '../providers/opencode-go.js';
import type { ProviderStatus } from '../auth/provider-status.js';

export interface AgentCreationProject {
  id: string;
  root: string;
  scopeRoot: string;
}

export interface AgentCreationInput {
  name?: unknown;
  objective: unknown;
  model: unknown;
  source?: unknown;
}

export interface CreatedAgentFile {
  projectId: string;
  absolutePath: string;
  path: string;
  runPath: string;
  name: string;
  description: string;
  model: string;
}

export interface AgentCreationProvider {
  id: string;
  name: string;
  models: string[];
  custom?: true;
}

export class AgentCreationError extends Error {
  constructor(
    public code: 'INVALID_AGENT' | 'INVALID_GENERATED_AGENT' | 'MODEL_NOT_CONFIGURED' | 'AGENT_EXISTS' | 'GENERATION_FAILED' | 'CREATE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'AgentCreationError';
  }
}

const NAME_MAX = 120;
const OBJECTIVE_MAX = 12_000;
const MODEL_MAX = 500;
const SOURCE_MAX = 64_000;

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new AgentCreationError('INVALID_AGENT', 'Agent name is required');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new AgentCreationError('INVALID_AGENT', 'Agent name is required');
  if (name.length > NAME_MAX) throw new AgentCreationError('INVALID_AGENT', `Agent name must be ${NAME_MAX} characters or fewer`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name)) {
    throw new AgentCreationError('INVALID_AGENT', 'Agent name must use letters, numbers, spaces, hyphens, or underscores');
  }
  return name;
}

function cleanObjective(value: unknown): string {
  if (typeof value !== 'string') throw new AgentCreationError('INVALID_AGENT', 'Describe what this agent should do');
  const objective = value.trim();
  if (!objective) throw new AgentCreationError('INVALID_AGENT', 'Describe what this agent should do');
  if (objective.length > OBJECTIVE_MAX) {
    throw new AgentCreationError('INVALID_AGENT', `Agent instructions must be ${OBJECTIVE_MAX.toLocaleString()} characters or fewer`);
  }
  return objective;
}

/** Derive a stable, readable title without spending a model call. Keep the
 * first useful clause so the generated filename stays concise and predictable. */
export function deriveAgentName(objective: string): string {
  const firstSentence = objective.split(/(?:\r?\n|[.!?;])/u, 1)[0]?.trim() || objective.trim();
  const conjunction = /\s+and\s+/iu.exec(firstSentence);
  const clause = conjunction && firstSentence.slice(0, conjunction.index).trim().split(/\s+/u).length >= 3
    ? firstSentence.slice(0, conjunction.index)
    : firstSentence;
  const words = clause
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[’']s\b/giu, '')
    .replace(/[’']/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) {
    const digest = createHash('sha256').update(objective).digest('hex').slice(0, 8);
    return `Agent ${digest}`;
  }
  return words.map((word) => /^[A-Z0-9]{2,}$/.test(word)
    ? word
    : `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`).join(' ');
}

function cleanModel(value: unknown): string {
  if (typeof value !== 'string') throw new AgentCreationError('INVALID_AGENT', 'Choose a model');
  const model = value.trim();
  if (!model) throw new AgentCreationError('INVALID_AGENT', 'Choose a model');
  const separator = model.indexOf(':');
  if (model.length > MODEL_MAX || separator <= 0 || separator === model.length - 1 || /\s/.test(model)) {
    throw new AgentCreationError('INVALID_AGENT', 'Model must use the provider:model format');
  }
  return model;
}

function providerFromModel(model: string): string {
  return model.slice(0, model.indexOf(':')).toLowerCase();
}

export function validateAgentCreationRequest(
  input: Pick<AgentCreationInput, 'objective' | 'model'>,
  configuredProviders: readonly string[],
): { objective: string; model: string } {
  const objective = cleanObjective(input.objective);
  const model = cleanModel(input.model);
  const provider = providerFromModel(model);
  if (!configuredProviders.includes(provider)) {
    throw new AgentCreationError('MODEL_NOT_CONFIGURED', `Connect ${provider} before creating an agent with ${model}`);
  }
  return { objective, model };
}

function agentSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[ _]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new AgentCreationError('INVALID_AGENT', 'Agent name must include a letter or number');
  return slug;
}

function oneLineDescription(objective: string): string {
  const line = objective.replace(/\s+/g, ' ').trim();
  return line.length <= 240 ? line : `${line.slice(0, 239).trimEnd()}…`;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function renderAgent(name: string, model: string, objective: string, description: string): string {
  const frontmatter = YAML.stringify({ name, model, description }, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${objective}\n`;
}

/** Providers and curated model choices available to the dashboard create flow. */
export function agentCreationProviders(status: ProviderStatus): AgentCreationProvider[] {
  const suggestions = getSuggestedModelIds();
  const providers: AgentCreationProvider[] = [];
  for (const provider of status.providers) {
    if (!provider.configured) continue;
    const models = provider.id === OPENCODE_GO_PROVIDER_ID
      ? OPENCODE_GO_MODELS.map((model) => `${OPENCODE_GO_PROVIDER_ID}:${model.id}`)
      : suggestions.filter((model) => model.startsWith(`${provider.id}:`));
    providers.push({ id: provider.id, name: provider.name, models });
  }
  for (const provider of status.customProviders) {
    if (provider.hasApiKey) providers.push({ id: provider.id, name: provider.id, models: [], custom: true });
  }
  return providers;
}

/**
 * Persist one new minimal agent without ever replacing an existing file.
 * Validation happens before filesystem mutation; publication uses a hard link
 * from a fully-synced sibling temporary file so readers never observe partial
 * source and two concurrent creators cannot both claim the same name.
 */
export async function createAgentFile(
  project: AgentCreationProject,
  input: AgentCreationInput,
  configuredProviders: readonly string[],
): Promise<CreatedAgentFile> {
  const { objective, model } = validateAgentCreationRequest(input, configuredProviders);
  const name = input.name === undefined || input.name === null || (typeof input.name === 'string' && !input.name.trim())
    ? deriveAgentName(objective)
    : cleanName(input.name);
  let description = oneLineDescription(objective);
  let source = renderAgent(name, model, objective, description);
  let parsed;
  try {
    if (input.source !== undefined) {
      if (typeof input.source !== 'string' || !input.source.trim()) {
        throw new AgentCreationError('INVALID_AGENT', 'The generated agent source is empty');
      }
      source = input.source.trim();
      if (source.length > SOURCE_MAX) {
        throw new AgentCreationError('INVALID_AGENT', `The generated agent source must be ${SOURCE_MAX.toLocaleString()} characters or fewer`);
      }
      parsed = parseAgentContent(source, '');
      if (!parsed.name) throw new AgentCreationError('INVALID_AGENT', 'The generated agent must declare a name');
      cleanName(parsed.name);
      if (!parsed.instructions.trim()) throw new AgentCreationError('INVALID_AGENT', 'The generated agent must include instructions');
      if (parsed.config.model !== model) {
        throw new AgentCreationError('INVALID_AGENT', `The generated agent must use the selected model ${model}`);
      }
      description = parsed.config.description?.trim() || description;
      source = `${source}\n`;
    } else {
      parsed = parseAgentContent(source, agentSlug(name));
    }
  } catch (error) {
    if (error instanceof AgentCreationError) throw error;
    throw new AgentCreationError('INVALID_AGENT', (error as Error).message);
  }

  const persistedName = cleanName(parsed.name);
  const slug = agentSlug(persistedName);

  const agentDir = project.scopeRoot === project.root ? join(project.scopeRoot, 'agents') : project.scopeRoot;
  await mkdir(agentDir, { recursive: true });
  const [directoryStat, realRoot, realScope, realDirectory] = await Promise.all([
    lstat(agentDir),
    realpath(project.root),
    realpath(project.scopeRoot),
    realpath(agentDir),
  ]);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || !isPathInside(realScope, realDirectory)) {
    throw new AgentCreationError('CREATE_FAILED', 'The agent directory is not a writable directory inside this project');
  }

  const fileName = `${slug}.agentuse`;
  const absolutePath = join(realDirectory, fileName);
  const temporary = join(realDirectory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, absolutePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AgentCreationError('AGENT_EXISTS', `An agent named “${persistedName}” already exists at ${relative(realRoot, absolutePath)}`);
    }
    if (error instanceof AgentCreationError) throw error;
    throw new AgentCreationError('CREATE_FAILED', `Could not create agent: ${(error as Error).message}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  return {
    projectId: project.id,
    absolutePath,
    path: relative(realRoot, absolutePath),
    runPath: relative(realScope, absolutePath),
    name: parsed.name,
    description,
    model: parsed.config.model,
  };
}
