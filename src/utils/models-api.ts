interface Model {
  id: string;
  name: string;
  reasoning?: boolean;
  attachment?: boolean;
  release_date?: string;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
}

interface Provider {
  id: string;
  name: string;
  models: Record<string, Model>;
}

interface ModelsApiResponse {
  [providerId: string]: Provider;
}

interface ModelSuggestion {
  provider: string;
  modelId: string;
  displayName: string;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
}

let cachedData: { data: ModelsApiResponse; timestamp: number } | null = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function fetchModelsData(): Promise<ModelsApiResponse | null> {
  // Check cache
  if (cachedData && Date.now() - cachedData.timestamp < CACHE_DURATION) {
    return cachedData.data;
  }

  try {
    const response = await fetch('https://models.dev/api.json');
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as ModelsApiResponse;
    cachedData = { data, timestamp: Date.now() };
    return data;
  } catch {
    return null;
  }
}

function selectBestModel(provider: Provider): Model | null {
  const models = Object.values(provider.models);
  if (models.length === 0) return null;

  // Sort by: reasoning capability, multimodal support, release date
  const sorted = models.sort((a, b) => {
    // Prioritize reasoning models
    if (a.reasoning !== b.reasoning) {
      return (b.reasoning ? 1 : 0) - (a.reasoning ? 1 : 0);
    }
    
    // Then multimodal (image/video support)
    const aMultimodal = a.modalities?.input?.some(m => ['image', 'video'].includes(m)) || false;
    const bMultimodal = b.modalities?.input?.some(m => ['image', 'video'].includes(m)) || false;
    if (aMultimodal !== bMultimodal) {
      return bMultimodal ? 1 : -1;
    }
    
    // Finally by release date (newest first)
    if (a.release_date && b.release_date) {
      return b.release_date.localeCompare(a.release_date);
    }
    
    return 0;
  });

  return sorted[0];
}

export async function getModelSuggestions(): Promise<ModelSuggestion[] | null> {
  const data = await fetchModelsData();
  if (!data) return null;

  const suggestions: ModelSuggestion[] = [];

  // Map our provider names to models.dev provider IDs
  const providerMapping: Record<string, string> = {
    'anthropic': 'anthropic',
    'openai': 'openai',
    'openrouter': 'openai' // OpenRouter uses various models, we'll show OpenAI as example
  };

  for (const [ourProvider, apiProvider] of Object.entries(providerMapping)) {
    const provider = data[apiProvider];
    if (!provider) continue;

    const bestModel = selectBestModel(provider);
    if (!bestModel) continue;

    let displayName = bestModel.name;
    
    // Add capability indicators
    const capabilities: string[] = [];
    if (bestModel.reasoning) capabilities.push('Reasoning');
    if (bestModel.modalities?.input?.includes('image')) capabilities.push('Vision');
    if (capabilities.length > 0) {
      displayName += ` (${capabilities.join(', ')})`;
    }

    suggestions.push({
      provider: ourProvider,
      modelId: bestModel.id,
      displayName
    });
  }

  // For OpenRouter, show Qwen models which are popular there
  const openrouterIndex = suggestions.findIndex(s => s.provider === 'openrouter');
  if (openrouterIndex >= 0) {
    // Check if we have Qwen/DeepInfra data (Qwen models are often listed there)
    if (data['deepinfra']) {
      const qwenModels = Object.entries(data['deepinfra'].models)
        .filter(([id]) => id.toLowerCase().includes('qwen'))
        .map(([_, model]) => model);
      
      if (qwenModels.length > 0) {
        // Pick the best Qwen model
        const bestQwen = qwenModels.sort((a, b) => {
          // Prefer newer/larger Qwen models
          if (a.release_date && b.release_date) {
            return b.release_date.localeCompare(a.release_date);
          }
          return 0;
        })[0];
        
        suggestions[openrouterIndex] = {
          provider: 'openrouter',
          modelId: `qwen/${bestQwen.id.split('/').pop()}`,
          displayName: `${bestQwen.name} via OpenRouter`
        };
      } else {
        // Fallback to a known good Qwen model
        suggestions[openrouterIndex] = {
          provider: 'openrouter',
          modelId: 'qwen/qwen-2.5-coder-32b-instruct',
          displayName: 'Qwen 2.5 Coder via OpenRouter'
        };
      }
    } else {
      // Default Qwen model if no API data
      suggestions[openrouterIndex] = {
        provider: 'openrouter',
        modelId: 'qwen/qwen-2.5-72b-instruct',
        displayName: 'Qwen 2.5 72B via OpenRouter'
      };
    }
  }

  return suggestions;
}

// Default context limits for unknown models
const DEFAULT_FALLBACK_CONTEXT_LIMIT = 32000;
const DEFAULT_FALLBACK_OUTPUT_LIMIT = 4000;

/**
 * Get model information including context limits from models.dev API
 * @param modelString - Model string in format "provider:model-id"
 * @returns ModelInfo with context and output limits
 */
export async function getModelInfo(modelString: string): Promise<ModelInfo> {
  // Parse model string
  const parts = modelString.split(':');
  const [provider, modelId] = parts.length >= 2 
    ? parts 
    : ['openai', modelString];

  // Fetch data from models.dev
  const data = await fetchModelsData();
  
  if (data) {
    // Map our provider names to models.dev provider IDs
    const providerMapping: Record<string, string> = {
      'anthropic': 'anthropic',
      'openai': 'openai',
      'openrouter': 'openai', // Will need special handling
      'groq': 'groq',
      'google': 'google',
      'cohere': 'cohere',
      'mistral': 'mistral'
    };

    const apiProvider = providerMapping[provider];
    if (apiProvider && data[apiProvider]) {
      const providerData = data[apiProvider];
      
      // Find the specific model
      const model = Object.values(providerData.models).find(m => 
        m.id === modelId || 
        m.id.endsWith(`/${modelId}`) ||
        modelId.includes(m.id)
      );

      if (model) {
        return {
          provider,
          modelId,
          name: model.name,
          contextLimit: model.limit?.context || DEFAULT_FALLBACK_CONTEXT_LIMIT,
          outputLimit: model.limit?.output || DEFAULT_FALLBACK_OUTPUT_LIMIT
        };
      }
    }
  }

  // Fallback for unknown models - use conservative estimates
  return {
    provider,
    modelId,
    name: modelId,
    contextLimit: DEFAULT_FALLBACK_CONTEXT_LIMIT,
    outputLimit: DEFAULT_FALLBACK_OUTPUT_LIMIT
  };
}