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

/**
 * Warn if model is not in registry (non-blocking)
 * Returns the original model string to continue with
 */
export function warnIfModelNotInRegistry(modelString: string): string {
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
