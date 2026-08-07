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
    // An OpenRouter vendor is part of the model's identity. Falling back to an
    // unrelated vendor turns a maintenance command into an invisible provider
    // migration (and can change cost, data handling, and capabilities).
    return null;
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
  const escapedProviders = providers.map((provider) => provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // A provider token must not begin in another provider name: without this
  // boundary, `myopenai:gpt-5.4-mini` matches the `openai:` suffix and gets
  // rewritten even though it is a custom provider.
  const pattern = new RegExp(`(?<![a-zA-Z0-9_-])(${escapedProviders.join('|')}):([a-zA-Z0-9_./-]+)`, 'g');
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
 * Rewrite actual model-valued fields inside an agent file's YAML frontmatter.
 *
 * Restrict this to the top-level `model:`, `verify.model:`, and
 * `learning.model:` fields. YAML
 * frontmatter also contains free-form `metadata`, MCP headers, and tokens;
 * changing model-looking text there corrupts user configuration rather than
 * updating a model selection. The instructions below it are likewise prose.
 */
export function rewriteAgentFileModels(
  content: string,
  providers: string[],
  rewrite: (provider: string, modelId: string) => string | null
): { content: string; changes: ModelReferenceChange[] } {
  const bounds = frontmatterBounds(content);
  if (!bounds) return { content, changes: [] };

  const { text, changes } = rewriteModelFields(content.slice(bounds.start, bounds.end), providers, rewrite);
  if (changes.length === 0) return { content, changes: [] };

  return {
    content: content.slice(0, bounds.start) + text + content.slice(bounds.end),
    changes,
  };
}

/** Rewrite scalar values of the model fields recognized by the agent schema. */
function rewriteModelFields(
  frontmatter: string,
  providers: string[],
  rewrite: (provider: string, modelId: string) => string | null
): { text: string; changes: ModelReferenceChange[] } {
  const lines = frontmatter.split(/(\r?\n)/);
  const changes: ModelReferenceChange[] = [];
  let modelSectionIndent: number | null = null;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index]!;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() !== '' && modelSectionIndent !== null && indent <= modelSectionIndent) {
      modelSectionIndent = null;
    }
    if (/^\s*(?:verify|learning)\s*:\s*(?:#.*)?$/.test(line)) {
      modelSectionIndent = indent;
      continue;
    }

    const isTopLevelModel = indent === 0;
    const isConfiguredHelperModel = modelSectionIndent !== null && indent > modelSectionIndent;
    if (!isTopLevelModel && !isConfiguredHelperModel) continue;

    // Preserve YAML quoting, whitespace, and an inline comment; only the
    // scalar model value is eligible for a replacement.
    const field = line.match(/^(\s*model\s*:\s*)(["']?)([^"'#\r\n]*?)\2(\s*(?:#.*)?)$/);
    if (!field) continue;
    const [, prefix, quote, value, suffix] = field;
    const rewritten = rewriteModelReferences(value!, providers, rewrite);
    if (rewritten.changes.length === 0) continue;
    lines[index] = `${prefix}${quote}${rewritten.text}${quote}${suffix}`;
    changes.push(...rewritten.changes);
  }

  return { text: lines.join(''), changes };
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
