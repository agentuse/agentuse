import { AuthStorage } from './storage.js';
import {
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER_ID,
} from '../providers/opencode-go.js';
import { getProviderAdapters, loadProviderPlugins, providerPluginAuthStatus } from '../plugin/provider-runtime.js';
import { PROVIDER_PLUGIN_REGISTRY } from '../plugin/provider-registry.js';

export type ProviderAuthSourceKind = 'oauth' | 'api_key' | 'environment';

export interface ProviderAuthSourceStatus {
  priority: 1 | 2 | 3;
  kind: ProviderAuthSourceKind;
  name: string;
  stored: boolean;
  active: boolean;
  plugin?: { name: string; authMethodId: string };
}

export interface ProviderAuthStatus {
  id: string;
  name: string;
  configured: boolean;
  sources: ProviderAuthSourceStatus[];
  actionRequired?: string;
}

export interface CustomProviderStatus {
  id: string;
  baseURL: string;
  hasApiKey: boolean;
  models?: string[];
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
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
    envVars: ['ANTHROPIC_API_KEY'],
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
    const adapters = await getProviderAdapters(provider.id);

    // Conditional adapters are part of the built-in namespace. Their auth
    // sources lead the list because a selected OAuth transport wins over API.
    for (const adapter of adapters) {
      for (const source of await providerPluginAuthStatus(adapter.provider, adapter.owner)) {
        sources.push({ ...source, active: sources.length === 0 });
      }
    }

    // OAuth for a built-in namespace is otherwise owned by its adapter.
    // Without that adapter installed, keep legacy credentials hidden rather
    // than claiming the built-in API transport can use them.
    if (providerAuth.oauth && provider.id !== 'anthropic') {
      sources.push({
        priority: 1,
        kind: 'oauth',
        name: providerAuth.oauth.type === 'codex-oauth' ? 'ChatGPT OAuth' : 'OAuth',
        stored: true,
        active: sources.length === 0,
      });
    }

    // Runtime provider construction checks API-key environment variables
    // before falling back to the stored API key.
    for (const envVar of provider.envVars) {
      if (!process.env[envVar]) continue;
      sources.push({
        priority: 2,
        kind: 'environment',
        name: envVar,
        stored: false,
        active: sources.length === 0,
      });
    }

    if (providerAuth.api) {
      sources.push({
        priority: 3,
        kind: 'api_key',
        name: 'Stored API key',
        stored: true,
        active: sources.length === 0,
      });
    }

    const shortlistedPlugin = PROVIDER_PLUGIN_REGISTRY.find((entry) => entry.provider === provider.id);
    const hasClaudeAdapter = shortlistedPlugin
      ? adapters.some(({ provider: adapted }) =>
          adapted.auth?.methods.some((method) => method.id === shortlistedPlugin.authMethodId))
      : false;
    const migratedPluginCredential = shortlistedPlugin
      ? await AuthStorage.getPluginCredential(provider.id, shortlistedPlugin.authMethodId)
      : undefined;
    const missingClaudeAdapter = provider.id === 'anthropic'
      && !hasClaudeAdapter
      && Boolean(providerAuth.oauth || migratedPluginCredential || process.env.CLAUDE_CODE_OAUTH_TOKEN);
    providers.push({
      id: provider.id,
      name: provider.name,
      configured: sources.length > 0,
      sources,
      ...(missingClaudeAdapter && {
        actionRequired: `Claude subscription OAuth is present but its provider plugin is not installed. Run: agentuse plugins install ${shortlistedPlugin!.source}`,
      }),
    });
  }

  for (const plugin of await loadProviderPlugins()) {
    if (!plugin.auth) continue;
    const sources = await providerPluginAuthStatus(plugin);
    providers.push({
      id: plugin.id,
      name: plugin.name,
      configured: sources.length > 0,
      sources,
    });
  }

  const customProviders = Object.entries(await AuthStorage.getCustomProviders()).map(
    ([id, config]) => ({
      id,
      baseURL: config.baseURL,
      hasApiKey: Boolean(config.key),
      api: config.api ?? 'openai-completions',
      models: config.models ?? [],
    }),
  );

  return {
    credentialStore: AuthStorage.getFilePath(),
    providers,
    customProviders,
  };
}
