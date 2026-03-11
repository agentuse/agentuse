/**
 * Model validation utilities with fuzzy matching suggestions
 */

import fuzzysort from 'fuzzysort';
import { getAllModelIds, getModelFromRegistry, type ModelInfo } from '../generated/models';
import { logger } from './logger';

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
  // Check if model exists in registry
  const model = getModelFromRegistry(modelString);
  if (model) {
    return { valid: true, model };
  }

  // Model not found - find similar ones using fuzzy matching
  const allModels = getAllModelIds();
  const results = fuzzysort.go(modelString, allModels, {
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

  const result = validateModel(modelString);

  if (!result.valid) {
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
  const allModels = getAllModelIds();
  const results = fuzzysort.go(modelString, allModels, {
    limit,
    threshold: -10000,
  });

  return results.map(r => r.target);
}
