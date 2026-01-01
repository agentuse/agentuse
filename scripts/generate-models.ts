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

// Provider mappings: models.dev provider ID -> our provider name + filters
const PROVIDER_MAPPINGS: Record<string, {
  ourProvider: 'anthropic' | 'openai' | 'openrouter';
  filter: (id: string) => boolean;
  transform: (id: string) => string;
}> = {
  // Anthropic models
  'anthropic': {
    ourProvider: 'anthropic',
    filter: (id: string) => id.includes('claude') && id.includes('4-5'),
    transform: (id: string) => id,
  },
  // OpenAI models
  'openai': {
    ourProvider: 'openai',
    filter: (id: string) => id.startsWith('gpt-5'),
    transform: (id: string) => id,
  },
  // MiniMax models via Nvidia -> OpenRouter (only latest m2.1)
  'nvidia': {
    ourProvider: 'openrouter',
    filter: (id: string) => id.includes('minimax-m2.1'),
    transform: (id: string) => {
      if (id.includes('/')) {
        const parts = id.split('/');
        return `minimax/${parts[1]}`;
      }
      return `minimax/${id}`;
    },
  },
  // OpenRouter direct (models already in openrouter format with correct pricing)
  'openrouter': {
    ourProvider: 'openrouter',
    filter: (id: string) => id === 'minimax/minimax-m2.1' || id.startsWith('z-ai/glm-4'),
    transform: (id: string) => id,
  },
};

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

  // Extract models from each provider
  for (const [providerId, mapping] of Object.entries(PROVIDER_MAPPINGS)) {
    const provider = apiData[providerId];
    if (!provider?.models) continue;

    for (const [modelId, model] of Object.entries(provider.models)) {
      if (mapping.filter(modelId)) {
        const transformedId = mapping.transform(modelId);
        registry[mapping.ourProvider][transformedId] = {
          ...model,
          id: transformedId,
        };
      }
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

  // Sort models: latest versions first, dated versions last
  const extractVersion = (id: string): number => {
    // Extract version number from model ID (e.g., "4.5", "5.2", "4.7")
    const match = id.match(/(\d+)\.(\d+)/);
    if (match) {
      return parseFloat(`${match[1]}.${match[2]}`);
    }
    // Try single digit version (e.g., "gpt-5")
    const singleMatch = id.match(/-(\d+)(?:-|$)/);
    if (singleMatch) {
      return parseFloat(singleMatch[1]);
    }
    return 0;
  };

  const sortModels = (models: ProviderModels): ProviderModels => {
    const entries = Object.entries(models);
    entries.sort(([a], [b]) => {
      // Dated versions (e.g., -20251101) go last
      const aHasDate = /\d{8}$/.test(a);
      const bHasDate = /\d{8}$/.test(b);
      if (aHasDate !== bHasDate) return aHasDate ? 1 : -1;

      // Sort by version number (higher = first)
      const aVersion = extractVersion(a);
      const bVersion = extractVersion(b);
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

  const defaultAnthropic = Object.keys(registry.anthropic)[0];
  const defaultOpenai = Object.keys(registry.openai)[0];
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
- **Anthropic**: \`anthropic:claude-sonnet-4-5\` (balanced performance)
- **OpenAI**: \`openai:gpt-5.2\` (latest GPT)
- **OpenRouter**: \`openrouter:${defaultOpenrouter}\` (open source)

## Recommended Models

${rows.join('\n')}

## Usage

Specify a model in your agent file:

\`\`\`yaml
---
model: anthropic:claude-sonnet-4-5
---
\`\`\`

Or override via CLI:

\`\`\`bash
agentuse run agent.agentuse -m openai:gpt-5.2
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

  // Find best matching model using fuzzy search
  const findBestMatch = (provider: string, oldModel: string): string | null => {
    const models = currentModels[provider];
    if (!models || models.length === 0) return null;

    // Extract key terms from old model (e.g., "sonnet", "haiku", "mini", "nano")
    const keyTerms = ['sonnet', 'opus', 'haiku', 'mini', 'nano', 'pro'];
    const oldTerms = keyTerms.filter(term => oldModel.toLowerCase().includes(term));

    // Find models that match the same terms
    const matchingModels = models.filter(m =>
      oldTerms.length === 0 || oldTerms.some(term => m.toLowerCase().includes(term))
    );

    if (matchingModels.length > 0) {
      // Return first match (already sorted by latest version)
      return matchingModels[0];
    }

    // Fallback to first model
    return models[0];
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
      content = newContent;
    }

    if (modified) {
      writeFileSync(filePath, content);
      console.log(`  Updated: ${relative(projectRoot, filePath)}`);
    } else {
      console.log(`  Checked: ${relative(projectRoot, filePath)} (no changes)`);
    }
  };

  const walkDir = (dir: string, extensions: string[]): void => {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules' && entry !== 'generated') {
        walkDir(fullPath, extensions);
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

  // Update docs
  const docsDir = join(projectRoot, 'docs');
  try {
    walkDir(docsDir, ['.mdx', '.md']);
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
