/**
 * Model information API
 *
 * Uses the generated registry first, falls back to models.dev API for unknown models.
 */

import { getModelFromRegistry, getProviderModels, type ModelInfo as RegistryModelInfo } from '../generated/models';

export interface ModelInfo {
  provider: string;
  modelId: string;
  name: string;
  /** Prompt/input budget used for active-context compaction decisions. */
  contextLimit: number;
  /** Provider-reported total window when it differs from prompt/input budget. */
  totalContextLimit?: number;
  outputLimit: number;
}

// Fallback limits for models not in the registry (custom/local providers,
// unlisted bedrock ids, etc.). The context fallback is deliberately generous:
// under-estimating the window triggers premature, quality-degrading compaction
// (the original incident), whereas over-estimating is recoverable — the
// provider rejects and the reactive compaction/retry path in the runner copes.
// Override with AGENTUSE_FALLBACK_CONTEXT_LIMIT for a local model with a known
// (smaller or larger) window.
const DEFAULT_FALLBACK_CONTEXT_LIMIT = 200_000;
const DEFAULT_FALLBACK_OUTPUT_LIMIT = 4000;

function fallbackContextLimit(): number {
  const raw = process.env.AGENTUSE_FALLBACK_CONTEXT_LIMIT;
  if (raw === undefined) return DEFAULT_FALLBACK_CONTEXT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FALLBACK_CONTEXT_LIMIT;
}

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
    return toModelInfo(provider, modelId, registryModel);
  }

  // Bedrock ids carry a region/cross-region prefix (us./eu./apac./global.) that
  // may not match the exact region models.dev happened to list. Match on the
  // region-stripped id so a valid cross-region inference profile still resolves
  // to its real window instead of the fallback.
  if (provider === 'bedrock') {
    const resolved = resolveBedrockModel(modelId);
    if (resolved) {
      return toModelInfo(provider, modelId, resolved);
    }
  }

  // Fallback for unknown models (custom/local providers, unlisted bedrock ids).
  return {
    provider,
    modelId,
    name: modelId,
    contextLimit: fallbackContextLimit(),
    outputLimit: DEFAULT_FALLBACK_OUTPUT_LIMIT,
  };
}

/** Map a generated-registry model into the ModelInfo shape used for accounting. */
function toModelInfo(provider: string, modelId: string, model: RegistryModelInfo): ModelInfo {
  return {
    provider,
    modelId,
    name: model.name,
    contextLimit: model.limit.input ?? model.limit.context,
    ...(model.limit.input !== undefined && model.limit.context !== model.limit.input
      ? { totalContextLimit: model.limit.context }
      : {}),
    outputLimit: model.limit.output,
  };
}

// Leading AWS region / cross-region inference-profile prefix on a Bedrock model
// id (e.g. "us.", "eu.", "apac.", "global."). Stripped so region variants of
// the same underlying model share one registry entry.
const BEDROCK_REGION_PREFIX = /^(us-gov|us|eu|apac|ap|ca|sa|global)\./;

function stripBedrockRegion(id: string): string {
  return id.replace(BEDROCK_REGION_PREFIX, '');
}

/**
 * Resolve a Bedrock model id to its registry entry, tolerating region-prefix
 * mismatches: compares the region-stripped id against the region-stripped ids
 * of the generated bedrock bucket. Returns undefined if nothing matches.
 */
function resolveBedrockModel(modelId: string): RegistryModelInfo | undefined {
  const wanted = stripBedrockRegion(modelId);
  return getProviderModels('bedrock').find((m) => stripBedrockRegion(m.id) === wanted);
}
