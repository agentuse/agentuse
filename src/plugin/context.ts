import { AsyncLocalStorage } from 'async_hooks';
import type { PluginHost } from './host';
import type { ProviderDefinition } from './types';

interface PluginScope {
  local?: PluginHost;
  installed?: PluginHost;
  projectRoot?: string;
  /** Adapter metadata selected for this execution/request chain. */
  activeProviders?: Map<string, ProviderDefinition>;
}

const pluginScope = new AsyncLocalStorage<PluginScope>();

/** Bind project-local registrations to the current execution/request chain. */
export function enterPluginHost(host: PluginHost, projectRoot?: string): void {
  pluginScope.enterWith({
    ...pluginScope.getStore(),
    local: host,
    // A PluginManager represents one execution/request. Give it an independent
    // selection map so two projects can select different adapters for the same
    // built-in provider without sharing process-global metadata.
    activeProviders: new Map(),
    ...(projectRoot && { projectRoot }),
  });
}

export function currentPluginHost(): PluginHost | undefined {
  return pluginScope.getStore()?.local;
}

export function enterInstalledPluginHost(host: PluginHost): void {
  pluginScope.enterWith({ ...pluginScope.getStore(), installed: host });
}

export function currentInstalledPluginHost(): PluginHost | undefined {
  return pluginScope.getStore()?.installed;
}

export function currentPluginProjectRoot(): string | undefined {
  return pluginScope.getStore()?.projectRoot;
}

/** Ensure direct library consumers also have an execution-local adapter map. */
export function ensureProviderSelectionScope(): void {
  const current = pluginScope.getStore();
  if (current?.activeProviders) return;
  pluginScope.enterWith({ ...current, activeProviders: new Map() });
}

export function selectActiveProvider(providerId: string, provider: ProviderDefinition | undefined): void {
  ensureProviderSelectionScope();
  const selected = pluginScope.getStore()!.activeProviders!;
  if (provider) selected.set(providerId, provider);
  else selected.delete(providerId);
}

export function currentActiveProvider(providerId: string): ProviderDefinition | undefined {
  return pluginScope.getStore()?.activeProviders?.get(providerId);
}

export function clearActiveProviders(): void {
  pluginScope.getStore()?.activeProviders?.clear();
}
