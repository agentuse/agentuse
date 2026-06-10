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
  ourProvider: 'anthropic' | 'openai' | 'openrouter';
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
  { source: 'anthropic', ourProvider: 'anthropic', series: 'claude', filter: id => id.includes('claude') },
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
];

interface ModelData {
  id: string;
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  release_date?: string;
}

interface ProviderModels {
  [modelId: string]: ModelData;
}

interface Registry {
  anthropic: ProviderModels;
  openai: ProviderModels;
  openrouter: ProviderModels;
}

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
  };

  // 1. Collect filter-matched candidates, tagged with their series + retention window.
  interface Candidate {
    ourProvider: 'anthropic' | 'openai' | 'openrouter';
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

  return registry;
}

function generateRegistryCode(registry: Registry): string {
  const formatModel = (model: ModelData): string => {
    return `{
      id: '${model.id}',
      name: '${model.name}',
      reasoning: ${model.reasoning ?? false},
      toolCall: ${model.tool_call ?? false},
      modalities: {
        input: ${JSON.stringify(model.modalities?.input ?? ['text'])},
        output: ${JSON.stringify(model.modalities?.output ?? ['text'])},
      },
      limit: {
        context: ${model.limit?.context ?? 32000},
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
      .map(([id, model]) => `    '${id}': ${formatModel(model)}`)
      .join(',\n');
  };

  const sortModels = (models: ProviderModels): ProviderModels => {
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
  };

  registry.anthropic = sortModels(registry.anthropic);
  registry.openai = sortModels(registry.openai);
  registry.openrouter = sortModels(registry.openrouter);

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
    output: number;
  };
  /** Cost per token in USD (from models.dev) */
  cost: {
    input: number;
    output: number;
  };
}

export type Provider = 'anthropic' | 'openai' | 'openrouter';

export const MODELS: Record<Provider, Record<string, ModelInfo>> = {
  anthropic: {
${formatProvider(registry.anthropic)}
  },
  openai: {
${formatProvider(registry.openai)}
  },
  openrouter: {
${formatProvider(registry.openrouter)}
  },
};

// Get all supported model IDs as flat list
export function getAllModelIds(): string[] {
  const ids: string[] = [];
  for (const [provider, models] of Object.entries(MODELS)) {
    for (const modelId of Object.keys(models)) {
      ids.push(\`\${provider}:\${modelId}\`);
    }
  }
  return ids;
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

function generateDocsPage(registry: Registry): string {
  const formatModelRow = (provider: string, modelId: string, model: ModelData): string => {
    const capabilities: string[] = [];
    if (model.reasoning) capabilities.push('Reasoning');
    if (model.modalities?.input?.includes('image')) capabilities.push('Vision');
    if (model.tool_call) capabilities.push('Tools');

    return `| \`${provider}:${modelId}\` | ${model.name} | ${model.limit?.context?.toLocaleString() ?? 'N/A'} | ${model.limit?.output?.toLocaleString() ?? 'N/A'} | ${capabilities.join(', ') || '-'} |`;
  };

  const rows: string[] = [];

  rows.push('\n### Anthropic\n');
  rows.push('| Model ID | Name | Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry.anthropic)) {
    rows.push(formatModelRow('anthropic', id, model));
  }

  rows.push('\n### OpenAI\n');
  rows.push('| Model ID | Name | Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry.openai)) {
    rows.push(formatModelRow('openai', id, model));
  }

  rows.push('\n### OpenRouter\n');
  rows.push('| Model ID | Name | Context | Output | Capabilities |');
  rows.push('|----------|------|---------|--------|--------------|');
  for (const [id, model] of Object.entries(registry.openrouter)) {
    rows.push(formatModelRow('openrouter', id, model));
  }

  const anthropicKeys = Object.keys(registry.anthropic).filter(id => !/\d{8}$/.test(id));
  const openaiKeys = Object.keys(registry.openai).filter(id => !/\d{8}$/.test(id));
  const defaultAnthropic = anthropicKeys.find(id => id.includes('sonnet')) ?? anthropicKeys[0];
  const defaultOpenai = openaiKeys.find(id => /^gpt-\d+(\.\d+)?$/.test(id)) ?? openaiKeys[0];
  const defaultOpenrouter = Object.keys(registry.openrouter)[0];

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
- **Amazon Bedrock**: \`bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0\`

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

Specify a model in your agent file:

\`\`\`yaml
---
model: anthropic:${defaultAnthropic}
---
\`\`\`

Or override via CLI:

\`\`\`bash
agentuse run agent.agentuse -m openai:${defaultOpenai}
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

  // True only when `term` appears as a whole token (split on non-letters), so "mini" matches
  // "gpt-5-mini" but NOT "gemini" — the substring match that used to send MiniMax refs to Gemini.
  const hasToken = (id: string, term: string): boolean =>
    id.toLowerCase().split(/[^a-z]+/).includes(term);

  // Find the best replacement for a now-stale model reference.
  const findBestMatch = (provider: string, oldModel: string): string | null => {
    const models = currentModels[provider];
    if (!models || models.length === 0) return null;

    // Tier/line keywords that distinguish products within a vendor or provider.
    const lineTerms = ['sonnet', 'opus', 'haiku', 'codex', 'mini', 'nano', 'pro', 'max', 'plus',
      'flash', 'air', 'turbo', 'lite', 'chat'];
    const oldLine = lineTerms.filter(t => hasToken(oldModel, t));
    const sameLine = (candidates: string[]): string =>
      candidates.find(m => oldLine.length > 0 && oldLine.every(t => hasToken(m, t))) ??
      candidates.find(m => oldLine.length === 0 || oldLine.some(t => hasToken(m, t))) ??
      candidates[0];

    // OpenRouter "vendor/model" IDs: stay within the same vendor (z-ai, minimax, qwen, ...) so a
    // MiniMax example never becomes Gemini. Pick the same product line within that vendor.
    if (oldModel.includes('/')) {
      const vendor = oldModel.split('/')[0];
      const sameVendor = models.filter(m => m.split('/')[0] === vendor);
      if (sameVendor.length > 0) return sameLine(sameVendor);
      return models[0];
    }

    // Flat provider IDs (anthropic/openai): match by product line (models are sorted latest-first).
    return sameLine(models);
  };

  // Pattern to match any provider:model reference
  const modelPattern = /(anthropic|openai|openrouter):([a-zA-Z0-9_./-]+)/g;

  const processFile = (filePath: string): void => {
    let content = readFileSync(filePath, 'utf-8');
    let modified = false;

    const newContent = content.replace(modelPattern, (match, provider, oldModel) => {
      // Skip if it's already a current model
      if (currentModels[provider]?.includes(oldModel)) {
        return match;
      }

      const bestMatch = findBestMatch(provider, oldModel);
      if (bestMatch && bestMatch !== oldModel) {
        modified = true;
        return `${provider}:${bestMatch}`;
      }
      return match;
    });

    if (modified) {
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

    // Build registry
    const registry = buildRegistry(apiData);

    console.log('\nRegistry built:');
    console.log(`  Anthropic: ${Object.keys(registry.anthropic).length} models`);
    console.log(`  OpenAI: ${Object.keys(registry.openai).length} models`);
    console.log(`  OpenRouter: ${Object.keys(registry.openrouter).length} models`);

    // Generate registry TypeScript file
    const registryCode = generateRegistryCode(registry);
    const registryPath = join(projectRoot, 'src/generated/models.ts');
    writeFileSync(registryPath, registryCode);
    console.log(`\nGenerated: src/generated/models.ts`);

    // Generate docs page
    const docsContent = generateDocsPage(registry);
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
