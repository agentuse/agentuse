import { randomUUID } from 'crypto';
import { CodexAuth } from './codex.js';
import { getProviderStatus, type ProviderStatus } from './provider-status.js';
import { AuthStorage } from './storage.js';
import { BUILTIN_PROVIDERS } from '../providers/registry-sources.js';
import {
  PROVIDER_PLUGIN_REGISTRY,
  getProviderPluginRegistryEntry,
  providerPluginInstallSource,
  type ProviderPluginRegistryEntry,
} from '../plugin/provider-registry.js';
import {
  inspectPluginSource,
  installPlugin,
  removePlugin,
  updatePlugins,
  type PluginSourceInspection,
} from '../plugin/provider-installer.js';
import {
  getInstalledPluginHost,
  getProviderAdapters,
  loginProviderPlugin,
  logoutProviderPlugin,
  readInstalledPluginRecords,
} from '../plugin/provider-runtime.js';
import type { AuthInteraction, ProviderDefinition } from '../plugin/types.js';
import { checkCustomProviderCompletion, CUSTOM_PROVIDER_APIS, detectCustomProviderApi, discoverCustomProviderModelIds, normalizeCustomProviderBaseURL, normalizeCustomProviderModelIds, type CustomProviderApi } from './custom-provider-models.js';
import type { CustomProviderAuth } from './types.js';

export type ProviderAuthMethod = 'oauth' | 'api_key';

export interface ProviderCatalogEntry {
  id: 'anthropic' | 'openai' | 'openrouter' | 'opencode-go';
  name: string;
  description: string;
  authMethods: ProviderAuthMethod[];
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'anthropic', name: 'Anthropic API', description: 'Claude models billed through the Anthropic API', authMethods: ['api_key'] },
  { id: 'openai', name: 'OpenAI', description: 'GPT models', authMethods: ['oauth', 'api_key'] },
  { id: 'openrouter', name: 'OpenRouter', description: 'Models from multiple providers', authMethods: ['api_key'] },
  { id: 'opencode-go', name: 'OpenCode Go', description: 'Open coding models', authMethods: ['api_key'] },
] as const;

export interface ProviderSetupSnapshot {
  catalog: readonly ProviderCatalogEntry[];
  pluginRegistry: readonly ProviderPluginRegistryEntry[];
  installedPlugins: readonly InstalledProviderPluginEntry[];
  status: ProviderStatus;
}

export interface InstalledProviderPluginEntry {
  packageName: string;
  name: string;
  version: string;
  source: string;
  publisher: string;
  provenance: 'community' | 'unreviewed';
  providers: Array<{ id: string; authMethods: ProviderAuthMethod[] }>;
}

type OAuthAttempt = {
  provider: 'openai';
  pkce: { verifier: string; challenge: string };
  expiresAt: number;
};

interface PendingPluginOAuthAttempt {
  expiresAt: number;
  complete(code: string): Promise<void>;
  cancel(reason: Error): void;
}

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const oauthAttempts = new Map<string, OAuthAttempt>();
const pluginOAuthAttempts = new Map<string, PendingPluginOAuthAttempt>();

function pruneOAuthAttempts(now = Date.now()): void {
  for (const [id, attempt] of oauthAttempts) {
    if (attempt.expiresAt <= now) oauthAttempts.delete(id);
  }
  for (const [id, attempt] of pluginOAuthAttempts) {
    if (attempt.expiresAt > now) continue;
    pluginOAuthAttempts.delete(id);
    attempt.cancel(new Error('Plugin OAuth flow expired'));
  }
}

function catalogProvider(provider: unknown): ProviderCatalogEntry {
  if (typeof provider !== 'string') throw new Error('Provider is required');
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === provider);
  if (!entry) throw new Error(`Unsupported provider: ${provider}`);
  return entry;
}

export async function providerSetupSnapshot(): Promise<ProviderSetupSnapshot> {
  const status = await getProviderStatus();
  const records = await readInstalledPluginRecords();
  const host = await getInstalledPluginHost();
  const contributions = host.listProviderContributions();
  return {
    catalog: PROVIDER_CATALOG,
    pluginRegistry: PROVIDER_PLUGIN_REGISTRY,
    installedPlugins: records.map((record) => {
      // A record is curated when it matches the reviewed commit, or the
      // pre-pinning tag source recorded by earlier releases.
      const curated = PROVIDER_PLUGIN_REGISTRY.find((entry) =>
        entry.packageName === record.name && entry.version === record.version
        && (record.commit === entry.commit || record.source === entry.source),
      );
      const providers = contributions
        .filter((contribution) => contribution.owner.name === record.name)
        .map((contribution) => ({
          id: contribution.providerId,
          authMethods: [...new Set((contribution.provider.auth?.methods ?? []).flatMap((method) =>
            method.type === 'oauth' ? ['oauth' as const] : method.type === 'api-key' ? ['api_key' as const] : [],
          ))],
        }));
      const sourcePath = record.source.replace(/^(?:github:|git:)/, '').replace(/^https:\/\/github\.com\//, '');
      const publisher = sourcePath.split('/')[0] || 'unknown';
      return {
        packageName: record.name,
        name: curated?.name ?? record.name,
        version: record.version,
        source: record.source,
        publisher: curated?.publisher ?? publisher,
        provenance: curated ? 'community' as const : 'unreviewed' as const,
        providers,
      };
    }),
    status,
  };
}

export async function saveProviderApiKey(provider: unknown, rawKey: unknown): Promise<ProviderSetupSnapshot> {
  const entry = catalogProvider(provider);
  if (!entry.authMethods.includes('api_key')) throw new Error(`${entry.name} does not support API-key setup`);
  if (typeof rawKey !== 'string' || !rawKey.trim()) throw new Error('API key is required');
  if (rawKey.length > 16_384) throw new Error('API key is too long');
  await AuthStorage.setApiKey(entry.id, { type: 'api', key: rawKey.trim() });
  return providerSetupSnapshot();
}

export async function startProviderOAuth(
  provider: unknown,
): Promise<{ flowId: string; provider: 'openai'; authorizationUrl: string; expiresAt: number }> {
  const entry = catalogProvider(provider);
  if (!entry.authMethods.includes('oauth') || entry.id !== 'openai') {
    throw new Error(`${entry.name} does not support OAuth setup`);
  }

  pruneOAuthAttempts();
  const flowId = randomUUID();
  const expiresAt = Date.now() + OAUTH_ATTEMPT_TTL_MS;
  const { url, pkce } = await CodexAuth.authorize();
  oauthAttempts.set(flowId, { provider: 'openai', pkce, expiresAt });
  return { flowId, provider: 'openai', authorizationUrl: url, expiresAt };
}

function oauthCode(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Authorization code is required');
  const trimmed = value.trim();
  try {
    return new URL(trimmed).searchParams.get('code') || trimmed;
  } catch {
    return trimmed;
  }
}

export async function completeProviderOAuth(flowId: unknown, rawCode: unknown): Promise<ProviderSetupSnapshot> {
  pruneOAuthAttempts();
  if (typeof flowId !== 'string' || !flowId) throw new Error('OAuth flow is required');
  const attempt = oauthAttempts.get(flowId);
  if (!attempt) throw new Error('OAuth flow expired or was not found');
  oauthAttempts.delete(flowId);
  const code = oauthCode(rawCode);

  const credentials = await CodexAuth.exchange(code, attempt.pkce);
  await AuthStorage.setOAuth('openai', { type: 'codex-oauth', ...credentials });
  return providerSetupSnapshot();
}

function registryPlugin(id: unknown): ProviderPluginRegistryEntry {
  if (typeof id !== 'string' || !id) throw new Error('Provider plugin is required');
  const entry = getProviderPluginRegistryEntry(id);
  if (!entry) throw new Error(`Provider plugin is not shortlisted: ${id}`);
  return entry;
}

/** Install only a release-reviewed registry entry. Repeated calls are safe. */
export async function installProviderPluginFromRegistry(id: unknown): Promise<ProviderSetupSnapshot> {
  const entry = registryPlugin(id);
  const installed = await readInstalledPluginRecords();
  if (!installed.some((record) => record.name === entry.packageName)) {
    await installPlugin(providerPluginInstallSource(entry));
  }
  return providerSetupSnapshot();
}

export async function inspectUnreviewedProviderPlugin(source: unknown): Promise<PluginSourceInspection> {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Provider plugin source is required');
  return inspectPluginSource(source.trim());
}

export async function updateInstalledProviderPlugin(name: unknown): Promise<ProviderSetupSnapshot> {
  if (typeof name !== 'string' || !name) throw new Error('Installed plugin name is required');
  await updatePlugins(name);
  return providerSetupSnapshot();
}

export async function removeInstalledProviderPlugin(name: unknown): Promise<ProviderSetupSnapshot> {
  if (typeof name !== 'string' || !name) throw new Error('Installed plugin name is required');
  await removePlugin(name);
  return providerSetupSnapshot();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export type ProviderPluginOAuthStart = {
  connected: true;
  snapshot: ProviderSetupSnapshot;
} | {
  connected: false;
  flowId: string;
  authorizationUrl: string;
  expiresAt: number;
};

async function beginProviderPluginOAuth(
  label: string,
  providerId: string,
  authMethodId: string,
  provider: ProviderDefinition,
  installed: ProviderSetupSnapshot,
): Promise<ProviderPluginOAuthStart> {
  // Only this method's own credential counts. The provider-level `configured`
  // flag also covers API keys and env vars, which would report a login that
  // never happened.
  if (await AuthStorage.getPluginCredential(providerId, authMethodId)) {
    return { connected: true, snapshot: installed };
  }

  pruneOAuthAttempts();
  const flowId = randomUUID();
  const expiresAt = Date.now() + OAUTH_ATTEMPT_TTL_MS;
  const prompt = deferred<string>();
  const ready = deferred<string>();
  const controller = new AbortController();
  let authorizationUrl = '';

  const interaction: AuthInteraction = {
    openBrowser({ url }) { authorizationUrl = url; },
    showDeviceCode() { throw new Error(`${label} returned an unsupported device-code login`); },
    prompt() {
      if (!authorizationUrl) throw new Error(`${label} requested input before opening an authorization page`);
      ready.resolve(authorizationUrl);
      return prompt.promise;
    },
    async select({ choices }) {
      const first = choices[0];
      if (!first) throw new Error(`${label} returned no authentication choices`);
      return first.value;
    },
    notify() {},
  };

  const login = loginProviderPlugin(provider, interaction, authMethodId, controller.signal);
  void login.catch((error) => ready.reject(error instanceof Error ? error : new Error(String(error))));
  const readyTimeout = setTimeout(() => {
    const error = new Error(`${label} did not start its authorization flow`);
    controller.abort(error);
    prompt.reject(error);
    ready.reject(error);
  }, 15_000);
  readyTimeout.unref?.();
  try {
    authorizationUrl = await ready.promise;
  } finally {
    clearTimeout(readyTimeout);
  }

  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const pending: PendingPluginOAuthAttempt = {
    expiresAt,
    async complete(code) {
      if (expiryTimer) clearTimeout(expiryTimer);
      prompt.resolve(code);
      await login;
    },
    cancel(reason) {
      if (expiryTimer) clearTimeout(expiryTimer);
      controller.abort(reason);
      prompt.reject(reason);
    },
  };
  pluginOAuthAttempts.set(flowId, pending);
  expiryTimer = setTimeout(() => {
    if (pluginOAuthAttempts.delete(flowId)) pending.cancel(new Error('Plugin OAuth flow expired'));
  }, OAUTH_ATTEMPT_TTL_MS);
  expiryTimer.unref?.();
  return { connected: false, flowId, authorizationUrl, expiresAt };
}

/**
 * Bridge a plugin's UI-neutral login interaction across the dashboard's
 * start/complete HTTP requests. The authorization verifier and pending prompt
 * remain server-side.
 */
export async function startProviderPluginOAuth(id: unknown): Promise<ProviderPluginOAuthStart> {
  const entry = registryPlugin(id);
  const installed = await installProviderPluginFromRegistry(entry.id);
  const candidate = (await getProviderAdapters(entry.provider)).find(({ provider }) =>
    provider.auth?.methods.some((method) => method.id === entry.authMethodId),
  );
  if (!candidate) throw new Error(`${entry.name} did not register its expected authentication method`);
  return beginProviderPluginOAuth(entry.name, entry.provider, entry.authMethodId, candidate.provider, installed);
}

export async function startUnreviewedProviderPluginOAuth(source: unknown): Promise<ProviderPluginOAuthStart> {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Provider plugin source is required');
  const inspected = await inspectPluginSource(source.trim());
  const immutableSource = `${inspected.repository}@${inspected.commit}`;
  const records = await readInstalledPluginRecords();
  const existing = records.find((record) => record.name === inspected.name);
  if (existing && existing.source !== inspected.source && existing.source !== immutableSource) {
    throw new Error(`${inspected.name} is already installed from a different source. Remove it before installing this source.`);
  }
  if (!existing) await installPlugin(immutableSource);
  const installed = await providerSetupSnapshot();
  const host = await getInstalledPluginHost();
  const candidates = host.listProviderContributions()
    .filter((contribution) => contribution.owner.name === inspected.name)
    .flatMap((contribution) => (contribution.provider.auth?.methods ?? []).map((method) => ({
      providerId: contribution.providerId,
      provider: contribution.kind === 'provider'
        ? contribution.provider as ProviderDefinition
        : {
            id: contribution.providerId,
            name: contribution.provider.name,
            models: contribution.provider.models ?? { inherit: contribution.providerId },
            transport: contribution.provider.transport,
            auth: contribution.provider.auth,
          } as ProviderDefinition,
      method,
    })))
    .filter((candidate) => candidate.method.type === 'oauth');
  if (candidates.length !== 1) {
    throw new Error(`${inspected.name} must register exactly one OAuth provider method for guided setup`);
  }
  const candidate = candidates[0]!;
  return beginProviderPluginOAuth(inspected.name, candidate.providerId, candidate.method.id, candidate.provider, installed);
}

export async function completeProviderPluginOAuth(
  flowId: unknown,
  rawCode: unknown,
): Promise<ProviderSetupSnapshot> {
  pruneOAuthAttempts();
  if (typeof flowId !== 'string' || !flowId) throw new Error('Plugin OAuth flow is required');
  const attempt = pluginOAuthAttempts.get(flowId);
  if (!attempt) throw new Error('Plugin OAuth flow expired or was not found');
  pluginOAuthAttempts.delete(flowId);
  try {
    await attempt.complete(oauthCode(rawCode));
    return providerSetupSnapshot();
  } catch (error) {
    attempt.cancel(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export async function removeProviderCredential(
  provider: unknown,
  kind: unknown,
  pluginName?: unknown,
  authMethodId?: unknown,
): Promise<ProviderSetupSnapshot> {
  const entry = catalogProvider(provider);
  if (kind === 'oauth') {
    if ((pluginName === undefined) !== (authMethodId === undefined)) {
      throw new Error('Plugin name and authentication method must be provided together');
    }
    if (pluginName !== undefined && authMethodId !== undefined) {
      if (typeof pluginName !== 'string' || typeof authMethodId !== 'string') {
        throw new Error('Plugin credential identity is invalid');
      }
      const adapter = (await getProviderAdapters(entry.id)).find((candidate) =>
        candidate.owner.name === pluginName
        && candidate.provider.auth?.methods.some((method) => method.id === authMethodId && method.type === 'oauth'),
      );
      if (!adapter) throw new Error(`OAuth method ${pluginName}:${authMethodId} is not registered for ${entry.id}`);
      await logoutProviderPlugin(adapter.provider, 'oauth', authMethodId);
    } else {
      await AuthStorage.removeOAuth(entry.id);
    }
  }
  else if (kind === 'api_key') await AuthStorage.removeApiKey(entry.id);
  else throw new Error('Credential kind must be oauth or api_key');
  return providerSetupSnapshot();
}

export interface CustomProviderInput {
  name: unknown;
  baseURL: unknown;
  key?: unknown;
  api?: unknown;
  models?: unknown;
  compatibility?: CustomProviderAuth['compatibility'];
}

export async function prepareCustomProvider(input: CustomProviderInput): Promise<{
  name: string;
  provider: { baseURL: string; key?: string; api: CustomProviderApi; compatibility?: CustomProviderAuth['compatibility'] };
  models: string[];
}> {
  if (typeof input.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input.name)) {
    throw new Error('Provider name must start with a letter and contain only letters, numbers, hyphens, and underscores');
  }
  const name = input.name.toLowerCase();
  if (BUILTIN_PROVIDERS.includes(name)) throw new Error(`Provider name is reserved: ${name}`);
  if (typeof input.baseURL !== 'string' || !input.baseURL.trim()) throw new Error('Base URL is required');
  let url: URL;
  try { url = new URL(input.baseURL.trim()); } catch { throw new Error('Base URL must be a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL must use HTTP or HTTPS');
  if (input.key !== undefined && typeof input.key !== 'string') throw new Error('API key must be text');
  const requestedApi = input.api === undefined ? 'auto' : input.api;
  if (typeof requestedApi !== 'string' || (requestedApi !== 'auto' && !CUSTOM_PROVIDER_APIS.includes(requestedApi as CustomProviderApi))) throw new Error('Unsupported custom provider API format');
  const provider = {
    baseURL: normalizeCustomProviderBaseURL(name, url.toString()),
    api: (requestedApi === 'auto' ? 'openai-completions' : requestedApi) as CustomProviderApi,
    ...(typeof input.key === 'string' && input.key.trim() ? { key: input.key.trim() } : {}),
    ...(input.compatibility && Object.keys(input.compatibility).length > 0
      ? { compatibility: input.compatibility }
      : {}),
  };
  const manualModels = normalizeCustomProviderModelIds(input.models);
  let discoveredModels: string[] = [];
  try {
    discoveredModels = await discoverCustomProviderModelIds(name, provider);
  } catch (error) {
    if (manualModels.length === 0) throw error;
  }
  const models = normalizeCustomProviderModelIds([...discoveredModels, ...manualModels]);
  if (models.length === 0) {
    throw new Error('Could not find any models at this endpoint. Enter at least one model ID manually.');
  }
  if (requestedApi === 'auto') provider.api = await detectCustomProviderApi(provider, models[0]!);
  else await checkCustomProviderCompletion(provider, models[0]!);
  return { name, provider, models };
}

export async function checkCustomProvider(input: CustomProviderInput): Promise<{
  name: string;
  baseURL: string;
  models: string[];
  api: CustomProviderApi;
}> {
  const prepared = await prepareCustomProvider(input);
  return { name: prepared.name, baseURL: prepared.provider.baseURL, api: prepared.provider.api, models: prepared.models };
}

export async function configureCustomProvider(input: CustomProviderInput): Promise<{
  name: string;
  provider: Awaited<ReturnType<typeof prepareCustomProvider>>['provider'];
  models: string[];
  snapshot: ProviderSetupSnapshot;
}> {
  const { name, provider, models } = await prepareCustomProvider(input);
  await AuthStorage.setCustomProvider(name, {
    ...provider,
    models,
  });
  return { name, provider, models, snapshot: await providerSetupSnapshot() };
}

export async function saveCustomProvider(input: CustomProviderInput): Promise<ProviderSetupSnapshot> {
  return (await configureCustomProvider(input)).snapshot;
}

export async function refreshCustomProviderModels(name: unknown): Promise<ProviderSetupSnapshot> {
  if (typeof name !== 'string' || !name) throw new Error('Custom provider name is required');
  const provider = await AuthStorage.getCustomProvider(name);
  if (!provider) throw new Error(`Custom provider was not found: ${name}`);
  const discovered = await discoverCustomProviderModelIds(name, provider);
  if (discovered.length === 0) throw new Error('The provider returned no usable models. The saved model list was not changed.');
  await AuthStorage.setCustomProvider(name, { ...provider, models: discovered });
  return providerSetupSnapshot();
}

export async function removeCustomProvider(name: unknown): Promise<ProviderSetupSnapshot> {
  if (typeof name !== 'string' || !name) throw new Error('Custom provider name is required');
  if (!await AuthStorage.removeCustomProvider(name)) throw new Error(`Custom provider was not found: ${name}`);
  return providerSetupSnapshot();
}

/** Test-only reset for short-lived, process-local OAuth attempts. */
export function clearProviderOAuthAttempts(): void {
  oauthAttempts.clear();
  for (const attempt of pluginOAuthAttempts.values()) {
    attempt.cancel(new Error('Plugin OAuth flow was cleared'));
  }
  pluginOAuthAttempts.clear();
}
