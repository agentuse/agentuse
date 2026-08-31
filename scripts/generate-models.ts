#!/usr/bin/env npx tsx
/**
 * Generate model registry from models.dev API
 *
 * Run with: pnpm generate:models
 *
 * This script:
 * 1. Fetches model data from models.dev API
 * 2. Filters to only models we recommend (claude, gpt, glm, minimax)
 * 3. Generates src/generated/models.ts
 * 4. Generates docs/reference/models.mdx
 * 5. Updates model references in templates and docs
 */

import { writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { REGISTRY_PROVIDER_SOURCES } from '../src/providers/registry-sources';
import { findCurrentModel, isLiveVersionAlias, rewriteModelReferences } from '../src/utils/model-bump';
import { deriveModelAlias } from '../src/utils/model-alias';

const MODELS_DEV_API = 'https://models.dev/api.json';

/** Strip a trailing release-date suffix in either "-YYYYMMDD" or "-YYYY-MM-DD" form,
 *  so a dashed date never gets misread as a version number (e.g. gpt-4o-2024-11-20). */
function stripDate(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** Parse version from model ID as a comparable integer (major * 1000 + minor).
 *  Handles hyphen ("claude-sonnet-4-6"), dot ("gpt-5.2"), and letter-glued schemes
 *  ("deepseek-v4-pro", "kimi-k2.6", "minimax-m3", "glm-5v-turbo", "qwen3.7-max").
 *  NOTE: the loose fallback below assumes the caller has already excluded size/variant junk
 *  (e.g. qwen3-235b-a22b) via a family filter — it is only meant to run on curated IDs. */
function parseModelVersion(id: string): number {
  const base = stripDate(id);
  // Hyphen format: "claude-sonnet-4-6" -> 4006
  const hyphenMatch = base.match(/^.+?-(\d+)-(\d+)$/);
  if (hyphenMatch) return parseInt(hyphenMatch[1], 10) * 1000 + parseInt(hyphenMatch[2], 10);
  // Dot format: "gpt-5.2" -> 5002
  const dotMatch = base.match(/(\d+)\.(\d+)/);
  if (dotMatch) return parseInt(dotMatch[1], 10) * 1000 + parseInt(dotMatch[2], 10);
  // Single version: "gpt-5" -> 5000
  const singleMatch = base.match(/-(\d+)(?:-|$)/);
  if (singleMatch) return parseInt(singleMatch[1], 10) * 1000;
  // Loose fallback for letter-glued majors ("v4", "m3", "k2", "glm-5v", "qwen3"): last number run.
  const nums = base.match(/\d+(?:\.\d+)?/g);
  if (nums?.length) {
    const [maj, min] = nums[nums.length - 1].split('.');
    return parseInt(maj, 10) * 1000 + (min ? parseInt(min, 10) : 0);
  }
  return 0;
}

// Series definitions: one curated model line per entry.
//
// `filter` selects a model *line* by family name only (stable across releases) — it must NOT pin a
// version number, and it must be tight enough to exclude size/distill/modality junk
// (e.g. qwen3-235b-a22b, gemma, *-image, *-distill). The version floor is computed at runtime:
// for each `series` we find the highest major version present in the live models.dev API and keep
// only the current major (plus `keepMajors - 1` previous majors). This way a new major
// (GLM 5, GPT-6, MiniMax M3, DeepSeek V5, ...) is picked up automatically on the next
// `pnpm generate:models` and the prior major ages out — no code edits needed.
//
// Trade-off: during a *staggered* rollout (e.g. Claude ships opus-5 before sonnet/haiku catch up)
// the lagging models drop out until they reach the new major; just re-run the generator once the
// lineup fills in. Bump `keepMajors` if you want a wider window.
//
// To add a vendor: add one entry with a tight `filter`, then run `pnpm generate:models` and check
// the generated openrouter list to confirm the filter selects only the intended flagship line(s).
interface SeriesDef {
  /** models.dev provider ID to read from. */
  source: string;
  /** Provider bucket in our generated registry. */
  ourProvider: 'anthropic' | 'openai' | 'openrouter' | 'opencode-go';
  /** Floor bucket — models in the same series share one rolling major-version window. */
  series: string;
  /** Family/line match only — never version-pinned. */
  filter: (id: string) => boolean;
  /** Major versions to retain (1 = current major only). */
  keepMajors?: number;
  /** Rewrite the models.dev ID into our provider's ID form (default: identity). */
  transform?: (id: string) => string;
}

const SERIES: SeriesDef[] = [
  // Anthropic — claude-*
  // keepMajors: 2 — current major plus one previous, so a staggered rollout (Sonnet/Fable at 5 while
  // Opus/Haiku are still 4) keeps all current flagships without dragging in legacy Claude 3 lines.
  { source: 'anthropic', ourProvider: 'anthropic', series: 'claude', filter: id => id.includes('claude'), keepMajors: 2 },
  // OpenAI — gpt-N* (excludes non-versioned families like gpt-image / gpt-realtime).
  { source: 'openai', ourProvider: 'openai', series: 'gpt', filter: id => /^gpt-\d/.test(id) },

  // --- OpenRouter (open-weight + hosted models, by vendor) ---
  // GLM (z-ai): dotted minors + lettered variants (glm-5, glm-5.1, glm-5v-turbo),
  // but NOT size-suffixed base builds like glm-4-32b / glm-4-9b (the `-\d+-` shape).
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'glm',
    filter: id => id.startsWith('z-ai/glm-') && !/^z-ai\/glm-\d+-/.test(id),
  },
  // MiniMax (m-series flagship): minimax-m2.1, minimax-m3, ...
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'minimax',
    filter: id => /^minimax\/minimax-m\d/.test(id),
  },
  // DeepSeek (V-series flagship, pro/flash): deepseek-v4-pro, deepseek-v4-flash, ...
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'deepseek',
    filter: id => /^deepseek\/deepseek-v\d+(-pro|-flash)?$/.test(id),
  },
  // Qwen (hosted max/plus lines only — excludes open-weight size builds, vl, coder, distills).
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'qwen',
    filter: id => /^qwen\/qwen\d+(\.\d+)?-(max|plus)$/.test(id),
  },
  // Moonshot Kimi (K-series flagship): kimi-k2.5, kimi-k2.6, ... (excludes :free / dated / -thinking).
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'moonshotai',
    filter: id => /^moonshotai\/kimi-k\d+(\.\d+)?$/.test(id),
  },
  // Google Gemini (flash/pro lines — excludes lite, image, gemma, lyria, customtools).
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'gemini',
    filter: id => /^google\/gemini-\d+(\.\d+)?-(flash|pro)(-preview)?$/.test(id),
  },
  // xAI Grok (numbered flagship): grok-4.3, grok-4.20, ... (excludes grok-build, -multi-agent).
  {
    source: 'openrouter', ourProvider: 'openrouter', series: 'grok',
    filter: id => /^x-ai\/grok-\d+(\.\d+)?$/.test(id),
  },

  // --- OpenCode Go (latest flagship in each product line) ---
  // Keep these family-based, like OpenRouter, so regenerating replaces stale
  // versions instead of continuously growing the onboarding dropdown.
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-gpt',
    filter: id => /^gpt-\d+(\.\d+)?-[a-z][a-z0-9-]*$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-glm',
    filter: id => /^glm-\d+(\.\d+)?(-flash)?$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-grok',
    filter: id => /^grok-\d+(\.\d+)?$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-deepseek',
    filter: id => /^deepseek-v\d+(-pro|-flash)?$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-qwen',
    filter: id => /^qwen\d+(\.\d+)?-(max|plus|flash)$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-kimi',
    filter: id => /^kimi-k\d+(\.\d+)?$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-kimi-code',
    filter: id => /^kimi-k\d+(\.\d+)?-code$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-minimax',
    filter: id => /^minimax-m\d+(\.\d+)?$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-mimo',
    filter: id => /^mimo-v\d+(\.\d+)?(-pro)?$/.test(id),
  },
  {
    source: 'opencode-go', ourProvider: 'opencode-go', series: 'opencode-go-hy',
    filter: id => /^hy\d+(-preview)?$/.test(id),
  },
];

interface ModelData {
  id: string;
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number };
  release_date?: string;
}

interface ProviderModels {
  [modelId: string]: ModelData;
}

// Provider bucket -> its models. The full registry's buckets are dynamic
// (driven by REGISTRY_PROVIDER_SOURCES); the curated registry fills the
// first-class provider buckets targeted by SERIES.
type Registry = Record<string, ProviderModels>;

async function fetchModelsDevData(): Promise<Record<string, { models: Record<string, ModelData> }>> {
  console.log('Fetching models from models.dev...');
  const response = await fetch(MODELS_DEV_API);
  if (!response.ok) {
    throw new Error(`Failed to fetch models.dev: ${response.statusText}`);
  }
  return response.json();
}

function buildRegistry(apiData: Record<string, { models: Record<string, ModelData> }>): Registry {
  const registry: Registry = {
    anthropic: {},
    openai: {},
    openrouter: {},
    'opencode-go': {},
  };

  // 1. Collect filter-matched candidates, tagged with their series + retention window.
  interface Candidate {
    ourProvider: 'anthropic' | 'openai' | 'openrouter' | 'opencode-go';
    series: string;
    keepMajors: number;
    major: number;
    model: ModelData;
  }
  const candidates: Candidate[] = [];
  for (const def of SERIES) {
    const provider = apiData[def.source];
    if (!provider?.models) continue;

    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!def.filter(modelId)) continue;
      const transformedId = def.transform ? def.transform(modelId) : modelId;
      candidates.push({
        ourProvider: def.ourProvider,
        series: def.series,
        keepMajors: def.keepMajors ?? 1,
        major: Math.floor(parseModelVersion(transformedId) / 1000),
        model: { ...model, id: transformedId },
      });
    }
  }

  // 2. Compute the current (highest) major version per series from the live data — this is the
  //    auto-tracking floor that replaces hardcoded version cutoffs.
  const seriesMaxMajor: Record<string, number> = {};
  for (const c of candidates) {
    seriesMaxMajor[c.series] = Math.max(seriesMaxMajor[c.series] ?? 0, c.major);
  }

  // 3. Keep only models within the rolling major window for their series.
  for (const c of candidates) {
    if (c.major <= seriesMaxMajor[c.series] - c.keepMajors) continue;
    registry[c.ourProvider][c.model.id] = c.model;
  }

  // Deduplicate: within each product *line*, keep only the latest release.
  // A "line" is the model ID with its version numbers and date suffix blanked out, so all
  // versions of one product collapse together while distinct tiers stay separate, e.g.:
  //   gpt-5 / gpt-5.1 / gpt-5.5      -> "gpt-#"            (keep gpt-5.5)
  //   gpt-5.4-mini                  -> "gpt-#-mini"       (distinct tier, kept)
  //   kimi-k2 / kimi-k2.5 / k2.6    -> "moonshotai/kimi-k#" (keep kimi-k2.6)
  //   claude-haiku-4-5 + its -dated -> "claude-haiku-#-#" (keep one)
  // "Latest" is decided by models.dev release_date (so e.g. grok-4.3 beats grok-4.20 despite the
  // smaller minor number), falling back to the parsed version number when dates are missing/equal.
  // Blank out the whole version run (dot- OR hyphen-separated) so "claude-opus-4-8" and the older
  // "claude-opus-4" both become "claude-opus-#" and collapse, while "gpt-5.4-mini" stays a distinct
  // line from "gpt-5.4" (the trailing "-mini" is a word, not a version component).
  const modelLine = (id: string): string => stripDate(id).replace(/\d+(?:[.-]\d+)*/g, '#');
  for (const providerModels of Object.values(registry)) {
    const lines: Record<string, string[]> = {};
    for (const id of Object.keys(providerModels)) {
      (lines[modelLine(id)] ??= []).push(id);
    }
    for (const ids of Object.values(lines)) {
      const isDated = (id: string) => (/-\d{8}$/.test(id) || /-\d{4}-\d{2}-\d{2}$/.test(id) ? 1 : 0);
      ids.sort((a, b) => {
        const ra = providerModels[a].release_date ?? '';
        const rb = providerModels[b].release_date ?? '';
        // Only let the date decide when BOTH sides have one: a missing date is ''
        // and would otherwise sort last under the descending compare, dropping a
        // newer-but-undated model (e.g. a freshly listed gpt-5.5 with no date yet)
        // in favor of an older dated sibling. When a date is missing, fall through
        // to the version-number and clean-alias tie-breaks below.
        if (ra && rb && ra !== rb) return rb.localeCompare(ra); // newest release first
        const dv = parseModelVersion(b) - parseModelVersion(a);
        if (dv !== 0) return dv;
        return isDated(a) - isDated(b); // prefer the clean (non-dated) alias on a tie
      });
      for (const id of ids.slice(1)) delete providerModels[id];
    }
  }

  // Log what we found
  const counts = {
    anthropic: Object.keys(registry.anthropic).length,
    openai: Object.keys(registry.openai).length,
    openrouter: Object.keys(registry.openrouter).length,
    'opencode-go': Object.keys(registry['opencode-go']).length,
  };

  if (counts.anthropic === 0) {
    console.warn('Warning: No Anthropic models found in API');
  }
  if (counts.openai === 0) {
    console.warn('Warning: No OpenAI models found in API');
  }
  if (counts.openrouter === 0) {
    console.warn('Warning: No OpenRouter models found in API');
  }
  if (counts['opencode-go'] === 0) {
    console.warn('Warning: No OpenCode Go models found in API');
  }

  return registry;
}

/**
 * Full, unpruned registry: every model that each supported provider lists on
 * models.dev, mapped into our provider buckets. This is what powers
 * context-limit lookup, so an explicitly pinned valid model (e.g.
 * anthropic:claude-sonnet-4-6, opencode-go:kimi-k2.6,
 * bedrock:us.anthropic.claude-sonnet-4-5-...) keeps its real window instead of
 * collapsing to the fallback. The curated `buildRegistry` output is only for
 * *suggestions* and docs — see SUGGESTED_MODEL_IDS.
 *
 * Coverage is driven entirely by REGISTRY_PROVIDER_SOURCES (our provider prefix
 * -> models.dev provider key), so adding a provider there is all it takes.
 */
function buildFullRegistry(apiData: Record<string, { models: Record<string, ModelData> }>): Registry {
  const registry: Registry = {};
  for (const [bucket, source] of Object.entries(REGISTRY_PROVIDER_SOURCES)) {
    registry[bucket] = {};
    const provider = apiData[source];
    if (!provider?.models) {
      console.warn(`Warning: no models found on models.dev for source '${source}' (bucket '${bucket}')`);
      continue;
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isSelectableChatModel(modelId, model)) continue;
      registry[bucket][modelId] = { ...model, id: modelId };
    }
  }
  return registry;
}

/**
 * models.dev lists non-generative endpoints (embeddings, moderation, rerank,
 * image/audio/video generation, transcription) alongside chat models. Those
 * can't back an agent run and must not be treated as valid selectable models,
 * so they are excluded from the registry.
 *
 * Image/audio/video generators are caught by their output modality; the
 * text-output-but-not-chat endpoints (embeddings, moderation, rerank, whisper,
 * tts — which models.dev still tags `output: ["text"]`) are caught by id.
 */
function isSelectableChatModel(id: string, model: ModelData): boolean {
  const outputs = model.modalities?.output ?? ['text'];
  if (!outputs.includes('text')) return false;
  return !/(?:embed|moderation|rerank|whisper|transcrib|\btts\b|guardrail)/i.test(id);
}

/** Sort a provider's models latest-first (dated aliases last, then by version, then shortest id). */
function sortModels(models: ProviderModels): ProviderModels {
  const entries = Object.entries(models);
  entries.sort(([a], [b]) => {
    // Dated versions (e.g., -20251101) go last
    const aHasDate = /\d{8}$/.test(a);
    const bHasDate = /\d{8}$/.test(b);
    if (aHasDate !== bHasDate) return aHasDate ? 1 : -1;

    // Sort by version number (higher = first)
    const aVersion = parseModelVersion(a);
    const bVersion = parseModelVersion(b);
    if (aVersion !== bVersion) return bVersion - aVersion;

    // Same version: prefer shorter names (base model before variants)
    return a.length - b.length;
  });
  return Object.fromEntries(entries);
}

/** Flatten a registry into sorted `provider:id` strings (latest first per provider). */
function registryToIds(registry: Registry): string[] {
  const ids: string[] = [];
  for (const [provider, models] of Object.entries(registry)) {
    for (const id of Object.keys(sortModels(models))) {
      ids.push(`${provider}:${id}`);
    }
  }
  return ids;
}

/** Escape a string for emission inside a single-quoted TS literal (the full table
 *  includes third-party model names that may contain apostrophes/backslashes). */
function escSingle(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function generateRegistryCode(registry: Registry, suggestedIds: string[]): string {
  const formatModel = (model: ModelData): string => {
    return `{
      id: '${escSingle(model.id)}',
      name: '${escSingle(model.name)}',
      reasoning: ${model.reasoning ?? false},
      toolCall: ${model.tool_call ?? false},
      modalities: {
        input: ${JSON.stringify(model.modalities?.input ?? ['text'])},
        output: ${JSON.stringify(model.modalities?.output ?? ['text'])},
      },
      limit: {
        context: ${model.limit?.context ?? 32000},
${model.limit?.input !== undefined ? `        input: ${model.limit.input},\n` : ''}
        output: ${model.limit?.output ?? 4000},
      },
      cost: {
        input: ${model.cost?.input ?? 0},
        output: ${model.cost?.output ?? 0},
      },
    }`;
  };

  const formatProvider = (models: ProviderModels): string => {
    return Object.entries(models)
      .map(([id, model]) => `    '${escSingle(id)}': ${formatModel(model)}`)
      .join(',\n');
  };

  // Provider buckets are dynamic (driven by REGISTRY_PROVIDER_SOURCES). Sort
  // each, then emit the Provider union and MODELS object from whatever is here.
  const providerKeys = Object.keys(registry);
  for (const key of providerKeys) registry[key] = sortModels(registry[key]);
  const providerUnion = providerKeys.map((k) => `'${escSingle(k)}'`).join(' | ');
  const modelsBody = providerKeys
    .map((k) => `  '${escSingle(k)}': {\n${formatProvider(registry[k])}\n  }`)
    .join(',\n');

  return `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated by: pnpm generate:models
// Source: https://models.dev/api.json
// Last updated: ${new Date().toISOString()}

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  toolCall: boolean;
  modalities: {
    input: string[];
    output: string[];
  };
  limit: {
    context: number;
    /** Maximum prompt/input tokens when the provider reports it separately. */
    input?: number;
    output: number;
  };
  /** Cost in USD per MILLION tokens (models.dev convention). */
  cost: {
    input: number;
    output: number;
  };
}

export type Provider = ${providerUnion};

export const MODELS: Record<Provider, Record<string, ModelInfo>> = {
${modelsBody}
};

// Curated flagship lineup (one current model per product line). Used ONLY for
// fuzzy "did you mean" suggestions and docs — NOT for validity or limits, which
// read the full MODELS table above so any real model resolves correctly.
export const SUGGESTED_MODEL_IDS: string[] = [
${suggestedIds.map(id => `  '${escSingle(id)}'`).join(',\n')}
];

// Get every model ID known to the registry (full table) as a flat list.
export function getAllModelIds(): string[] {
  const ids: string[] = [];
  for (const [provider, models] of Object.entries(MODELS)) {
    for (const modelId of Object.keys(models)) {
      ids.push(\`\${provider}:\${modelId}\`);
    }
  }
  return ids;
}

// Get the curated suggestion lineup (for fuzzy match / docs).
export function getSuggestedModelIds(): string[] {
  return SUGGESTED_MODEL_IDS;
}

// Get model info by full model string (provider:modelId)
export function getModelFromRegistry(modelString: string): ModelInfo | undefined {
  const parts = modelString.split(':');
  const [provider, ...modelParts] = parts;
  const modelId = modelParts.join(':'); // Handle model IDs with colons

  const providerModels = MODELS[provider as Provider];
  if (!providerModels) return undefined;

  return providerModels[modelId];
}

// Check if model is in registry
export function isModelInRegistry(modelString: string): boolean {
  return getModelFromRegistry(modelString) !== undefined;
}

// Get all models for a provider
export function getProviderModels(provider: Provider): ModelInfo[] {
  return Object.values(MODELS[provider] || {});
}
`;
}

/**
 * Alias rows for the docs page, derived exactly as the runtime resolver derives
 * them (src/utils/model-alias.ts): the version comes off the curated id, and an
 * alias that collides with a real model id is dropped so it can never shadow one.
 */
function aliasRows(registry: Registry, fullRegistry: Registry): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const claimed = new Set<string>();
  for (const [provider, models] of Object.entries(registry)) {
    for (const id of Object.keys(models)) {
      const alias = deriveModelAlias(id);
      if (!alias) continue;
      const key = `${provider}:${alias}`;
      if (claimed.has(key)) continue;
      if (fullRegistry[provider]?.[alias]) continue;
      claimed.add(key);
      rows.push([key, `${provider}:${id}`]);
    }
  }
  return rows;
}

function generateDocsPage(registry: Registry, fullRegistry: Registry): string {
  const formatModelRow = (provider: string, modelId: string, model: ModelData): string => {
    const capabilities: string[] = [];
    if (model.reasoning) capabilities.push('Reasoning');
    if (model.modalities?.input?.includes('image')) capabilities.push('Vision');
    if (model.tool_call) capabilities.push('Tools');

    const inputContext = model.limit?.input ?? model.limit?.context;
    return `| \`${provider}:${modelId}\` | ${model.name} | ${inputContext?.toLocaleString() ?? 'N/A'} | ${model.limit?.output?.toLocaleString() ?? 'N/A'} | ${capabilities.join(', ') || '-'} |`;
  };

  const rows: string[] = [];

  rows.push('\n### Anthropic\n');
  rows.push('| Model ID | Name | Input Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry.anthropic)) {
    rows.push(formatModelRow('anthropic', id, model));
  }

  rows.push('\n### OpenAI\n');
  rows.push('| Model ID | Name | Input Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry.openai)) {
    rows.push(formatModelRow('openai', id, model));
  }

  rows.push('\n### OpenRouter\n');
  rows.push('| Model ID | Name | Input Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry.openrouter)) {
    rows.push(formatModelRow('openrouter', id, model));
  }

  rows.push('\n### OpenCode Go\n');
  rows.push('| Model ID | Name | Input Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry['opencode-go'])) {
    rows.push(formatModelRow('opencode-go', id, model));
  }

  const anthropicKeys = Object.keys(registry.anthropic).filter(id => !/\d{8}$/.test(id));
  const openaiKeys = Object.keys(registry.openai).filter(id => !/\d{8}$/.test(id));
  const defaultAnthropic = anthropicKeys.find(id => id.includes('sonnet')) ?? anthropicKeys[0];
  const defaultOpenai = openaiKeys.find(id => /^gpt-\d+(\.\d+)?$/.test(id)) ?? openaiKeys[0];
  const defaultOpenrouter = Object.keys(registry.openrouter)[0];
  const defaultOpenCodeGo = Object.keys(registry['opencode-go'])[0];
  const anthropicAliases = anthropicKeys
    .map((id) => deriveModelAlias(id))
    .filter((a): a is string => Boolean(a));
  const defaultAnthropicAlias = deriveModelAlias(defaultAnthropic) ?? defaultAnthropic;
  // The cheapest Anthropic line, used as the example for a "@fast" alias.
  const cheapAnthropicAlias = anthropicAliases.find((a) => a.includes('haiku')) ?? defaultAnthropicAlias;

  return `---
title: Model Reference
description: Recommended AI models for AgentUse
---

# Model Reference

This page lists recommended models for AgentUse, organized by provider.

> **Note**: Other models from these providers may also work. These are the ones we recommend and test against.

> **Auto-generated**: Run \`pnpm generate:models\` to update.

## Quick Reference

**Default models:**
- **Anthropic**: \`anthropic:${defaultAnthropic}\` (balanced performance)
- **OpenAI**: \`openai:${defaultOpenai}\` (latest GPT)
- **OpenRouter**: \`openrouter:${defaultOpenrouter}\` (open source)
- **OpenCode Go**: \`opencode-go:${defaultOpenCodeGo}\` (open coding models)
- **Amazon Bedrock**: \`bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0\`

## Version Aliases

Leave the version off a model id and you get whichever release is current, so an
agent file does not need editing every time a new model ships:

\`\`\`yaml
---
model: anthropic:${defaultAnthropicAlias}   # -> anthropic:${defaultAnthropic} today
---
\`\`\`

Aliases follow the lineup below, which is refreshed per AgentUse release. An id
that exists for real always wins, so nothing you pin can be reinterpreted.

| Alias | Currently resolves to |
|-------|----------------------|
${aliasRows(registry, fullRegistry).map(([alias, target]) => `| \`${alias}\` | \`${target}\` |`).join('\n')}

Run \`agentuse models\` to see what each alias resolves to on your install, and
\`agentuse models unpin\` to convert pinned ids in your agent files into aliases.

To name your own, add a \`models.aliases\` block to \`~/.agentuse/config.json\` and
reference it with the \`@\` sigil (see [Configuration Files](/reference/configuration-files#models)):

\`\`\`json
{ "models": { "default": "anthropic:${defaultAnthropicAlias}", "aliases": { "fast": "anthropic:${cheapAnthropicAlias}" } } }
\`\`\`

\`\`\`yaml
---
model: "@fast"
---
\`\`\`

Named aliases may also define ordered fallback candidates and an in-memory
cooldown. See [Model defaults and aliases](/reference/configuration-files#model-defaults-and-aliases).

## Recommended Models

${rows.join('\n')}

### Amazon Bedrock

Bedrock model IDs are passed through unchanged and are not validated against the static registry. Use any model ID supported by your AWS account and region.

| Model ID (example) | Notes |
|--------------------|-------|
| \`bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0\` | Claude Sonnet 4.5 (US cross-region inference profile) |
| \`bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0\` | Claude 3.5 Sonnet v2 |
| \`bedrock:anthropic.claude-3-haiku-20240307-v1:0\` | Claude 3 Haiku |
| \`bedrock:meta.llama3-70b-instruct-v1:0\` | Llama 3 70B Instruct |
| \`bedrock:mistral.mistral-large-2402-v1:0\` | Mistral Large |
| \`bedrock:us.amazon.nova-pro-v1:0\` | Amazon Nova Pro |

See the [Amazon Bedrock model catalog](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html) for the full list. Model availability depends on the AWS region and on the [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) granted in your account.

Authentication uses standard AWS environment variables (\`AWS_ACCESS_KEY_ID\` / \`AWS_SECRET_ACCESS_KEY\` / \`AWS_REGION\`, optional \`AWS_SESSION_TOKEN\`) or \`AWS_BEARER_TOKEN_BEDROCK\`. See the [Model Configuration guide](/guides/model-configuration#amazon-bedrock) for details.

## Custom Providers (Local LLMs)

In addition to the built-in providers above, you can connect any OpenAI-compatible endpoint as a custom provider:

\`\`\`bash
# Add Ollama
agentuse provider add ollama --url http://localhost:11434/v1

# Add LM Studio
agentuse provider add lmstudio --url http://localhost:1234/v1
\`\`\`

Then use any model available on those endpoints:

\`\`\`bash
agentuse run agent.agentuse -m ollama:glm-5-flash:q4_K_M
agentuse run agent.agentuse -m ollama:qwen3.5:0.8b
agentuse run agent.agentuse -m lmstudio:qwen/qwen3.5-9b
\`\`\`

See [Model Configuration](/guides/model-configuration#custom-providers-local-llms) for full setup details.

## Usage

Specify a model in your agent file, pinned to a version or tracking the line:

\`\`\`yaml
---
model: anthropic:${defaultAnthropic}   # pinned
---
\`\`\`

\`\`\`yaml
---
model: anthropic:${defaultAnthropicAlias}     # newest in this line
---
\`\`\`

Omit \`model\` entirely to use the configured default (\`models.default\` or
\`AGENTUSE_MODEL\`).

Or override via CLI, which accepts the same aliases:

\`\`\`bash
agentuse run agent.agentuse -m openai:${defaultOpenai}
agentuse run agent.agentuse -m openai:${deriveModelAlias(defaultOpenai) ?? defaultOpenai}
agentuse run agent.agentuse -m ollama:glm-5-flash:q4_K_M
\`\`\`
`;
}

function updateFileReferences(projectRoot: string, registry: Registry): void {
  // Build list of current models (without dated versions)
  const currentModels: Record<string, string[]> = {
    anthropic: Object.keys(registry.anthropic).filter(id => !/\d{8}$/.test(id)),
    openai: Object.keys(registry.openai).filter(id => !/\d{8}$/.test(id)),
    openrouter: Object.keys(registry.openrouter).filter(id => !/\d{8}$/.test(id)),
  };

  // Reference rewriting lives in src/utils/model-bump.ts so `agentuse models bump`
  // applies the identical rule to the user's own agent files.
  const providers = Object.keys(currentModels);

  const processFile = (filePath: string): void => {
    const content = readFileSync(filePath, 'utf-8');

    const { text: newContent, changes } = rewriteModelReferences(content, providers, (provider, oldModel) => {
      // Skip if it's already a current model
      if (currentModels[provider]?.includes(oldModel)) return null;
      // A version alias (`anthropic:claude-sonnet`) already tracks the newest
      // release; rewriting it to today's id would pin the docs to a version.
      if (isLiveVersionAlias(provider, oldModel)) return null;
      const bestMatch = findCurrentModel(provider, oldModel, currentModels);
      return bestMatch && bestMatch !== oldModel ? `${provider}:${bestMatch}` : null;
    });

    if (changes.length > 0) {
      writeFileSync(filePath, newContent);
      console.log(`  Updated: ${relative(projectRoot, filePath)}`);
    } else {
      console.log(`  Checked: ${relative(projectRoot, filePath)} (no changes)`);
    }
  };

  const walkDir = (dir: string, extensions: string[], ignorePaths: string[] = []): void => {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (ignorePaths.includes(fullPath)) continue;
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules' && entry !== 'generated') {
        walkDir(fullPath, extensions, ignorePaths);
      } else if (stat.isFile() && extensions.some(ext => entry.endsWith(ext))) {
        processFile(fullPath);
      }
    }
  };

  console.log('\nUpdating model references in files...');

  // Update templates
  const templatesDir = join(projectRoot, 'templates');
  try {
    walkDir(templatesDir, ['.agentuse']);
  } catch {
    console.log('  No templates directory found');
  }

  // Update docs (skip auto-generated models.mdx)
  const docsDir = join(projectRoot, 'docs');
  try {
    walkDir(docsDir, ['.mdx', '.md'], [join(projectRoot, 'docs/reference/models.mdx')]);
  } catch {
    console.log('  No docs directory found');
  }

  // Update README
  try {
    processFile(join(projectRoot, 'README.md'));
  } catch {
    console.log('  No README.md found');
  }
}

async function main(): Promise<void> {
  const projectRoot = join(import.meta.dirname, '..');

  try {
    // Fetch from API
    const apiData = await fetchModelsDevData();

    // Full table (all models from source providers) — powers limits + validity.
    const fullRegistry = buildFullRegistry(apiData);
    // Curated flagship lineup — powers suggestions, docs, and stale-ref rewrites.
    // Sort here: generateRegistryCode only sorts the full table, so the curated
    // object must be sorted before generateDocsPage / updateFileReferences /
    // registryToIds consume it (they all rely on latest-first ordering).
    const registry = buildRegistry(apiData);
    for (const key of Object.keys(registry)) registry[key] = sortModels(registry[key]);
    const suggestedIds = registryToIds(registry);

    console.log('\nFull registry (limits + validity):');
    for (const [bucket, models] of Object.entries(fullRegistry)) {
      console.log(`  ${bucket}: ${Object.keys(models).length} models`);
    }
    console.log(`Curated suggestions: ${suggestedIds.length} models`);

    // Generate registry TypeScript file
    const registryCode = generateRegistryCode(fullRegistry, suggestedIds);
    const registryPath = join(projectRoot, 'src/generated/models.ts');
    writeFileSync(registryPath, registryCode);
    console.log(`\nGenerated: src/generated/models.ts`);

    // Generate docs page
    const docsContent = generateDocsPage(registry, fullRegistry);
    const docsPath = join(projectRoot, 'docs/reference/models.mdx');
    try {
      writeFileSync(docsPath, docsContent);
      console.log(`Generated: docs/reference/models.mdx`);
    } catch {
      console.log('Skipped docs generation (no docs directory)');
    }

    // Update references in templates and docs
    updateFileReferences(projectRoot, registry);

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
