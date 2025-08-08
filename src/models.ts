import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { AnthropicAuth } from './auth/anthropic';
import { logger } from './utils/logger';

interface ModelConfig {
  provider: string;
  modelName: string;
  envVar?: string;
  envSuffix?: string;
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
    // Check for OAuth token first (handles refresh automatically)
    const oauthToken = await AnthropicAuth.access();
    if (oauthToken) {
      logger.info('Using Anthropic OAuth token for authentication');
      // For OAuth, we need to use a custom fetch to set Bearer token
      const anthropic = createAnthropic({ 
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
          return fetch(input, {
            ...init,
            headers,
          });
        },
      });
      return anthropic.chat(config.modelName);
    }
    
    // Fall back to API key authentication
    let apiKey: string | undefined;
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new Error(`Missing ${config.envVar} environment variable`);
      }
      logger.info(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`ANTHROPIC_API_KEY${suffix}`];
      if (!apiKey) {
        throw new Error(`Missing ANTHROPIC_API_KEY${suffix} environment variable`);
      }
      logger.info(`Using ANTHROPIC_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('Missing ANTHROPIC_API_KEY environment variable and no OAuth token found');
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for Anthropic');
    }
    const anthropic = createAnthropic({ apiKey });
    return anthropic.chat(config.modelName);
    
  } else if (config.provider === 'openai') {
    let apiKey: string | undefined;
    
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new Error(`Missing ${config.envVar} environment variable`);
      }
      logger.info(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`OPENAI_API_KEY${suffix}`];
      if (!apiKey) {
        throw new Error(`Missing OPENAI_API_KEY${suffix} environment variable`);
      }
      logger.info(`Using OPENAI_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('Missing OPENAI_API_KEY environment variable');
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for OpenAI');
    }
    const openai = createOpenAI({ apiKey });
    return openai.chat(config.modelName);
    
  } else {
    throw new Error(`Unsupported provider: ${config.provider}`);
  }
}