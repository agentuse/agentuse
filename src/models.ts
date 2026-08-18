import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { wrapLanguageModel } from 'ai';
import { AnthropicAuth } from './auth/anthropic';
import { CodexAuth } from './auth/codex';
import { AuthStorage } from './auth/storage';
import { logger } from './utils/logger';
import { warnIfModelNotInRegistry, loadCustomProviderNames } from './utils/model-utils';
import { resolveModelString } from './utils/model-alias';
import { createDemoModel } from './providers/demo';
import {
  getOpenCodeGoProtocol,
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER_ID,
  resolveOpenCodeGoBaseURL,
} from './providers/opencode-go';
import { BUILTIN_PROVIDERS } from './providers/registry-sources';

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
    } catch (error) {
      logger.warn('DevTools requested but @ai-sdk/devtools not installed. Run: pnpm add -D @ai-sdk/devtools');
      logger.debug(`DevTools import error: ${error instanceof Error ? error.message : String(error)}`);
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
 * Native OpenAI (reached at the default api.openai.com base URL) is served by
 * the Responses API, which can carry images/PDFs inside a tool result and is
 * OpenAI's recommended surface. A custom base URL implies an OpenAI-compatible
 * endpoint that generally only implements Chat Completions, so those stay on
 * `.chat()`. Keep this in sync with {@link resolveMediaToolResultSupport}.
 */
function openaiApiKeyUsesResponses(baseURL: string | undefined): boolean {
  return !baseURL;
}

/** Which media kinds a model's transport can deliver inside a tool result. */
export interface MediaToolResultSupport {
  image: boolean;
  pdf: boolean;
}

/**
 * Resolve whether the model's *transport* can deliver an image/PDF inside a
 * tool result. This is distinct from the model's input modalities: a model may
 * accept images (per the registry) yet its wire transport cannot carry one in a
 * tool result. The AI SDK converters decide this per provider/transport:
 *  - Anthropic (Messages API): image + pdf.
 *  - OpenAI Responses API (OAuth, or API key on native OpenAI): image + pdf.
 *  - OpenAI Chat Completions (custom base URL) / OpenRouter: neither (media is
 *    stringified into text).
 *  - Bedrock: image only (a PDF/file-data part throws UnsupportedFunctionalityError).
 *  - Other/custom providers: neither (safe default).
 *
 * Kept in sync with the transport selection in {@link createModel}.
 */
export async function resolveMediaToolResultSupport(
  modelString: string
): Promise<MediaToolResultSupport> {
  const config = parseModelConfig(modelString);
  switch (config.provider) {
    case 'anthropic':
      return { image: true, pdf: true };
    case 'bedrock':
      return { image: true, pdf: false };
    case 'openai': {
      const hasOAuth = !config.envVar && !config.envSuffix && !!(await CodexAuth.access());
      if (hasOAuth) return { image: true, pdf: true };
      return openaiApiKeyUsesResponses(resolveBaseURL(config, 'openai'))
        ? { image: true, pdf: true }
        : { image: false, pdf: false };
    }
    default:
      // opencode-go models on the Anthropic protocol route through
      // createAnthropic().chat() (the Messages API) in createModel, which does
      // carry image + pdf in tool results — so don't stringify media for them.
      if (
        config.provider === OPENCODE_GO_PROVIDER_ID &&
        getOpenCodeGoProtocol(config.modelName) === 'anthropic'
      ) {
        return { image: true, pdf: true };
      }
      // openrouter (Chat-Completions-compatible), OpenAI-protocol opencode-go,
      // and custom providers cannot carry media in a tool result.
      return { image: false, pdf: false };
  }
}

/**
 * Parse model string to extract provider, model name, and optional env suffix
 * Format: "provider:model[:env]"
 * Examples:
 * - "openai:gpt-5.2" -> default env vars
 * - "openai:gpt-5.2:dev" -> use _DEV suffix
 * - "openai:gpt-5.2:OPENAI_API_KEY_PERSONAL" -> use specific env var
 */
export function parseModelConfig(modelString: string): ModelConfig {
  const firstColon = modelString.indexOf(':');
  if (firstColon === -1) {
    return { provider: 'openai', modelName: modelString };
  }

  const provider = modelString.slice(0, firstColon);
  const rest = modelString.slice(firstColon + 1);

  // Bedrock model IDs contain colons (e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0"),
  // so we keep the full remainder as the model name and don't support env-suffix syntax.
  if (provider === 'bedrock') {
    return { provider, modelName: rest };
  }

  // Built-in providers support the env suffix syntax: provider:model:env.
  // (bedrock returned above — its colon-bearing ids skip suffix parsing.)
  if (BUILTIN_PROVIDERS.includes(provider)) {
    const secondColon = rest.indexOf(':');
    if (secondColon === -1) {
      return { provider, modelName: rest };
    }

    const modelName = rest.slice(0, secondColon);
    const envPart = rest.slice(secondColon + 1);

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

  // Custom providers: everything after first colon is the model name
  // (supports colons in model names, e.g. ollama:qwen3.5:0.8b)
  return { provider, modelName: rest };
}

/**
 * Create AI model instance based on configuration
 */
export async function createModel(modelString: string) {
  // Load custom provider names for sync validation (cached after first call)
  await loadCustomProviderNames();

  // Agent models are resolved at parse time, so this is a no-op for them (and
  // for any concrete id). It exists for the callers that build a model string
  // themselves — benchmarks, the verify judge, compaction — so an alias works
  // wherever a model can be named.
  const resolvedString = resolveModelString(modelString).model;

  // Validate model and warn if not in registry (non-blocking)
  warnIfModelNotInRegistry(resolvedString);

  const config = parseModelConfig(resolvedString);
  
  if (config.provider === 'anthropic') {
    const baseURL = resolveBaseURL(config, 'anthropic');
    // Check for OAuth token first (handles refresh automatically). A stored
    // login that cannot be refreshed right now is held, not raised: an API key
    // in the environment still wins, and only an empty API key path reports it.
    let oauthToken: string | undefined;
    let oauthRefreshError: Error | undefined;
    try {
      oauthToken = await AnthropicAuth.access();
    } catch (error) {
      oauthRefreshError = error instanceof Error ? error : new Error(String(error));
      logger.debug(`Anthropic OAuth unavailable: ${oauthRefreshError.message}`);
    }
    if (oauthToken) {
      logger.debug('Using Anthropic OAuth token for authentication');
      // For OAuth, we need to use a custom fetch to set Bearer token
      const anthropicOptions: Record<string, any> = {
        apiKey: '', // Empty API key for OAuth
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const access = await AnthropicAuth.access();
          if (!access) {
            throw new Error('Anthropic OAuth token expired');
          }
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
      // Check environment variable first
      apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        logger.debug('Using ANTHROPIC_API_KEY for authentication');
      }

      // Fall back to stored credentials from `agentuse auth login`
      if (!apiKey) {
        const storedApiKey = await AuthStorage.getApiKey('anthropic');
        if (storedApiKey) {
          apiKey = storedApiKey.key;
          logger.debug('Using stored API key for Anthropic authentication');
        }
      }

      if (!apiKey) {
        throw new AuthenticationError(
          'anthropic',
          'ANTHROPIC_API_KEY',
          oauthRefreshError
            ? `${oauthRefreshError.message}. Stored credentials were kept - retry, ` +
              'or run `agentuse auth login anthropic` if it persists'
            : 'No authentication found for Anthropic. Run `agentuse auth login anthropic` or set ANTHROPIC_API_KEY'
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
    // Check for Codex OAuth token first (handles refresh automatically)
    const codexAccess = await CodexAuth.access();
    if (codexAccess && !config.envVar && !config.envSuffix) {
      logger.debug('Using ChatGPT OAuth for OpenAI authentication');

      // Simple fetch wrapper that only handles OAuth headers - no stream transformation needed
      // The AI SDK's openai.responses() speaks the Responses API format natively
      const codexFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const access = await CodexAuth.access();
        if (!access) {
          throw new Error('Codex OAuth token expired');
        }

        // Build headers from init
        const headers = new Headers(init?.headers);

        // Set Bearer token (remove any existing authorization header first)
        headers.delete('authorization');
        headers.delete('Authorization');
        headers.set('authorization', `Bearer ${access.token}`);

        // Set ChatGPT-Account-Id header for organization subscriptions
        if (access.accountId) {
          headers.set('ChatGPT-Account-Id', access.accountId);
        }

        return fetch(input, { ...init, headers });
      };

      const openai = createOpenAI({
        apiKey: 'codex-oauth', // Placeholder, custom fetch overrides auth
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetch: codexFetch as typeof fetch,
      });

      // Use openai.responses() which speaks the Responses API format natively
      return await maybeWrapWithDevTools(openai.responses(config.modelName));
    }

    // Fall back to API key authentication
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
      // Check environment variable first
      apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        logger.debug('Using OPENAI_API_KEY for authentication');
      }

      // Fall back to stored credentials from `agentuse auth login`
      if (!apiKey) {
        const storedApiKey = await AuthStorage.getApiKey('openai');
        if (storedApiKey) {
          apiKey = storedApiKey.key;
          logger.debug('Using stored API key for OpenAI authentication');
        }
      }

      if (!apiKey) {
        throw new AuthenticationError(
          'openai',
          'OPENAI_API_KEY',
          'No authentication found for OpenAI. Run `agentuse auth login openai` or set OPENAI_API_KEY'
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
    // Native OpenAI speaks the Responses API (richer tool-result content, incl.
    // images/PDFs in tool results). A custom base URL implies an OpenAI-compatible
    // proxy that typically only speaks Chat Completions, so keep .chat() there.
    return await maybeWrapWithDevTools(
      openaiApiKeyUsesResponses(baseURL)
        ? openai.responses(config.modelName)
        : openai.chat(config.modelName)
    );

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
      // Check environment variable first
      apiKey = process.env.OPENROUTER_API_KEY;
      if (apiKey) {
        logger.debug('Using OPENROUTER_API_KEY for authentication');
      }

      // Fall back to stored credentials from `agentuse auth login`
      if (!apiKey) {
        const storedApiKey = await AuthStorage.getApiKey('openrouter');
        if (storedApiKey) {
          apiKey = storedApiKey.key;
          logger.debug('Using stored API key for OpenRouter authentication');
        }
      }

      if (!apiKey) {
        throw new AuthenticationError(
          'openrouter',
          'OPENROUTER_API_KEY',
          'No authentication found for OpenRouter. Run `agentuse auth login openrouter` or set OPENROUTER_API_KEY'
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

  } else if (config.provider === OPENCODE_GO_PROVIDER_ID) {
    let apiKey: string | undefined;

    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new AuthenticationError(
          OPENCODE_GO_PROVIDER_ID,
          config.envVar,
          `No authentication found for ${OPENCODE_GO_DISPLAY_NAME} (missing ${config.envVar})`
        );
      }
      logger.debug(`Using ${config.envVar} for ${OPENCODE_GO_DISPLAY_NAME} authentication`);
    } else if (config.envSuffix) {
      const envVar = `${OPENCODE_GO_API_KEY_ENV}_${config.envSuffix}`;
      apiKey = process.env[envVar];
      if (!apiKey) {
        throw new AuthenticationError(
          OPENCODE_GO_PROVIDER_ID,
          envVar,
          `No authentication found for ${OPENCODE_GO_DISPLAY_NAME} (missing ${envVar})`
        );
      }
      logger.debug(`Using ${envVar} for ${OPENCODE_GO_DISPLAY_NAME} authentication`);
    } else {
      apiKey = process.env[OPENCODE_GO_API_KEY_ENV];
      if (apiKey) {
        logger.debug(`Using ${OPENCODE_GO_API_KEY_ENV} for ${OPENCODE_GO_DISPLAY_NAME} authentication`);
      }

      if (!apiKey) {
        const storedApiKey = await AuthStorage.getApiKey(OPENCODE_GO_PROVIDER_ID);
        if (storedApiKey) {
          apiKey = storedApiKey.key;
          logger.debug(`Using stored API key for ${OPENCODE_GO_DISPLAY_NAME} authentication`);
        }
      }

      if (!apiKey) {
        throw new AuthenticationError(
          OPENCODE_GO_PROVIDER_ID,
          OPENCODE_GO_API_KEY_ENV,
          `No authentication found for ${OPENCODE_GO_DISPLAY_NAME}. Run \`agentuse provider login ${OPENCODE_GO_PROVIDER_ID}\` or set ${OPENCODE_GO_API_KEY_ENV}`
        );
      }
    }

    if (!apiKey) {
      throw new Error(`Failed to obtain API key for ${OPENCODE_GO_DISPLAY_NAME}`);
    }

    const baseURL = resolveOpenCodeGoBaseURL(config);
    const protocol = getOpenCodeGoProtocol(config.modelName);
    logger.debug(`Using ${OPENCODE_GO_DISPLAY_NAME} ${protocol} endpoint at ${baseURL}`);

    if (protocol === 'anthropic') {
      const anthropic = createAnthropic({ apiKey, baseURL });
      return await maybeWrapWithDevTools(anthropic.chat(config.modelName));
    }

    const provider = createOpenAICompatible({
      name: OPENCODE_GO_PROVIDER_ID,
      baseURL,
      apiKey,
    });
    return await maybeWrapWithDevTools(provider(config.modelName));

  } else if (config.provider === 'demo') {
    // Demo provider - no authentication required
    logger.debug('Using demo provider (no API key required)');
    return await maybeWrapWithDevTools(createDemoModel(config.modelName));

  } else if (config.provider === 'bedrock') {
    // Amazon Bedrock supports three authentication modes (in priority order):
    //   1. AWS_BEARER_TOKEN_BEDROCK   - Bedrock API key (Bearer auth)
    //   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN)
    //      - Static IAM credentials (SigV4)
    //   3. AWS SDK credential provider chain - resolves AWS_PROFILE,
    //      ~/.aws/credentials, SSO cache, EC2/ECS/EKS instance roles, env vars, etc.
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
    const hasStaticCreds = Boolean(accessKeyId && secretAccessKey);
    // Use the SDK credential provider chain when no static creds are present
    // (covers AWS_PROFILE / SSO / instance roles / etc.)
    const useCredentialChain = !bearerToken && !hasStaticCreds;

    if (!region) {
      throw new AuthenticationError(
        'bedrock',
        'AWS_REGION',
        'No AWS region found for Amazon Bedrock. Set AWS_REGION (or AWS_DEFAULT_REGION)'
      );
    }

    const bedrockOptions: Parameters<typeof createAmazonBedrock>[0] = { region };
    if (bearerToken) {
      logger.debug('Using AWS_BEARER_TOKEN_BEDROCK for Amazon Bedrock authentication');
      bedrockOptions.apiKey = bearerToken;
    } else if (accessKeyId && secretAccessKey) {
      logger.debug('Using static AWS access keys for Amazon Bedrock authentication');
      bedrockOptions.accessKeyId = accessKeyId;
      bedrockOptions.secretAccessKey = secretAccessKey;
      if (process.env.AWS_SESSION_TOKEN) {
        bedrockOptions.sessionToken = process.env.AWS_SESSION_TOKEN;
      }
    } else if (useCredentialChain) {
      logger.debug(
        process.env.AWS_PROFILE
          ? `Using AWS SDK credential chain for Amazon Bedrock (AWS_PROFILE=${process.env.AWS_PROFILE})`
          : 'Using AWS SDK credential chain for Amazon Bedrock'
      );
      try {
        const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
        bedrockOptions.credentialProvider = fromNodeProviderChain();
      } catch (error) {
        throw new AuthenticationError(
          'bedrock',
          'AWS_ACCESS_KEY_ID',
          `No authentication found for Amazon Bedrock and @aws-sdk/credential-providers is not available (${error instanceof Error ? error.message : String(error)}). Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_BEARER_TOKEN_BEDROCK, or install @aws-sdk/credential-providers to use AWS_PROFILE / SSO / instance roles: pnpm add @aws-sdk/credential-providers`
        );
      }
    }

    // Loaded here rather than at module scope: Bedrock pulls in ~3MB of AWS
    // SDK that every agentuse process would otherwise pay for, including the
    // serve workers, whatever provider the agent actually names.
    const { createAmazonBedrock: createBedrock } = await import('@ai-sdk/amazon-bedrock');
    const bedrock = createBedrock(bedrockOptions);
    return await maybeWrapWithDevTools(bedrock(config.modelName));

  } else {
    // Check for custom provider
    const customProvider = await AuthStorage.getCustomProvider(config.provider);
    if (customProvider) {
      // Allow env var overrides: <NAME>_BASE_URL and <NAME>_API_KEY
      const envPrefix = config.provider.toUpperCase().replace(/-/g, '_');
      const baseURL = process.env[`${envPrefix}_BASE_URL`] || customProvider.baseURL;
      const apiKey = process.env[`${envPrefix}_API_KEY`] || customProvider.key || 'not-needed';

      logger.debug(`Using custom provider '${config.provider}' at ${baseURL}`);

      // Use @ai-sdk/openai-compatible for local/custom endpoints
      // (handles protocol differences better than @ai-sdk/openai)
      const provider = createOpenAICompatible({
        name: config.provider,
        baseURL,
        apiKey,
      });
      return await maybeWrapWithDevTools(provider(config.modelName));
    }

    throw new Error(`Unsupported provider: ${config.provider}. Add it with: agentuse provider add ${config.provider} --url <url>`);
  }
}
