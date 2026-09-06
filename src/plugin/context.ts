import { AsyncLocalStorage } from 'async_hooks';
import type { PluginHost } from './host';
import type { ProviderDefinition } from './types';

interface PluginScope {
  local?: PluginHost;
  /**
   * Mutable slot, not a value: the installed host is resolved after an await,
   * and enterWith() after an await never reaches the caller's continuation.
   * The slot object is created synchronously so the caller shares it.
   */
  installed?: { host?: PluginHost };
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
    installed: {},
    ...(projectRoot && { projectRoot }),
  });
}

export function currentPluginHost(): PluginHost | undefined {
  return pluginScope.getStore()?.local;
}

export function enterInstalledPluginHost(host: PluginHost): void {
  ensureProviderSelectionScope();
  pluginScope.getStore()!.installed!.host = host;
}

export function currentInstalledPluginHost(): PluginHost | undefined {
  return pluginScope.getStore()?.installed?.host;
}

export function currentPluginProjectRoot(): string | undefined {
  return pluginScope.getStore()?.projectRoot;
}

/**
 * Ensure direct library consumers also have an execution-local adapter map and
 * installed-host slot. Must run before the first await of the calling function
 * so the caller's continuation shares the same store.
 */
export function ensureProviderSelectionScope(): void {
  const current = pluginScope.getStore();
  if (current?.activeProviders && current.installed) return;
  pluginScope.enterWith({
    ...current,
    activeProviders: current?.activeProviders ?? new Map(),
    installed: current?.installed ?? {},
  });
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
