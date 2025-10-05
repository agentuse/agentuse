import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { AnthropicAuth } from './auth/anthropic';
import { logger } from './utils/logger';

export class AuthenticationError extends Error {
  constructor(
    public provider: string,
    public envVar: string,
    message: string
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

interface ModelConfig {
  provider: string;
  modelName: string;
  envVar?: string;
  envSuffix?: string;
}

function resolveBaseURL(
  config: ModelConfig,
  provider: 'openai' | 'anthropic'
): string | undefined {
  const readEnv = (name: string | undefined) => {
    if (!name) return undefined;
    const value = process.env[name];
    return value && value.trim() !== '' ? value : undefined;
  };

  if (config.envVar) {
    const envVarBase = readEnv(`${config.envVar}_BASE_URL`);
    if (envVarBase) return envVarBase;
  }

  if (config.envSuffix) {
    const suffix = `_${config.envSuffix}`;
    const suffixBase = readEnv(`${provider.toUpperCase()}_BASE_URL${suffix}`);
    if (suffixBase) return suffixBase;
  }

  return readEnv(`${provider.toUpperCase()}_BASE_URL`);
}

/**
 * Parse model string to extract provider, model name, and optional env suffix
 * Format: "provider:model[:env]"
 * Examples:
 * - "openai:gpt-4-turbo" -> default env vars
 * - "openai:gpt-4-turbo:dev" -> use _DEV suffix
 * - "openai:gpt-4-turbo:OPENAI_API_KEY_PERSONAL" -> use specific env var
 */
function parseModelConfig(modelString: string): ModelConfig {
  const parts = modelString.split(':');
  const [provider, modelName, envPart] = parts.length >= 2 
    ? parts 
    : ['openai', modelString, undefined];
  
  if (!envPart) {
    return { provider, modelName };
  }
  
  // Determine if envPart is a full env var or just a suffix
  const isFullEnvVar = envPart.includes('_KEY');
  return {
    provider,
    modelName,
    ...(isFullEnvVar 
      ? { envVar: envPart }
      : { envSuffix: envPart.toUpperCase() })
  };
}

/**
 * Create AI model instance based on configuration
 */
export async function createModel(modelString: string) {
  const config = parseModelConfig(modelString);
  
  if (config.provider === 'anthropic') {
    const baseURL = resolveBaseURL(config, 'anthropic');
    // Check for OAuth token first (handles refresh automatically)
    const oauthToken = await AnthropicAuth.access();
    if (oauthToken) {
      logger.info('Using Anthropic OAuth token for authentication');
      // For OAuth, we need to use a custom fetch to set Bearer token
      const anthropicOptions: Record<string, any> = {
        apiKey: '', // Empty API key for OAuth
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const access = await AnthropicAuth.access();
          const headers: Record<string, string> = {
            ...((init?.headers || {}) as Record<string, string>),
            'authorization': `Bearer ${access}`,
            'anthropic-beta': 'oauth-2025-04-20',
          };
          // Remove x-api-key header since we're using Bearer auth
          if ('x-api-key' in headers) {
            delete headers['x-api-key'];
          }
          return fetch(input as RequestInfo | URL, {
            ...init,
            headers,
          });
        },
      };

      if (baseURL) {
        anthropicOptions.baseURL = baseURL;
      }

      const anthropic = createAnthropic(anthropicOptions);
      return anthropic.chat(config.modelName);
    }
    
    // Fall back to API key authentication
    let apiKey: string | undefined;
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new AuthenticationError(
          'anthropic',
          config.envVar,
          `No authentication found for Anthropic (missing ${config.envVar})`
        );
      }
      logger.info(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`ANTHROPIC_API_KEY${suffix}`];
      if (!apiKey) {
        throw new AuthenticationError(
          'anthropic',
          `ANTHROPIC_API_KEY${suffix}`,
          `No authentication found for Anthropic (missing ANTHROPIC_API_KEY${suffix})`
        );
      }
      logger.info(`Using ANTHROPIC_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new AuthenticationError(
          'anthropic',
          'ANTHROPIC_API_KEY',
          'No authentication found for Anthropic'
        );
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for Anthropic');
    }
    const anthropicOptions: { apiKey: string; baseURL?: string } = { apiKey };
    if (baseURL) {
      anthropicOptions.baseURL = baseURL;
    }
    const anthropic = createAnthropic(anthropicOptions);
    return anthropic.chat(config.modelName);
    
  } else if (config.provider === 'openai') {
    let apiKey: string | undefined;
    
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new AuthenticationError(
          'openai',
          config.envVar,
          `No authentication found for OpenAI (missing ${config.envVar})`
        );
      }
      logger.info(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`OPENAI_API_KEY${suffix}`];
      if (!apiKey) {
        throw new AuthenticationError(
          'openai',
          `OPENAI_API_KEY${suffix}`,
          `No authentication found for OpenAI (missing OPENAI_API_KEY${suffix})`
        );
      }
      logger.info(`Using OPENAI_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new AuthenticationError(
          'openai', 
          'OPENAI_API_KEY',
          'No authentication found for OpenAI'
        );
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for OpenAI');
    }
    const baseURL = resolveBaseURL(config, 'openai');
    const openaiOptions: { apiKey: string; baseURL?: string } = { apiKey };
    if (baseURL) {
      openaiOptions.baseURL = baseURL;
    }
    const openai = createOpenAI(openaiOptions);
    return openai.chat(config.modelName);
    
  } else if (config.provider === 'openrouter') {
    let apiKey: string | undefined;
    
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new AuthenticationError(
          'openrouter',
          config.envVar,
          `No authentication found for OpenRouter (missing ${config.envVar})`
        );
      }
      logger.info(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`OPENROUTER_API_KEY${suffix}`];
      if (!apiKey) {
        throw new AuthenticationError(
          'openrouter',
          `OPENROUTER_API_KEY${suffix}`,
          `No authentication found for OpenRouter (missing OPENROUTER_API_KEY${suffix})`
        );
      }
      logger.info(`Using OPENROUTER_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new AuthenticationError(
          'openrouter',
          'OPENROUTER_API_KEY', 
          'No authentication found for OpenRouter'
        );
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for OpenRouter');
    }
    
    // OpenRouter uses OpenAI SDK with custom baseURL
    const openrouter = createOpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    return openrouter.chat(config.modelName);
    
  } else {
    throw new Error(`Unsupported provider: ${config.provider}`);
  }
}