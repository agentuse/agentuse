import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { minimatch } from 'minimatch';
import { AuthStorage } from '../auth/storage';
import { MODELS, type ModelInfo, type Provider as RegistryProvider } from '../generated/models';
import type { ProviderAuthSourceStatus } from '../auth/provider-status';
import { logger } from '../utils/logger';
import { getAgentuseDataDir } from '../utils/data-dir';
import { findProjectRoot } from '../utils/project';
import { PluginHost } from './host';
import {
  clearActiveProviders,
  currentActiveProvider,
  currentInstalledPluginHost,
  currentPluginHost,
  currentPluginProjectRoot,
  ensureProviderSelectionScope,
  enterInstalledPluginHost,
  selectActiveProvider,
} from './context';
import { importExtensionModule, readPackageManifest, type ResolvedPackageManifest } from './loader';
import type {
  AuthInteraction,
  InstalledPluginRecord,
  PluginCredential,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderDefinition,
  ProviderAdapter,
  ProviderFinishReason,
  ProviderModelDefinition,
  ProviderRequest,
  ProviderRuntimeContext,
  ProviderStreamEvent,
  ProviderUsage,
  ResolvedProviderAuth,
} from './types';
import type { PluginIdentity } from './internal-types';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function providerPluginHome(): string {
  return join(getAgentuseDataDir(), 'plugins');
}

export function providerPluginRegistryPath(): string {
  return join(providerPluginHome(), 'registry.json');
}

export async function readInstalledPluginRecords(): Promise<InstalledPluginRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(providerPluginRegistryPath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((record) => ({ scope: 'global', ...record })) as InstalledPluginRecord[];
  } catch {
    return [];
  }
}

async function readAvailablePluginRecords(root: string): Promise<InstalledPluginRecord[]> {
  const global = await readInstalledPluginRecords();
  try {
    const parsed = JSON.parse(await readFile(join(root, '.agentuse', 'plugins.json'), 'utf8')) as unknown;
    return Array.isArray(parsed) ? [...global, ...parsed as InstalledPluginRecord[]] : global;
  } catch {
    return global;
  }
}

function hostLogger(name: string): PluginLogger {
  return {
    debug: (message) => logger.debug(`[Plugin ${name}] ${message}`),
    info: (message) => logger.info(`[Plugin ${name}] ${message}`),
    warn: (message) => logger.warn(`[Plugin ${name}] ${message}`),
  };
}

export async function loadPluginPackageDirectory(
  root: string,
  scope: PluginIdentity['scope'] = 'local',
): Promise<{ manifest: ResolvedPackageManifest; host: PluginHost }> {
  const manifest = await readPackageManifest(root);
  const host = new PluginHost();
  try {
    for (const entry of manifest.agentuse.extensions) {
      const source = resolve(root, entry);
      await host.activate({ name: manifest.name, version: manifest.version, source, scope }, await importExtensionModule(source));
    }
    await Promise.all(host.listProviders().map((provider) => discoverProviderModels(provider)));
    return { manifest, host };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

const installedHosts = new Map<string, Promise<PluginHost>>();
let legacyProviderPluginMigration: Promise<void> | undefined;

async function ensureLegacyProviderPlugins(): Promise<void> {
  if (!legacyProviderPluginMigration) {
    legacyProviderPluginMigration = import('./provider-migration.js')
      .then(async ({ installLegacyProviderPlugins }) => {
        const installed = await installLegacyProviderPlugins();
        if (installed.length > 0) {
          logger.info('Installed Claude Code Subscription plugin and migrated existing Anthropic OAuth credentials');
        }
      })
      .catch((error) => {
        logger.warn(`Could not automatically upgrade existing provider credentials: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  const pending = legacyProviderPluginMigration;
  try {
    await pending;
  } finally {
    // Keep concurrent callers on one upgrade attempt, but recheck on a future
    // provider load in case a credential was imported or connectivity returned.
    if (legacyProviderPluginMigration === pending) legacyProviderPluginMigration = undefined;
  }
}

export function resetProviderPluginCache(): void {
  installedHosts.clear();
  legacyProviderPluginMigration = undefined;
  clearActiveProviders();
}

export async function getInstalledPluginHost(): Promise<PluginHost> {
  await ensureLegacyProviderPlugins();
  const root = resolve(process.env.AGENTUSE_PROJECT_ROOT ?? currentPluginProjectRoot() ?? findProjectRoot(process.cwd()));
  const key = `${providerPluginRegistryPath()}\0${root}`;
  let pending = installedHosts.get(key);
  if (!pending) {
    pending = (async () => {
      const host = new PluginHost();
      for (const record of await readAvailablePluginRecords(root)) {
        const packageRegistrations: Array<{ dispose(): void | Promise<void> }> = [];
        try {
          const manifest = await readPackageManifest(record.directory);
          for (const entry of manifest.agentuse.extensions) {
            const source = resolve(record.directory, entry);
            packageRegistrations.push(await host.activate({
              name: manifest.name,
              version: manifest.version,
              source,
              scope: record.scope ?? 'global',
            }, await importExtensionModule(source)));
          }
        } catch (error) {
          await Promise.allSettled(packageRegistrations.reverse().map((item) => item.dispose()));
          logger.warn(`Failed to load installed plugin ${record.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return host;
    })();
    installedHosts.set(key, pending);
  }
  const host = await pending;
  enterInstalledPluginHost(host);
  return host;
}

export async function loadProviderPlugins(): Promise<ProviderDefinition[]> {
  // Run synchronously before the first await so the caller's continuation
  // inherits the selection map even when AgentUse is used as a library without
  // constructing a PluginManager.
  ensureProviderSelectionScope();
  const local = currentPluginHost()?.listProviders() ?? [];
  const installedHost = await getInstalledPluginHost();
  enterInstalledPluginHost(installedHost);
  const localIds = new Set(local.map((provider) => provider.id));
  const installed = installedHost.listProviders().filter((provider) => !localIds.has(provider.id));
  const candidates = [...local, ...installed];
  const providers: ProviderDefinition[] = [];
  for (const provider of candidates) {
    try {
      await cacheProviderMetadata(provider);
    } catch (error) {
      logger.warn(`Failed to discover models for plugin provider ${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    providers.push(provider);
  }
  return providers;
}

export async function getProviderPlugin(id: string): Promise<ProviderDefinition | undefined> {
  return (await loadProviderPlugins()).find((provider) => provider.id === id);
}

function adapterProvider(providerId: string, adapter: ProviderAdapter): ProviderDefinition {
  return {
    id: providerId,
    name: adapter.name,
    models: adapter.models ?? { inherit: providerId },
    transport: adapter.transport,
    ...(adapter.auth && { auth: adapter.auth }),
    ...(adapter.prompts && { prompts: adapter.prompts }),
    ...(adapter.media && { media: adapter.media }),
  };
}

/** Higher-priority conditional adapters win; ties preserve local-first registration order. */
export async function getProviderAdapters(id: string): Promise<Array<{ owner: PluginIdentity; adapter: ProviderAdapter; provider: ProviderDefinition }>> {
  const installedHost = await getInstalledPluginHost();
  enterInstalledPluginHost(installedHost);
  const local = currentPluginHost()?.getProviderAdapterContributions(id) ?? [];
  const installed = installedHost.getProviderAdapterContributions(id);
  return [...local, ...installed]
    .sort((a, b) => (b.adapter.priority ?? 0) - (a.adapter.priority ?? 0))
    .map(({ owner, adapter }) => ({ owner, adapter, provider: adapterProvider(id, adapter) }));
}

export async function getActiveProviderAdapter(
  id: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ProviderDefinition | undefined> {
  for (const candidate of await getProviderAdapters(id)) {
    const context = createProviderPluginContext(candidate.provider, modelId, signal);
    if (await candidate.adapter.when(context)) {
      await cacheProviderMetadata(candidate.provider);
      selectActiveProvider(id, candidate.provider);
      return candidate.provider;
    }
  }
  selectActiveProvider(id, undefined);
  return undefined;
}

/** Remove a conditional adapter selected earlier in this execution chain. */
export function clearActiveProviderAdapter(id: string): void {
  selectActiveProvider(id, undefined);
}

export async function getProviderPatch(id: string) {
  const installed = (await getInstalledPluginHost()).getProviderPatch(id);
  const local = currentPluginHost()?.getProviderPatch(id);
  if (!local) return installed;
  return { ...installed, ...local, headers: { ...installed?.headers, ...local.headers } };
}

function registryModelDefinition(
  id: string,
  model: ModelInfo,
  patch?: Partial<Omit<ProviderModelDefinition, 'id' | 'name'>>,
): ProviderModelDefinition {
  const base: ProviderModelDefinition = {
    id,
    name: model.name,
    input: model.modalities.input.filter((item): item is 'text' | 'image' | 'pdf' | 'audio' =>
      item === 'text' || item === 'image' || item === 'pdf' || item === 'audio'),
    reasoning: model.reasoning,
    contextWindow: model.limit.context,
    maxOutputTokens: model.limit.output,
    cost: { input: model.cost.input, output: model.cost.output },
    capabilities: { tools: model.toolCall },
  };
  return {
    ...base,
    ...patch,
    ...(patch?.cost && { cost: { ...base.cost, ...patch.cost } }),
    ...(patch?.capabilities && { capabilities: { ...base.capabilities, ...patch.capabilities } }),
    ...(patch?.compatibility && { compatibility: { ...base.compatibility, ...patch.compatibility } }),
  };
}

export async function discoverProviderModels(provider: ProviderDefinition): Promise<ProviderModelDefinition[]> {
  let pending = discoveredModelsCache.get(provider);
  if (!pending) {
    pending = (async () => {
      if (Array.isArray(provider.models)) return provider.models;
      if (typeof provider.models === 'function') {
        return provider.models({
          signal: new AbortController().signal,
          fetch,
          env: process.env,
          log: hostLogger(provider.id),
        });
      }
      const spec = provider.models;
      const inherited = MODELS[spec.inherit as RegistryProvider] ?? {};
      return Object.entries(inherited)
        .filter(([id]) => !spec.include || spec.include.some((pattern) => minimatch(id, pattern)))
        .filter(([id]) => !spec.exclude?.some((pattern) => minimatch(id, pattern)))
        .map(([id, model]) => registryModelDefinition(id, model, spec.patch));
    })();
    discoveredModelsCache.set(provider, pending);
  }
  return pending;
}

const discoveredModelsCache = new WeakMap<ProviderDefinition, Promise<ProviderModelDefinition[]>>();

export function loadedPluginRegistryProviderCached(id: string): string | undefined {
  const models = scopedProvider(id)?.models;
  if (models && !Array.isArray(models) && typeof models === 'object' && 'inherit' in models) return models.inherit;
  return undefined;
}

export const loadedPluginRegistryProvider = loadedPluginRegistryProviderCached;

export function loadedPluginModel(providerId: string, modelId: string): ProviderModelDefinition | undefined {
  const provider = scopedProvider(providerId);
  if (provider) return resolvedModelsByProvider.get(provider)?.get(modelId);
  return undefined;
}

const resolvedModelsByProvider = new WeakMap<ProviderDefinition, Map<string, ProviderModelDefinition>>();

async function cacheProviderMetadata(provider: ProviderDefinition): Promise<void> {
  const discovered = await discoverProviderModels(provider);
  // Keep metadata attached to the provider definition itself. Conditional
  // adapters are newly materialized per request, so a WeakMap cannot leak one
  // project's transport or model patch into another project's selection.
  resolvedModelsByProvider.set(provider, new Map(discovered.map((model) => [model.id, model])));
}

function scopedProvider(providerId: string): ProviderDefinition | undefined {
  return currentPluginHost()?.getProvider(providerId)
    ?? currentInstalledPluginHost()?.getProvider(providerId)
    ?? currentActiveProvider(providerId);
}

export function loadedPluginProtocol(id: string): 'anthropic' | 'openai' | undefined {
  const selectedTransport = scopedProvider(id)?.transport;
  const kind = selectedTransport?.kind;
  if (kind === 'anthropic-messages') return 'anthropic';
  if (kind === 'openai-responses' || kind === 'openai-chat-completions') return 'openai';
  const transport = selectedTransport;
  if (transport?.kind === 'custom') return transport.providerOptionsKey as 'anthropic' | 'openai' | undefined;
  return undefined;
}

function authContext(name: string, signal?: AbortSignal): ProviderAuthContext {
  return {
    signal: signal ?? new AbortController().signal,
    fetch,
    env: process.env,
    log: hostLogger(name),
  };
}

async function readCredential(providerId: string, method: ProviderAuthMethod): Promise<PluginCredential | undefined> {
  const current = await AuthStorage.getPluginCredential(providerId, method.id);
  if (current) return current;
  const providerOAuth = await AuthStorage.migrateOAuthToPluginCredential(providerId, method.id);
  if (providerOAuth) return providerOAuth as unknown as PluginCredential;
  for (const alias of method.credentialAliases ?? []) {
    const oauth = await AuthStorage.migrateOAuthToPluginCredential(providerId, method.id, alias);
    if (oauth) return oauth as unknown as PluginCredential;
  }
  return undefined;
}

function needsRefresh(credential: PluginCredential): boolean {
  return typeof credential.expires === 'number' && credential.expires <= Date.now() + REFRESH_BUFFER_MS;
}

export async function resolveProviderAuth(
  provider: ProviderDefinition,
  methodId?: string,
  signal?: AbortSignal,
): Promise<ResolvedProviderAuth | undefined> {
  const methods = provider.auth?.methods ?? [];
  if (!methodId) {
    for (const candidate of methods) {
      const resolved = await resolveProviderAuth(provider, candidate.id, signal);
      if (resolved) return resolved;
    }
    return undefined;
  }
  const method = methodId ? methods.find((item) => item.id === methodId) : methods[0];
  if (!method) return undefined;
  const context = authContext(provider.id, signal);

  // Explicit environment credentials must win without touching or refreshing
  // stale stored state.
  if (method.environment?.some((name) => Boolean(context.env[name]))) {
    const environmentAuth = await method.resolve({}, context);
    if (environmentAuth) return environmentAuth;
  }

  let credential = await readCredential(provider.id, method);

  if (credential && method.refresh && needsRefresh(credential)) {
    const storedHere = await AuthStorage.getPluginCredential(provider.id, method.id);
    if (storedHere) {
      credential = await AuthStorage.updatePluginCredential(provider.id, method.id, async (latest) => {
        if (!latest || !needsRefresh(latest)) return { value: latest };
        const next = await method.refresh!(latest, context);
        return { value: next, next };
      });
    } else {
      credential = await method.refresh(credential, context);
      await AuthStorage.setPluginCredential(provider.id, method.id, credential);
      await AuthStorage.removeOAuth(provider.id);
    }
  }
  return method.resolve(credential ? { credential } : {}, context);
}

export async function loginProviderPlugin(
  provider: ProviderDefinition,
  interaction: AuthInteraction,
  methodId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const methods = provider.auth?.methods ?? [];
  let selectedMethodId = methodId;
  if (!selectedMethodId && methods.length > 1) {
    selectedMethodId = await interaction.select({
      message: `Select authentication method for ${provider.name}:`,
      choices: methods.map((method) => ({ value: method.id, label: method.name })),
    });
  }
  const method = selectedMethodId ? methods.find((item) => item.id === selectedMethodId) : methods[0];
  if (!method) throw new Error(`Provider '${provider.id}' does not support login`);
  const credential = await method.login(interaction, authContext(provider.id, signal));
  await AuthStorage.setPluginCredential(provider.id, method.id, credential);
}

export async function logoutProviderPlugin(
  provider: ProviderDefinition,
  methodType?: 'oauth' | 'api-key',
  methodId?: string,
): Promise<void> {
  for (const method of provider.auth?.methods ?? []) {
    if (methodType && method.type !== methodType) continue;
    if (methodId && method.id !== methodId) continue;
    const credential = await readCredential(provider.id, method);
    await method.logout?.(credential, authContext(provider.id));
    await AuthStorage.removePluginCredential(provider.id, method.id);
    await AuthStorage.removeOAuth(provider.id);
    for (const alias of method.credentialAliases ?? []) await AuthStorage.removeOAuth(alias);
  }
}

export async function providerPluginAuthStatus(
  provider: ProviderDefinition,
  owner?: PluginIdentity,
): Promise<ProviderAuthSourceStatus[]> {
  const sources: ProviderAuthSourceStatus[] = [];
  for (const method of provider.auth?.methods ?? []) {
    for (const envName of method.environment ?? []) {
      if (!process.env[envName]) continue;
      sources.push({ priority: 1, kind: 'environment', name: envName, stored: false, active: sources.length === 0 });
    }
    if (await readCredential(provider.id, method)) {
      sources.push({
        priority: 1,
        kind: method.type === 'api-key' ? 'api_key' : 'oauth',
        name: method.name,
        stored: true,
        active: sources.length === 0,
        ...(owner && { plugin: { name: owner.name, authMethodId: method.id } }),
      });
    }
  }
  return sources;
}

export function createProviderPluginContext(
  provider: ProviderDefinition,
  modelId: string,
  signal?: AbortSignal,
  sessionId?: string,
): ProviderRuntimeContext {
  return {
    ...authContext(provider.id, signal),
    providerId: provider.id,
    modelId,
    ...(sessionId && { sessionId }),
    auth: { resolve: (methodId) => resolveProviderAuth(provider, methodId, signal) },
  };
}

export function mergeProviderTransportHeaders(headers: Headers, additions: Record<string, string>): void {
  for (const [name, value] of Object.entries(additions)) {
    const existing = headers.get(name);
    if (name.toLowerCase() !== 'anthropic-beta' || !existing) {
      headers.set(name, value);
      continue;
    }
    const values = [...existing.split(','), ...value.split(',')]
      .map((item) => item.trim())
      .filter(Boolean);
    headers.set(name, [...new Set(values)].join(','));
  }
}

function mergeAuthHeaders(headers: Headers, auth: ResolvedProviderAuth | undefined): void {
  for (const [name, value] of Object.entries(auth?.headers ?? {})) headers.set(name, value);
  if (auth?.bearerToken) {
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${auth.bearerToken}`);
  }
}

function customRequest(options: LanguageModelV3CallOptions): ProviderRequest {
  return {
    messages: options.prompt.map((message) => ({
      ...message,
      ...(message.role !== 'system' && {
        content: message.content.map((part) => ({ ...part })),
      }),
    })) as ProviderRequest['messages'],
    tools: (options.tools ?? []).map((tool) => ({ ...tool })) as ProviderRequest['tools'],
    ...(options.toolChoice && { toolChoice: options.toolChoice }),
    ...(options.maxOutputTokens !== undefined && { maxOutputTokens: options.maxOutputTokens }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.stopSequences && { stopSequences: options.stopSequences }),
    ...(options.topP !== undefined && { topP: options.topP }),
    ...(options.topK !== undefined && { topK: options.topK }),
    ...(options.presencePenalty !== undefined && { presencePenalty: options.presencePenalty }),
    ...(options.frequencyPenalty !== undefined && { frequencyPenalty: options.frequencyPenalty }),
    ...(options.seed !== undefined && { seed: options.seed }),
    ...(options.responseFormat !== undefined && { responseFormat: options.responseFormat as NonNullable<ProviderRequest['responseFormat']> }),
    ...(options.providerOptions !== undefined && { providerOptions: options.providerOptions as NonNullable<ProviderRequest['providerOptions']> }),
    signal: options.abortSignal ?? new AbortController().signal,
  };
}

function customUsage(value?: ProviderUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: value?.inputTokens,
      noCache: value?.inputTokens,
      cacheRead: value?.cachedInputTokens,
      cacheWrite: value?.cacheWriteInputTokens,
    },
    outputTokens: {
      total: value?.outputTokens,
      text: value?.outputTokens,
      reasoning: value?.reasoningTokens,
    },
  };
}

function customFinishReason(reason: ProviderFinishReason, rawReason?: string): LanguageModelV3FinishReason {
  return { unified: reason, raw: rawReason ?? reason };
}

function customWarning(event: Extract<ProviderStreamEvent, { type: 'warning' }>): SharedV3Warning {
  return { type: 'unsupported', feature: event.feature, ...(event.message && { details: event.message }) };
}

async function customEvents(
  provider: ProviderDefinition,
  modelId: string,
  options: LanguageModelV3CallOptions,
  sessionId?: string,
): Promise<AsyncIterable<ProviderStreamEvent>> {
  if (provider.transport.kind !== 'custom') throw new Error(`Provider '${provider.id}' is not a custom transport`);
  const request = customRequest(options);
  return provider.transport.stream(request, createProviderPluginContext(provider, modelId, request.signal, sessionId));
}

/** Internal bridge from the stable plugin stream contract to the AI SDK. */
export function createCustomProviderModel(provider: ProviderDefinition, modelId: string, sessionId?: string): LanguageModelV3 {
  if (provider.transport.kind !== 'custom') throw new Error(`Provider '${provider.id}' is not a custom transport`);
  return {
    specificationVersion: 'v3',
    provider: provider.id,
    modelId,
    supportedUrls: {},
    async doStream(options) {
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          const warnings: SharedV3Warning[] = [];
          const openText = new Set<string>();
          const openReasoning = new Set<string>();
          let started = false;
          let finished = false;
          const ensureStarted = () => {
            if (started) return;
            started = true;
            controller.enqueue({ type: 'stream-start', warnings });
          };
          const closeBlocks = () => {
            for (const id of openText) controller.enqueue({ type: 'text-end', id });
            for (const id of openReasoning) controller.enqueue({ type: 'reasoning-end', id });
            openText.clear();
            openReasoning.clear();
          };
          try {
            for await (const event of await customEvents(provider, modelId, options, sessionId)) {
              if (event.type === 'warning') {
                if (started) throw new Error('Custom provider warnings must be emitted before response output');
                warnings.push(customWarning(event));
                continue;
              }
              ensureStarted();
              if (event.type === 'text-delta') {
                const id = event.id ?? 'text-0';
                if (!openText.has(id)) {
                  openText.add(id);
                  controller.enqueue({ type: 'text-start', id });
                }
                controller.enqueue({ type: 'text-delta', id, delta: event.delta });
              } else if (event.type === 'reasoning-delta') {
                const id = event.id ?? 'reasoning-0';
                if (!openReasoning.has(id)) {
                  openReasoning.add(id);
                  controller.enqueue({ type: 'reasoning-start', id });
                }
                controller.enqueue({ type: 'reasoning-delta', id, delta: event.delta });
              } else if (event.type === 'tool-call') {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: event.id,
                  toolName: event.name,
                  input: JSON.stringify(event.input ?? {}),
                });
              } else if (event.type === 'response-metadata') {
                controller.enqueue({
                  type: 'response-metadata',
                  ...(event.id && { id: event.id }),
                  ...(event.modelId && { modelId: event.modelId }),
                  ...(event.timestamp !== undefined && { timestamp: new Date(event.timestamp) }),
                });
              } else if (event.type === 'error') {
                controller.enqueue({ type: 'error', error: event.error });
              } else if (event.type === 'finish') {
                closeBlocks();
                controller.enqueue({
                  type: 'finish',
                  usage: customUsage(event.usage),
                  finishReason: customFinishReason(event.reason, event.rawReason),
                });
                finished = true;
                break;
              }
            }
            if (!finished) throw new Error(`Custom provider '${provider.id}' ended without a finish event`);
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return { stream };
    },
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const warnings: SharedV3Warning[] = [];
      const content: Array<LanguageModelV3Content & { text?: string }> = [];
      const textBlocks = new Map<string, { type: 'text'; text: string }>();
      const reasoningBlocks = new Map<string, { type: 'reasoning'; text: string }>();
      let response: LanguageModelV3GenerateResult['response'];
      let finish: Extract<ProviderStreamEvent, { type: 'finish' }> | undefined;
      for await (const event of await customEvents(provider, modelId, options, sessionId)) {
        if (event.type === 'warning') {
          warnings.push(customWarning(event));
        } else if (event.type === 'text-delta') {
          const id = event.id ?? 'text-0';
          let block = textBlocks.get(id);
          if (!block) {
            block = { type: 'text', text: '' };
            textBlocks.set(id, block);
            content.push(block);
          }
          block.text += event.delta;
        } else if (event.type === 'reasoning-delta') {
          const id = event.id ?? 'reasoning-0';
          let block = reasoningBlocks.get(id);
          if (!block) {
            block = { type: 'reasoning', text: '' };
            reasoningBlocks.set(id, block);
            content.push(block);
          }
          block.text += event.delta;
        } else if (event.type === 'tool-call') {
          content.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: event.name,
            input: JSON.stringify(event.input ?? {}),
          });
        } else if (event.type === 'response-metadata') {
          response = {
            ...(event.id && { id: event.id }),
            ...(event.modelId && { modelId: event.modelId }),
            ...(event.timestamp !== undefined && { timestamp: new Date(event.timestamp) }),
          };
        } else if (event.type === 'error') {
          throw event.error;
        } else if (event.type === 'finish') {
          finish = event;
          break;
        }
      }
      if (!finish) throw new Error(`Custom provider '${provider.id}' ended without a finish event`);
      return {
        content,
        finishReason: customFinishReason(finish.reason, finish.rawReason),
        usage: customUsage(finish.usage),
        warnings,
        ...(response && { response }),
      };
    },
  };
}

export async function createProviderPluginModel(provider: ProviderDefinition, modelId: string, sessionId?: string): Promise<LanguageModel> {
  await loadProviderPlugins();
  if (provider.transport.kind === 'custom') return createCustomProviderModel(provider, modelId, sessionId);
  const context = createProviderPluginContext(provider, modelId, undefined, sessionId);

  const initialAuth = await context.auth.resolve();
  if (provider.auth && !initialAuth) {
    throw new Error(`No authentication found for ${provider.name}. Run \`agentuse provider login ${provider.id}\``);
  }
  const transport = provider.transport;
  const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    mergeProviderTransportHeaders(headers, transport.headers ?? {});
    mergeAuthHeaders(headers, await context.auth.resolve());
    if (initialAuth?.bearerToken && transport.baseURL) {
      const actual = new URL(input instanceof Request ? input.url : input);
      const expected = new URL(transport.baseURL);
      if (actual.origin !== expected.origin) {
        throw new Error(`Refusing to send ${provider.name} bearer credentials to ${actual.origin}`);
      }
    }
    return context.fetch(input, {
      ...init,
      headers,
      signal: init?.signal ?? context.signal,
      ...(initialAuth?.bearerToken && { redirect: 'error' as const }),
    });
  };

  if (transport.kind === 'anthropic-messages') {
    const anthropic = createAnthropic({
      apiKey: initialAuth?.apiKey ?? '',
      ...(transport.baseURL && { baseURL: transport.baseURL }),
      fetch: authenticatedFetch as typeof fetch,
    });
    return anthropic.chat(modelId);
  }

  const openai = createOpenAI({
    apiKey: initialAuth?.apiKey ?? initialAuth?.bearerToken ?? '',
    ...(transport.baseURL && { baseURL: transport.baseURL }),
    fetch: authenticatedFetch as typeof fetch,
  });
  return transport.kind === 'openai-responses' ? openai.responses(modelId) : openai.chat(modelId);
}
