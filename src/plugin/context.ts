import { AsyncLocalStorage } from 'async_hooks';
import type { PluginHost } from './host';

interface PluginScope { local?: PluginHost; installed?: PluginHost; projectRoot?: string }

const pluginScope = new AsyncLocalStorage<PluginScope>();

/** Bind project-local registrations to the current execution/request chain. */
export function enterPluginHost(host: PluginHost, projectRoot?: string): void {
  pluginScope.enterWith({ ...pluginScope.getStore(), local: host, ...(projectRoot && { projectRoot }) });
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
