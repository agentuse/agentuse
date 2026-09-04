import { AuthStorage } from './storage.js';
import {
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER_ID,
} from '../providers/opencode-go.js';
import {
  checkProviderReadiness,
  describeReadinessFailure,
  getProviderAdapters,
  loadProviderPlugins,
  providerPluginAuthStatus,
  type ProviderReadiness,
} from '../plugin/provider-runtime.js';
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
  /** Usable now: credentials present (when required) and the readiness check passed. */
  configured: boolean;
  sources: ProviderAuthSourceStatus[];
  actionRequired?: string;
  /** Result of the plugin's `check()` hook; absent for providers without one. */
  readiness?: ProviderReadiness;
  /**
   * The plugin has a `check()` hook that was not run for this snapshot (see
   * `getProviderStatus({ readiness: 'defer' })`). `configured` then reflects
   * credentials only; fetch `getProviderReadiness()` to settle it.
   */
  checkPending?: true;
}

/** Outcome of one deferred readiness check, merged into a provider row by id. */
export interface ProviderReadinessResult {
  id: string;
  configured: boolean;
  readiness: ProviderReadiness;
  actionRequired?: string;
}

export interface ProviderStatusOptions {
  /**
   * `run` (default) executes every plugin `check()` hook inline, which can
   * spawn a bridged CLI. `defer` skips them so the credential-only snapshot
   * returns fast; rows that skipped a check carry `checkPending`.
   */
  readiness?: 'run' | 'defer';
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
export async function getProviderStatus(options: ProviderStatusOptions = {}): Promise<ProviderStatus> {
  const providers: ProviderAuthStatus[] = [];
  const runChecks = options.readiness !== 'defer';

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
    // A plugin without auth methods (e.g. one wrapping a local CLI) needs no
    // credential, so it is usable as soon as it is installed.
    const sources = plugin.auth ? await providerPluginAuthStatus(plugin) : [];
    const credentialed = !plugin.auth || sources.length > 0;
    if (plugin.check && !runChecks) {
      providers.push({ id: plugin.id, name: plugin.name, configured: credentialed, sources, checkPending: true });
      continue;
    }
    const readiness = plugin.check ? await checkProviderReadiness(plugin) : undefined;
    providers.push({
      id: plugin.id,
      name: plugin.name,
      configured: credentialed && (readiness?.ok ?? true),
      sources,
      ...(readiness && { readiness }),
      ...(readiness && !readiness.ok && { actionRequired: describeReadinessFailure(plugin, readiness) }),
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

/**
 * Run every plugin `check()` hook, in parallel, and return the fields a
 * deferred snapshot left unsettled. Pairs with `getProviderStatus({ readiness: 'defer' })`.
 */
export async function getProviderReadiness(): Promise<ProviderReadinessResult[]> {
  const plugins = (await loadProviderPlugins()).filter((plugin) => plugin.check);
  return Promise.all(plugins.map(async (plugin) => {
    const [sources, readiness] = await Promise.all([
      plugin.auth ? providerPluginAuthStatus(plugin) : Promise.resolve([]),
      checkProviderReadiness(plugin),
    ]);
    return {
      id: plugin.id,
      configured: (!plugin.auth || sources.length > 0) && readiness.ok,
      readiness,
      ...(!readiness.ok && { actionRequired: describeReadinessFailure(plugin, readiness) }),
    };
  }));
}
