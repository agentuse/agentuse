import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel } from 'ai';
import { AnthropicAuth } from './auth/anthropic';
import { logger } from './utils/logger';
import { warnIfModelNotInRegistry } from './utils/model-utils';

/**
 * Check if DevTools is enabled via environment variable
 */
function isDevToolsEnabled(): boolean {
  return process.env.AGENTUSE_DEVTOOLS === 'true';
}

// Cache for DevTools middleware (lazy loaded)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let devToolsMiddlewareCache: any = null;
let devToolsLoadAttempted = false;

/**
 * Wrap model with DevTools middleware if enabled (dev dependency, dynamically imported)
 */
async function maybeWrapWithDevTools<T>(model: T): Promise<T> {
  if (!isDevToolsEnabled()) {
    return model;
  }

  // Try to load devtools (dev dependency, may not be installed in production)
  if (!devToolsLoadAttempted) {
    devToolsLoadAttempted = true;
    try {
      const { devToolsMiddleware } = await import('@ai-sdk/devtools');
      devToolsMiddlewareCache = devToolsMiddleware();
      logger.info('DevTools enabled - run `npx @ai-sdk/devtools` to inspect agent runs');
    } catch {
      logger.warn('DevTools requested but @ai-sdk/devtools not installed. Run: pnpm add -D @ai-sdk/devtools');
    }
  }

  if (!devToolsMiddlewareCache) {
    return model;
  }

  // wrapLanguageModel expects LanguageModelV3, which is what providers return
  return wrapLanguageModel({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: model as any,
    middleware: devToolsMiddlewareCache,
  }) as T;
}

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
 * - "openai:gpt-5.2" -> default env vars
 * - "openai:gpt-5.2:dev" -> use _DEV suffix
 * - "openai:gpt-5.2:OPENAI_API_KEY_PERSONAL" -> use specific env var
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
  // Validate model and warn if not in registry (non-blocking)
  warnIfModelNotInRegistry(modelString);

  const config = parseModelConfig(modelString);
  
  if (config.provider === 'anthropic') {
    const baseURL = resolveBaseURL(config, 'anthropic');
    // Check for OAuth token first (handles refresh automatically)
    const oauthToken = await AnthropicAuth.access();
    if (oauthToken) {
      logger.debug('Using Anthropic OAuth token for authentication');
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
      return await maybeWrapWithDevTools(anthropic.chat(config.modelName));
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
      logger.debug(`Using ${config.envVar} for authentication`);
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
      logger.debug(`Using ANTHROPIC_API_KEY${suffix} for authentication`);
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
    return await maybeWrapWithDevTools(anthropic.chat(config.modelName));

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
      logger.debug(`Using ${config.envVar} for authentication`);
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
      logger.debug(`Using OPENAI_API_KEY${suffix} for authentication`);
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
    return await maybeWrapWithDevTools(openai.chat(config.modelName));

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
      logger.debug(`Using ${config.envVar} for authentication`);
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
      logger.debug(`Using OPENROUTER_API_KEY${suffix} for authentication`);
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
    return await maybeWrapWithDevTools(openrouter.chat(config.modelName));

  } else {
    throw new Error(`Unsupported provider: ${config.provider}`);
  }
}