/**
 * Model aliases: name a model line without its version and get whichever
 * release is current.
 *
 * Two kinds, both resolved to a concrete `provider:model` id before anything
 * else in the codebase sees them (see resolveModelString):
 *
 *  1. Version aliases (built in). Drop the version from a model id and you have
 *     an alias for the newest model in that line: `anthropic:claude-sonnet`,
 *     `openai:gpt`, `openai:gpt-mini`, `openrouter:x-ai/grok`. Derived from the
 *     curated lineup in the generated registry (SUGGESTED_MODEL_IDS), which is
 *     already one current model per product line, so the table is a byproduct
 *     of the registry rather than a second list to maintain. Refreshed by
 *     `pnpm generate:models`, which means an alias always points at a model
 *     from a lineup that shipped, never at something published minutes ago.
 *
 *  2. User aliases (`@name`). Named in `models.aliases` in the global config,
 *     so a fleet of agent files can be repointed by editing one line. The `@`
 *     sigil is required: a bare string is already a valid OpenAI model id, so
 *     an unprefixed name would be ambiguous.
 *
 * Aliases never shadow a real model: an id that exists in the registry always
 * resolves to itself.
 */

import { getModelFromRegistry, getSuggestedModelIds } from '../generated/models';
import { joinModelString, splitModelString } from './model-utils';
import { loadModelSettings, type ModelAliasConfig, type ModelSettings } from './global-config';
import { logger } from './logger';
import { parseDurationMs } from './duration';

/** Marks a user-defined alias from the config `models.aliases` block. */
export const MODEL_ALIAS_SIGIL = '@';

/** Env var that supplies the default model when an agent file omits `model`. */
export const MODEL_DEFAULT_ENV = 'AGENTUSE_MODEL';

export type ModelResolutionSource =
  /** Written as a concrete model id (or an id we don't recognize: passed through). */
  | 'literal'
  /** A `@name` alias from the config `models.aliases` block. */
  | 'user-alias'
  /** A built-in version-less alias, e.g. `anthropic:claude-sonnet`. */
  | 'version-alias'
  /** No model was named; came from `AGENTUSE_MODEL` or config `models.default`. */
  | 'default';

export interface ResolvedModel {
  /** Concrete `provider:model[:env]` string to hand to the provider. */
  model: string;
  /** What the user actually wrote, when it was not already the concrete id. */
  alias?: string;
  source: ModelResolutionSource;
  /** Ordered concrete models for an object-form user alias. First is `model`. */
  candidates?: string[];
  /** Process-local cooldown applied after a transient first-response failure. */
  cooldownMs?: number;
}

/**
 * Immutable model policy explicitly supplied for one run. `requested` keeps
 * the user's alias spelling while `resolved` snapshots its concrete candidates
 * so a config edit cannot change descendants halfway through a run or resume.
 */
export interface RunModelOverride {
  requested: string;
  resolved: ResolvedModel;
}

/** Runtime model fields shared by parsed agent configs and override tests. */
export interface ModelOverrideTarget {
  model: string;
  modelAlias?: string;
  modelSource?: ModelResolutionSource;
  modelCandidates?: string[];
  modelFallbackCooldownMs?: number;
}

/** Apply one already-resolved run policy without re-reading global aliases. */
export function applyRunModelOverride(
  target: ModelOverrideTarget,
  override: RunModelOverride
): void {
  const resolved = override.resolved;
  target.model = resolved.model;
  if (resolved.candidates !== undefined) target.modelCandidates = [...resolved.candidates];
  else delete target.modelCandidates;
  if (resolved.cooldownMs !== undefined) target.modelFallbackCooldownMs = resolved.cooldownMs;
  else delete target.modelFallbackCooldownMs;
  if (resolved.alias !== undefined && resolved.alias !== resolved.model) {
    target.modelAlias = resolved.alias;
    target.modelSource = resolved.source;
  } else {
    delete target.modelAlias;
    delete target.modelSource;
  }
}

/** Raised when a `@name` alias or a configured default cannot be resolved. */
export class ModelAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelAliasError';
  }
}

const DATE_SUFFIX = /-\d{8}$/;
const DASHED_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/** A segment that is only a version: "5", "5.6", "4", "v4", "m3", "5v", "4o". */
const VERSION_SEGMENT = /^[a-z]?\d+(?:\.\d+)*[a-z]?$/i;
/** A word with a version glued to its tail: "qwen3.7" -> "qwen". */
const GLUED_VERSION = /^([a-z]+)\d+(?:\.\d+)*$/i;

function stripDate(id: string): string {
  return id.replace(DATE_SUFFIX, '').replace(DASHED_DATE_SUFFIX, '');
}

/**
 * Derive the version-less alias for a model id, or undefined when the id
 * carries no version to drop (nothing to alias).
 *
 * The version run and any release-date suffix come out, the rest stays in
 * order, and a vendor path prefix is preserved verbatim (an OpenRouter vendor
 * can itself contain digits, e.g. `01-ai/`):
 *
 *   claude-sonnet-5        -> claude-sonnet
 *   claude-haiku-4-5       -> claude-haiku
 *   gpt-5.6                -> gpt
 *   gpt-5.4-mini           -> gpt-mini
 *   gpt-5.1-codex-max      -> gpt-codex-max
 *   z-ai/glm-5.2           -> z-ai/glm
 *   z-ai/glm-5v-turbo      -> z-ai/glm-turbo
 *   deepseek/deepseek-v4-pro -> deepseek/deepseek-pro
 *   qwen/qwen3.7-max       -> qwen/qwen-max
 *   minimax/minimax-m3     -> minimax/minimax
 */
export function deriveModelAlias(modelId: string): string | undefined {
  const slash = modelId.lastIndexOf('/');
  const vendor = slash === -1 ? '' : modelId.slice(0, slash + 1);
  const base = stripDate(modelId.slice(slash + 1));

  const kept: string[] = [];
  for (const segment of base.split('-')) {
    if (segment === '') continue;
    if (VERSION_SEGMENT.test(segment)) continue;
    const glued = segment.match(GLUED_VERSION);
    kept.push(glued ? glued[1]! : segment);
  }
  if (kept.length === 0) return undefined;

  const alias = `${vendor}${kept.join('-')}`;
  // No version was dropped, so this "alias" is just the id itself.
  return alias === modelId ? undefined : alias;
}

/** provider:alias (lowercased) -> concrete model id. */
let versionAliasTable: Map<string, string> | null = null;

function getVersionAliasTable(): Map<string, string> {
  if (versionAliasTable) return versionAliasTable;
  const table = new Map<string, string>();
  // The curated lineup holds exactly one (latest) model per product line, in
  // latest-first order, so the first alias claim wins and later collisions are
  // by definition older models.
  for (const suggested of getSuggestedModelIds()) {
    const { provider, modelId } = splitModelString(suggested);
    const alias = deriveModelAlias(modelId);
    if (!alias) continue;
    const key = `${provider}:${alias}`.toLowerCase();
    if (table.has(key)) continue;
    // Never let an alias shadow a real model that happens to share the name.
    if (getModelFromRegistry(`${provider}:${alias}`)) continue;
    table.set(key, modelId);
  }
  versionAliasTable = table;
  return table;
}

/** Every built-in version alias as `provider:alias` -> `provider:model`. */
export function getVersionAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, modelId] of getVersionAliasTable()) {
    const { provider } = splitModelString(key);
    out[key] = `${provider}:${modelId}`;
  }
  return out;
}

/** Built-in version aliases for one provider, as alias -> concrete model id. */
export function getVersionAliasesForProvider(provider: string): Record<string, string> {
  const prefix = `${provider.toLowerCase()}:`;
  const out: Record<string, string> = {};
  for (const [key, modelId] of getVersionAliasTable()) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = modelId;
  }
  return out;
}

// Debug-log each distinct resolution once. Alias resolution runs on every parse
// (and serve parses the same agents repeatedly), so without this the same line
// repeats for the life of the daemon.
const loggedResolutions = new Set<string>();

function logResolution(from: string, to: string): void {
  if (from === to || loggedResolutions.has(from)) return;
  loggedResolutions.add(from);
  logger.debug(`Model alias: ${from} -> ${to}`);
}

/** Look up a user alias by name, tolerating a leading sigil and any casing. */
function findUserAlias(name: string, settings: ModelSettings): ModelAliasConfig | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(settings.aliases)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function knownUserAliases(settings: ModelSettings): string {
  const names = Object.keys(settings.aliases);
  return names.length > 0
    ? names.map((n) => `${MODEL_ALIAS_SIGIL}${n}`).join(', ')
    : '(none defined)';
}

/**
 * Resolve a model string written by a human (agent frontmatter, `-m`, a
 * subagent override, a verify judge) into the concrete id everything
 * downstream expects. Concrete ids pass through untouched, so this is safe to
 * call more than once on the same value.
 *
 * Precedence, highest first:
 *   1. `@name`         -> the config `models.aliases` entry (which may itself be an alias)
 *   2. a real model id -> itself, so an alias can never shadow a shipped model
 *   3. a version alias -> the newest model in that line
 *   4. anything else   -> passed through unchanged (unknown ids still reach the
 *                         provider, with the registry's existing warning)
 */
export function resolveModelString(input: string): ResolvedModel {
  const written = input.trim();
  if (written === '') {
    throw new ModelAliasError('Model must not be empty');
  }

  if (written.startsWith(MODEL_ALIAS_SIGIL)) {
    const resolved = resolveUserAlias(written, new Set());
    const model = resolved.candidates[0]!;
    logResolution(written, model);
    return {
      model,
      alias: written,
      source: 'user-alias',
      ...(resolved.candidates.length > 1 && { candidates: resolved.candidates }),
      ...(resolved.cooldownMs !== undefined && { cooldownMs: resolved.cooldownMs }),
    };
  }

  const resolved = resolveVersionAlias(written);
  if (resolved) {
    logResolution(written, resolved);
    return { model: resolved, alias: written, source: 'version-alias' };
  }
  return { model: written, source: 'literal' };
}

/**
 * Follow a `@name` chain (an alias may point at another alias, or at a version
 * alias) to a concrete model string. `seen` breaks self-referential configs.
 */
function resolveUserAlias(
  written: string,
  seen: Set<string>
): { candidates: string[]; cooldownMs?: number } {
  const name = written.slice(MODEL_ALIAS_SIGIL.length);
  if (name === '') {
    throw new ModelAliasError(
      `Model alias "${written}" is missing a name (expected ${MODEL_ALIAS_SIGIL}<name>)`
    );
  }

  const key = name.toLowerCase();
  if (seen.has(key)) {
    throw new ModelAliasError(
      `Model alias ${MODEL_ALIAS_SIGIL}${name} points at itself (alias cycle in models.aliases)`
    );
  }
  seen.add(key);

  const settings = loadModelSettings();
  const target = findUserAlias(name, settings);
  if (target === undefined) {
    throw new ModelAliasError(
      `Unknown model alias ${MODEL_ALIAS_SIGIL}${name}. ` +
        `Define it in the \`models.aliases\` block of your AgentUse config. ` +
        `Known aliases: ${knownUserAliases(settings)}`
    );
  }

  if (typeof target === 'string') {
    const next = target.trim();
    if (next.startsWith(MODEL_ALIAS_SIGIL)) {
      return resolveUserAlias(next, seen);
    }
    return { candidates: [resolveVersionAlias(next) ?? next] };
  }

  const candidates: string[] = [];
  let nestedCooldownMs: number | undefined;
  for (const candidate of target.candidates) {
    if (candidate.startsWith(MODEL_ALIAS_SIGIL)) {
      const nested = resolveUserAlias(candidate, new Set(seen));
      candidates.push(...nested.candidates);
      nestedCooldownMs ??= nested.cooldownMs;
    } else {
      candidates.push(resolveVersionAlias(candidate) ?? candidate);
    }
  }
  const uniqueCandidates = [...new Set(candidates)];
  const cooldownMs = target.cooldown !== undefined
    ? parseDurationMs(target.cooldown, { bareUnit: 'seconds', field: `models.aliases.${name}.cooldown` })
    : nestedCooldownMs;
  return {
    candidates: uniqueCandidates,
    ...(cooldownMs !== undefined && { cooldownMs }),
  };
}

/**
 * Resolve a version alias to its concrete model string, or undefined when the
 * input is not one (already a real id, or unknown).
 */
function resolveVersionAlias(modelString: string): string | undefined {
  const parts = splitModelString(modelString);
  // A real model id always wins, so `openai:gpt-5.6` and a hypothetical model
  // literally named like an alias both resolve to themselves.
  if (getModelFromRegistry(`${parts.provider}:${parts.modelId}`)) return undefined;

  const resolvedId = getVersionAliasTable().get(
    `${parts.provider}:${parts.modelId}`.toLowerCase()
  );
  if (!resolvedId) return undefined;

  return joinModelString({ ...parts, modelId: resolvedId });
}

/**
 * The model to use when an agent file omits `model`, or undefined when none is
 * configured. `AGENTUSE_MODEL` wins over the config file, matching how every
 * other AgentUse default resolves (shell env > .env > config.json).
 */
export function getConfiguredModelDefault(): string | undefined {
  const fromEnv = process.env[MODEL_DEFAULT_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = loadModelSettings().default?.trim();
  return fromConfig || undefined;
}

/**
 * Resolve the model for an agent whose frontmatter may omit it. Returns the
 * concrete model plus what was written, or undefined when no model was named
 * and no default is configured (the caller reports that as a config error, with
 * its own field/telemetry framing).
 */
export function resolveAgentModel(frontmatterModel: string | undefined): ResolvedModel | undefined {
  if (frontmatterModel !== undefined && frontmatterModel.trim() !== '') {
    return resolveModelString(frontmatterModel);
  }
  const fallback = getConfiguredModelDefault();
  if (!fallback) return undefined;
  const resolved = resolveModelString(fallback);
  return {
    model: resolved.model,
    alias: resolved.alias ?? fallback,
    source: 'default',
    ...(resolved.candidates !== undefined && { candidates: resolved.candidates }),
    ...(resolved.cooldownMs !== undefined && { cooldownMs: resolved.cooldownMs }),
  };
}

/**
 * The model a resumed run must continue on, or undefined to keep what the
 * freshly parsed agent already says.
 *
 * A resume re-reads the agent file, so an agent that names its model by alias
 * (or leans on the configured default) would otherwise pick up whatever that
 * alias points at *now*: a registry refresh between suspend and approval would
 * change model, cost, and behavior in the middle of one conversation. The model
 * recorded on the session wins for those.
 *
 * A concrete id in the file is left alone: someone wrote that version down, and
 * editing it between suspend and resume is a deliberate act.
 */
export function resumeModelPin(
  config: { model: string; modelSource?: ModelResolutionSource | undefined },
  sessionModel: string | undefined
): string | undefined {
  if (!config.modelSource) return undefined;
  if (!sessionModel || sessionModel === config.model) return undefined;
  return sessionModel;
}

/** Test seam: drop the derived alias table (config caching lives in global-config). */
export function resetModelAliasCache(): void {
  versionAliasTable = null;
  loggedResolutions.clear();
}
