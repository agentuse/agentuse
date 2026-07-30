/**
 * Rewriting model references in files.
 *
 * Two jobs, one mechanism:
 *  - bump: a pinned model that has been superseded is moved to the current model
 *    of the same product line (what `pnpm generate:models` does to this repo's
 *    docs and templates, and what `agentuse models bump` does to agent files).
 *  - unpin: a pinned model is replaced by its version alias, so the file tracks
 *    the line from then on and never needs bumping again.
 */

import { getSuggestedModelIds } from '../generated/models';
import { deriveModelAlias, getVersionAliasesForProvider } from './model-alias';
import { splitModelString } from './model-utils';

/** Provider -> its current model ids, newest first. */
export type CurrentModels = Record<string, string[]>;

/**
 * True only when `term` appears as a whole token (split on non-letters), so
 * "mini" matches "gpt-5-mini" but NOT "gemini" — the substring match that used
 * to send MiniMax references to Gemini.
 */
function hasToken(id: string, term: string): boolean {
  return id.toLowerCase().split(/[^a-z]+/).includes(term);
}

/** Tier/line keywords that distinguish products within a vendor or provider. */
const LINE_TERMS = [
  'sonnet', 'opus', 'haiku', 'fable', 'codex', 'mini', 'nano', 'pro', 'max', 'plus',
  'flash', 'air', 'turbo', 'lite', 'chat', 'spark', 'sol', 'luna', 'terra',
];

/**
 * Find the model that supersedes a now-stale reference: same vendor, same
 * product line, newest release. Returns null when the provider has no current
 * models to choose from.
 */
export function findCurrentModel(
  provider: string,
  oldModel: string,
  currentModels: CurrentModels
): string | null {
  const models = currentModels[provider];
  if (!models || models.length === 0) return null;

  const oldLine = LINE_TERMS.filter((t) => hasToken(oldModel, t));
  const sameLine = (candidates: string[]): string =>
    candidates.find((m) => oldLine.length > 0 && oldLine.every((t) => hasToken(m, t))) ??
    candidates.find((m) => oldLine.length === 0 || oldLine.some((t) => hasToken(m, t))) ??
    candidates[0]!;

  // OpenRouter "vendor/model" ids: stay within the same vendor (z-ai, minimax,
  // qwen, ...) so a MiniMax reference never becomes Gemini.
  if (oldModel.includes('/')) {
    const vendor = oldModel.split('/')[0];
    const sameVendor = models.filter((m) => m.split('/')[0] === vendor);
    if (sameVendor.length > 0) return sameLine(sameVendor);
    return models[0]!;
  }

  // Flat provider ids (anthropic/openai): match by product line.
  return sameLine(models);
}

/**
 * The current lineup as shipped in the generated registry: one model per product
 * line, newest first, dated pins excluded (they are not something to rewrite a
 * reference *to*).
 */
export function currentModelsFromRegistry(): CurrentModels {
  const out: CurrentModels = {};
  for (const suggested of getSuggestedModelIds()) {
    const { provider, modelId } = splitModelString(suggested);
    if (/-\d{8}$/.test(modelId)) continue;
    (out[provider] ??= []).push(modelId);
  }
  return out;
}

export interface ModelReferenceChange {
  from: string;
  to: string;
}

/**
 * Rewrite `provider:model` references via `rewrite`, which returns the
 * replacement model string or null to leave the reference alone.
 *
 * `providers` bounds the pattern to the providers whose ids are line-versioned
 * (bedrock ids carry region prefixes and a trailing `:0`, custom providers have
 * no registry), so nothing else in the text is treated as a model reference.
 */
export function rewriteModelReferences(
  text: string,
  providers: string[],
  rewrite: (provider: string, modelId: string) => string | null
): { text: string; changes: ModelReferenceChange[] } {
  if (providers.length === 0) return { text, changes: [] };
  const pattern = new RegExp(`(${providers.join('|')}):([a-zA-Z0-9_./-]+)`, 'g');
  const changes: ModelReferenceChange[] = [];

  const rewritten = text.replace(pattern, (match, provider: string, modelId: string) => {
    const replacement = rewrite(provider, modelId);
    if (!replacement || replacement === match) return match;
    changes.push({ from: match, to: replacement });
    return replacement;
  });

  return { text: rewritten, changes };
}

/**
 * Rewrite model references inside an agent file's YAML frontmatter only.
 *
 * Frontmatter is where models are configured (`model:`, subagent entries, a
 * verify judge). The instructions below it are prose that may legitimately
 * discuss specific model versions, and rewriting those would change what the
 * agent is asked to do.
 */
export function rewriteAgentFileModels(
  content: string,
  providers: string[],
  rewrite: (provider: string, modelId: string) => string | null
): { content: string; changes: ModelReferenceChange[] } {
  const bounds = frontmatterBounds(content);
  if (!bounds) return { content, changes: [] };

  const { text, changes } = rewriteModelReferences(
    content.slice(bounds.start, bounds.end),
    providers,
    rewrite
  );
  if (changes.length === 0) return { content, changes: [] };

  return {
    content: content.slice(0, bounds.start) + text + content.slice(bounds.end),
    changes,
  };
}

/** Character range of the YAML frontmatter body, excluding the `---` fences. */
function frontmatterBounds(content: string): { start: number; end: number } | null {
  const opening = content.match(/^---\r?\n/);
  if (!opening) return null;
  const start = opening[0].length;
  const closing = content.slice(start).match(/^---\s*$/m);
  if (!closing || closing.index === undefined) return null;
  return { start, end: start + closing.index };
}

/**
 * Replace a pinned model id with its version alias, or null when it has no
 * live alias (an unversioned id, or a line the shipped registry no longer
 * carries — leave those alone rather than guess).
 */
export function toVersionAlias(provider: string, modelId: string): string | null {
  const alias = deriveModelAlias(modelId);
  if (!alias) return null;
  const aliases = getVersionAliasesForProvider(provider);
  if (!(alias in aliases)) return null;
  return `${provider}:${alias}`;
}

/**
 * True when a reference is already a live version alias. Such references are
 * never rewritten: they track the newest release by design, and "updating" one
 * would pin it to today's model — the opposite of what it asks for.
 */
export function isLiveVersionAlias(provider: string, modelId: string): boolean {
  return modelId in getVersionAliasesForProvider(provider);
}
