import { AuthStorage } from './storage.js';
import {
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER_ID,
} from '../providers/opencode-go.js';

export type ProviderAuthSourceKind = 'oauth' | 'api_key' | 'environment';

export interface ProviderAuthSourceStatus {
  priority: 1 | 2 | 3;
  kind: ProviderAuthSourceKind;
  name: string;
  stored: boolean;
  active: boolean;
}

export interface ProviderAuthStatus {
  id: string;
  name: string;
  configured: boolean;
  sources: ProviderAuthSourceStatus[];
}

export interface CustomProviderStatus {
  id: string;
  baseURL: string;
  hasApiKey: boolean;
}

export interface ProviderStatus {
  credentialStore: string;
  providers: ProviderAuthStatus[];
  customProviders: CustomProviderStatus[];
}

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    envVars: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envVars: ['OPENAI_API_KEY'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envVars: ['OPENROUTER_API_KEY'],
  },
  {
    id: OPENCODE_GO_PROVIDER_ID,
    name: OPENCODE_GO_DISPLAY_NAME,
    envVars: [OPENCODE_GO_API_KEY_ENV],
  },
] as const;

/**
 * Return the provider authentication visible to this process without exposing
 * credential values. CLI text, JSON output, and server APIs can share this
 * model so they agree about which source is active.
 */
export async function getProviderStatus(): Promise<ProviderStatus> {
  const providers: ProviderAuthStatus[] = [];

  for (const provider of PROVIDERS) {
    const providerAuth = await AuthStorage.getProviderAuth(provider.id);
    const sources: ProviderAuthSourceStatus[] = [];

    if (providerAuth.oauth) {
      sources.push({
        priority: 1,
        kind: 'oauth',
        name: providerAuth.oauth.type === 'codex-oauth' ? 'ChatGPT OAuth' : 'OAuth',
        stored: true,
        active: true,
      });
    }

    if (
      provider.id === 'anthropic'
      && !providerAuth.oauth
      && process.env.CLAUDE_CODE_OAUTH_TOKEN
    ) {
      sources.push({
        priority: 1,
        kind: 'environment',
        name: 'CLAUDE_CODE_OAUTH_TOKEN',
        stored: false,
        active: true,
      });
    }

    if (providerAuth.api) {
      sources.push({
        priority: 2,
        kind: 'api_key',
        name: 'Stored API key',
        stored: true,
        active: !sources.some((source) => source.priority === 1),
      });
    }

    for (const envVar of provider.envVars) {
      if (envVar === 'CLAUDE_CODE_OAUTH_TOKEN' || !process.env[envVar]) continue;
      sources.push({
        priority: 3,
        kind: 'environment',
        name: envVar,
        stored: false,
        active: sources.length === 0,
      });
    }

    providers.push({
      id: provider.id,
      name: provider.name,
      configured: sources.length > 0,
      sources,
    });
  }

  const customProviders = Object.entries(await AuthStorage.getCustomProviders()).map(
    ([id, config]) => ({
      id,
      baseURL: config.baseURL,
      hasApiKey: Boolean(config.key),
    }),
  );

  return {
    credentialStore: AuthStorage.getFilePath(),
    providers,
    customProviders,
  };
}
