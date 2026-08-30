import { glob } from 'glob';
import { basename, join } from 'path';
import type {
  AgentCompleteEvent,
  PluginEvents,
  PluginHandlers,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from './types';
import type { PluginIdentity } from './internal-types';
import { PluginHost } from './host';
import { importPluginModule } from './loader';
import { logger } from '../utils/logger';
import { enterPluginHost } from './context';
import { getInstalledPluginHost } from './provider-runtime';
import { getGlobalConfigDir } from '../utils/global-config';

/** Per-execution facade over the unified plugin host. */
export class PluginManager {
  readonly host = new PluginHost();
  /** @deprecated Compatibility for existing diagnostics/tests. */
  private plugins: Array<{ path: string; handlers: PluginHandlers }> = [];
  private hostManagedPaths = new Set<string>();

  async loadPlugins(customDirs?: string[], projectRoot?: string): Promise<void> {
    // enterWith keeps project registrations isolated to this async execution
    // chain, including concurrent serve requests for different projects.
    enterPluginHost(this.host, projectRoot);
    const pluginPaths = customDirs && customDirs.length > 0
      ? customDirs.map((dir) => join(dir, '*.{ts,js}'))
      : [
          './.agentuse/plugins/*.{ts,js}',
          join(getGlobalConfigDir(), 'plugins/*.{ts,js}')
        ];

    for (const pattern of pluginPaths) {
      try {
        const files = await glob(pattern, { absolute: true });
        for (const file of files) {
          try {
            const exported = await importPluginModule(file);
            const identity: PluginIdentity = {
              name: basename(file),
              source: file,
              scope: file.startsWith(join(getGlobalConfigDir(), 'plugins')) ? 'global' : 'project',
            };
            await this.host.activate(identity, exported);
            if (exported && typeof exported === 'object') {
              this.plugins.push({ path: file, handlers: exported as PluginHandlers });
              this.hostManagedPaths.add(file);
            }
            logger.debug(`Loaded plugin: ${file}`);
          } catch (error) {
            logger.warn(`Failed to load plugin ${file}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.debug(`Plugin search path ${pattern} not found or inaccessible`);
      }
    }
    if (this.plugins.length > 0) logger.info(`Loaded ${this.plugins.length} plugin(s)`);
  }

  async emit<E extends Exclude<keyof PluginEvents, 'agent:complete' | 'tool:call' | 'tool:result'>>(
    name: E,
    event: PluginEvents[E],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.host.emit(name, event, signal);
    await (await getInstalledPluginHost()).emit(name, event, signal);
  }

  async dispatchToolCall(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult> {
    const local = await this.host.dispatchToolCall(event, signal);
    if (local.block) return local;
    const installed = await (await getInstalledPluginHost()).dispatchToolCall(event, signal);
    return { ...local, ...installed };
  }

  async dispatchToolResult(event: ToolResultEvent, signal?: AbortSignal): Promise<ToolResultEvent> {
    const local = await this.host.dispatchToolResult(event, signal);
    return (await getInstalledPluginHost()).dispatchToolResult(local, signal);
  }

  async emitAgentComplete(event: AgentCompleteEvent, signal?: AbortSignal): Promise<AgentCompleteEvent> {
    let current = await this.host.dispatchAgentComplete(event, signal);
    current = await (await getInstalledPluginHost()).dispatchAgentComplete(current, signal);
    // Preserve the old class's directly mutable diagnostic surface. Some
    // embedders inject handlers here instead of using loadPlugins().
    const legacyEvent = structuredClone(current);
    for (const plugin of this.plugins) {
      if (this.hostManagedPaths.has(plugin.path)) continue;
      try {
        await plugin.handlers['agent:complete']?.(legacyEvent);
      } catch (error) {
        logger.info(`Plugin '${plugin.path}' failed: ${error instanceof Error ? error.message : String(error)}`);
        logger.warn(`Plugin error in ${plugin.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return current;
  }
}

export { PluginHost } from './host';
export type {
  AgentCompleteEvent,
  AgentCompleteEventResult,
  AgentErrorEvent,
  AgentReference,
  AgentResumeEvent,
  AgentStartEvent,
  AgentSuspendEvent,
  AgentUsePlugin,
  AgentUsePluginAPI,
  AuthInteraction,
  Plugin,
  PluginHandlers,
  ModelFallbackEvent,
  ProviderDefinition,
  ProviderFinishReason,
  ProviderMessage,
  ProviderMessagePart,
  ProviderModelDefinition,
  ProviderOptions,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolChoice,
  ProviderToolDefinition,
  ProviderTransport,
  ProviderUsage,
  ToolCallEvent,
  ToolCallEventResult,
  ToolCallTrace,
  ToolResultEvent,
  ToolResultEventResult,
} from './types';
