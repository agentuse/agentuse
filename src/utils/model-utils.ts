/**
 * Model validation utilities with fuzzy matching suggestions
 */

import fuzzysort from 'fuzzysort';
import { getSuggestedModelIds, getModelFromRegistry, type ModelInfo } from '../generated/models';
import { logger } from './logger';
import { OPENCODE_GO_PROVIDER_ID } from '../providers/opencode-go';
import { BUILTIN_PROVIDERS } from '../providers/registry-sources';

/**
 * Resolve a model string to its canonical provider.
 *
 * Bare model IDs are OpenAI IDs. This mirrors createModel() and keeps every
 * caller from independently interpreting `gpt-*` as a custom provider.
 */
export function resolveModelProvider(modelString: string): string {
  const firstColon = modelString.indexOf(':');
  return firstColon === -1 ? 'openai' : modelString.slice(0, firstColon);
}

/**
 * Collapse the optional `:env` auth suffix so a model string can be looked up
 * in the registry. `provider:model:env` (e.g. anthropic:claude-fable-5:dev)
 * must resolve to the `provider:model` registry key; without this the suffix
 * is treated as part of the model id and every lookup silently misses,
 * defeating capability resolution (output-token clamp, reasoning summaries).
 * Mirrors parseModelConfig: only built-in providers use the suffix syntax;
 * bedrock and custom/opencode-go providers keep colons in their ids verbatim.
 */
export function toRegistryKey(modelString: string): string {
  const firstColon = modelString.indexOf(':');
  if (firstColon === -1) return `openai:${modelString}`;
  const provider = modelString.slice(0, firstColon);
  if (provider === 'bedrock' || !BUILTIN_PROVIDERS.includes(provider)) return modelString;
  const rest = modelString.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon === -1) return modelString;
  return `${provider}:${rest.slice(0, secondColon)}`;
}

export interface ValidationResult {
  valid: boolean;
  model?: ModelInfo;
  suggestions?: string[];
  warning?: string;
}

/**
 * Validate a model string and return suggestions if invalid
 */
export function validateModel(modelString: string): ValidationResult {
  if (modelString.startsWith('demo:')) {
    return { valid: true };
  }

  // Check if model exists in registry (strip any :env auth suffix first)
  const model = getModelFromRegistry(toRegistryKey(modelString));
  if (model) {
    return { valid: true, model };
  }

  // Model not found - suggest from the curated flagship lineup (not the full
  // table, which would surface hundreds of noisy near-matches).
  const suggestible = getSuggestedModelIds();
  const results = fuzzysort.go(modelString, suggestible, {
    limit: 3,
    threshold: -10000, // Include even weak matches
  });

  const suggestions = results.map(r => r.target);

  return {
    valid: false,
    suggestions,
    warning: `Model '${modelString}' not found in registry`,
  };
}

// Cache of known custom provider names (populated at startup)
let customProviderNamesCache: Set<string> | null = null;

/**
 * Load custom provider names into cache for sync access
 * Call this once at startup before model validation runs
 */
export async function loadCustomProviderNames(): Promise<void> {
  try {
    const { AuthStorage } = await import('../auth/storage.js');
    const providers = await AuthStorage.getCustomProviders();
    customProviderNamesCache = new Set(Object.keys(providers));
  } catch {
    customProviderNamesCache = new Set();
  }
}

/**
 * Check if a provider name is a known custom provider
 */
function isCustomProvider(provider: string): boolean {
  return customProviderNamesCache?.has(provider) ?? false;
}

// Models we've already warned about this process, so a model used across many
// agent/subagent runs (or resumes) only logs the "not in registry" notice once
// instead of on every createModel() call.
const warnedModels = new Set<string>();

/**
 * Warn if model is not in registry (non-blocking)
 * Returns the original model string to continue with
 */
export function warnIfModelNotInRegistry(modelString: string): string {
  // Skip validation for custom providers
  const parts = modelString.split(':');
  if (parts.length >= 2 && isCustomProvider(parts[0])) {
    return modelString;
  }

  // Skip validation for providers whose model lists are external to the static registry.
  if (parts.length >= 2 && (parts[0] === 'bedrock' || parts[0] === OPENCODE_GO_PROVIDER_ID)) {
    return modelString;
  }

  const result = validateModel(modelString);

  if (!result.valid && !warnedModels.has(modelString)) {
    warnedModels.add(modelString);
    logger.warn(`${result.warning}`);
    if (result.suggestions && result.suggestions.length > 0) {
      logger.warn(`Did you mean: ${result.suggestions.join(', ')}?`);
    }
    logger.warn('Continuing anyway - this model may still work if supported by the provider');
  }

  return modelString;
}

/**
 * Get fuzzy suggestions for a model string
 */
export function getSuggestions(modelString: string, limit = 5): string[] {
  const suggestible = getSuggestedModelIds();
  const results = fuzzysort.go(modelString, suggestible, {
    limit,
    threshold: -10000,
  });

  return results.map(r => r.target);
}
