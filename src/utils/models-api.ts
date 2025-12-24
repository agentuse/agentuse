/**
 * Model information API
 *
 * Uses the generated registry first, falls back to models.dev API for unknown models.
 */

import { getModelFromRegistry } from '../generated/models';

export interface ModelInfo {
  provider: string;
  modelId: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
}

// Default context limits for unknown models
const DEFAULT_FALLBACK_CONTEXT_LIMIT = 32000;
const DEFAULT_FALLBACK_OUTPUT_LIMIT = 4000;

/**
 * Get model information including context limits
 *
 * Uses the generated registry first, falls back to conservative defaults for unknown models.
 *
 * @param modelString - Model string in format "provider:model-id"
 * @returns ModelInfo with context and output limits
 */
export async function getModelInfo(modelString: string): Promise<ModelInfo> {
  // Parse model string
  const parts = modelString.split(':');
  const [provider, ...modelParts] = parts.length >= 2
    ? parts
    : ['openai', modelString];
  const modelId = modelParts.join(':'); // Handle model IDs with colons

  // Check generated registry first
  const registryModel = getModelFromRegistry(modelString);
  if (registryModel) {
    return {
      provider,
      modelId,
      name: registryModel.name,
      contextLimit: registryModel.limit.context,
      outputLimit: registryModel.limit.output,
    };
  }

  // Fallback for unknown models - use conservative estimates
  return {
    provider,
    modelId,
    name: modelId,
    contextLimit: DEFAULT_FALLBACK_CONTEXT_LIMIT,
    outputLimit: DEFAULT_FALLBACK_OUTPUT_LIMIT,
  };
}
