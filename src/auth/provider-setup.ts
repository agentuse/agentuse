import { randomUUID } from 'crypto';
import { AnthropicAuth } from './anthropic.js';
import { CodexAuth } from './codex.js';
import { getProviderStatus, type ProviderStatus } from './provider-status.js';
import { AuthStorage } from './storage.js';
import { BUILTIN_PROVIDERS } from '../providers/registry-sources.js';
import { checkCustomProviderCompletion, CUSTOM_PROVIDER_APIS, detectCustomProviderApi, discoverCustomProviderModelIds, normalizeCustomProviderBaseURL, normalizeCustomProviderModelIds, type CustomProviderApi } from './custom-provider-models.js';

export type ProviderAuthMethod = 'oauth' | 'api_key';

export interface ProviderCatalogEntry {
  id: 'anthropic' | 'openai' | 'openrouter' | 'opencode-go';
  name: string;
  description: string;
  authMethods: ProviderAuthMethod[];
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models', authMethods: ['oauth', 'api_key'] },
  { id: 'openai', name: 'OpenAI', description: 'GPT models', authMethods: ['oauth', 'api_key'] },
  { id: 'openrouter', name: 'OpenRouter', description: 'Models from multiple providers', authMethods: ['api_key'] },
  { id: 'opencode-go', name: 'OpenCode Go', description: 'Open coding models', authMethods: ['api_key'] },
] as const;

export interface ProviderSetupSnapshot {
  catalog: readonly ProviderCatalogEntry[];
  status: ProviderStatus;
}

type OAuthAttempt = {
  provider: 'anthropic';
  verifier: string;
  expiresAt: number;
} | {
  provider: 'openai';
  pkce: { verifier: string; challenge: string };
  expiresAt: number;
};

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const oauthAttempts = new Map<string, OAuthAttempt>();

function pruneOAuthAttempts(now = Date.now()): void {
  for (const [id, attempt] of oauthAttempts) {
    if (attempt.expiresAt <= now) oauthAttempts.delete(id);
  }
}

function catalogProvider(provider: unknown): ProviderCatalogEntry {
  if (typeof provider !== 'string') throw new Error('Provider is required');
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === provider);
  if (!entry) throw new Error(`Unsupported provider: ${provider}`);
  return entry;
}

export async function providerSetupSnapshot(): Promise<ProviderSetupSnapshot> {
  return { catalog: PROVIDER_CATALOG, status: await getProviderStatus() };
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
  anthropicMode: unknown = 'max',
): Promise<{ flowId: string; provider: 'anthropic' | 'openai'; authorizationUrl: string; expiresAt: number }> {
  const entry = catalogProvider(provider);
  if (!entry.authMethods.includes('oauth') || (entry.id !== 'anthropic' && entry.id !== 'openai')) {
    throw new Error(`${entry.name} does not support OAuth setup`);
  }

  pruneOAuthAttempts();
  const flowId = randomUUID();
  const expiresAt = Date.now() + OAUTH_ATTEMPT_TTL_MS;
  if (entry.id === 'anthropic') {
    if (anthropicMode !== 'max' && anthropicMode !== 'console') throw new Error('Invalid Anthropic OAuth mode');
    const { url, verifier } = await AnthropicAuth.authorize(anthropicMode);
    oauthAttempts.set(flowId, { provider: 'anthropic', verifier, expiresAt });
    return { flowId, provider: 'anthropic', authorizationUrl: url, expiresAt };
  }

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

  if (attempt.provider === 'anthropic') {
    const credentials = await AnthropicAuth.exchange(code, attempt.verifier);
    await AuthStorage.setOAuth('anthropic', { type: 'oauth', ...credentials });
  } else {
    const credentials = await CodexAuth.exchange(code, attempt.pkce);
    await AuthStorage.setOAuth('openai', { type: 'codex-oauth', ...credentials });
  }
  return providerSetupSnapshot();
}

export async function removeProviderCredential(provider: unknown, kind: unknown): Promise<ProviderSetupSnapshot> {
  const entry = catalogProvider(provider);
  if (kind === 'oauth') await AuthStorage.removeOAuth(entry.id);
  else if (kind === 'api_key') await AuthStorage.removeApiKey(entry.id);
  else throw new Error('Credential kind must be oauth or api_key');
  return providerSetupSnapshot();
}

interface CustomProviderInput {
  name: unknown;
  baseURL: unknown;
  key?: unknown;
  api?: unknown;
  models?: unknown;
}

async function prepareCustomProvider(input: CustomProviderInput): Promise<{
  name: string;
  provider: { baseURL: string; key?: string; api: CustomProviderApi };
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

export async function saveCustomProvider(input: CustomProviderInput): Promise<ProviderSetupSnapshot> {
  const { name, provider, models } = await prepareCustomProvider(input);
  await AuthStorage.setCustomProvider(name, {
    ...provider,
    models,
  });
  return providerSetupSnapshot();
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
}
