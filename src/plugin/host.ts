import { BUILTIN_PROVIDERS } from '../providers/registry-sources';
import { logger } from '../utils/logger';
import {
  type AgentUseExtension,
  type AgentUsePluginAPI,
  type Disposable,
  type PluginEventContext,
  type PluginEventHandler,
  type PluginEvents,
  type PluginHandlers,
  type PluginLogger,
  type AgentCompleteEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
  type ProviderDefinition,
  type ProviderAdapter,
  type ProviderPatch,
} from './types';
import type { PluginIdentity } from './internal-types';

interface Registration<T> { owner: PluginIdentity; value: T }
interface ActivatedExtension { identity: PluginIdentity; disposables: Disposable[] }

function pluginLogger(identity: PluginIdentity): PluginLogger {
  const prefix = `[Plugin ${identity.name}]`;
  return {
    debug: (message) => logger.debug(`${prefix} ${message}`),
    info: (message) => logger.info(`${prefix} ${message}`),
    warn: (message) => logger.warn(`${prefix} ${message}`),
  };
}

function disposable(remove: () => void | Promise<void>): Disposable {
  let active = true;
  return { async dispose() { if (active) { active = false; await remove(); } } };
}

function isLegacyEventPlugin(value: unknown): value is PluginHandlers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 0 || entries.every(([name, handler]) => name === 'agent:complete' && typeof handler === 'function');
}

function validateProvider(provider: ProviderDefinition, identity: PluginIdentity): void {
  if (!provider.id || !/^[a-z0-9][a-z0-9._-]*$/.test(provider.id)) {
    throw new Error(`Plugin ${identity.name} registered invalid provider id '${provider.id}'`);
  }
  if (!provider.name || !provider.transport || provider.models === undefined) {
    throw new Error(`Provider '${provider.id}' must define name, models, and transport`);
  }
  if (provider.transport.kind === 'custom'
    && (provider.transport.apiVersion !== 1 || typeof provider.transport.stream !== 'function')) {
    throw new Error(`Provider '${provider.id}' custom transport must define apiVersion: 1 and stream()`);
  }
  if (BUILTIN_PROVIDERS.includes(provider.id) && !provider.override) {
    throw new Error(`Provider '${provider.id}' is built in; set override: true to replace it explicitly`);
  }
  const methodIds = new Set<string>();
  for (const method of provider.auth?.methods ?? []) {
    if (!method.id || methodIds.has(method.id)) throw new Error(`Provider '${provider.id}' has a duplicate auth method id`);
    methodIds.add(method.id);
    if (typeof method.login !== 'function' || typeof method.resolve !== 'function') {
      throw new Error(`Provider '${provider.id}' auth method '${method.id}' must define login and resolve`);
    }
  }
}

function validateProviderAdapter(providerId: string, adapter: ProviderAdapter, identity: PluginIdentity): void {
  if (!BUILTIN_PROVIDERS.includes(providerId)) {
    throw new Error(`Plugin ${identity.name} can only extend a built-in provider; '${providerId}' is not built in`);
  }
  if (!adapter.name || !adapter.transport || typeof adapter.when !== 'function') {
    throw new Error(`Provider adapter '${providerId}' must define name, transport, and when()`);
  }
  validateProvider({
    id: `adapter-${providerId}`,
    name: adapter.name,
    models: adapter.models ?? [],
    transport: adapter.transport,
    ...(adapter.auth && { auth: adapter.auth }),
    ...(adapter.prompts && { prompts: adapter.prompts }),
    ...(adapter.media && { media: adapter.media }),
  }, identity);
}

export class PluginHost {
  private events = new Map<keyof PluginEvents, Array<Registration<PluginEventHandler<any>>>>();
  private providers = new Map<string, Registration<ProviderDefinition>>();
  private patches = new Map<string, Array<Registration<ProviderPatch>>>();
  private adapters = new Map<string, Array<Registration<ProviderAdapter>>>();
  private activated: ActivatedExtension[] = [];

  async activate(identity: PluginIdentity, exported: unknown): Promise<Disposable> {
    const disposables: Disposable[] = [];
    const log = pluginLogger(identity);
    const api: AgentUsePluginAPI = {
      log,
      on: <E extends keyof PluginEvents>(event: E, handler: PluginEventHandler<E>) => {
        if (typeof handler !== 'function') throw new Error(`Handler for '${event}' must be a function`);
        const registration: Registration<PluginEventHandler<E>> = { owner: identity, value: handler };
        const handlers = this.events.get(event) ?? [];
        handlers.push(registration);
        this.events.set(event, handlers);
        const result = disposable(() => {
          this.events.set(event, (this.events.get(event) ?? []).filter((item) => item !== registration));
        });
        disposables.push(result);
        return result;
      },
      registerProvider: ((providerOrId: ProviderDefinition | string, patch?: ProviderPatch | ProviderAdapter) => {
        if (typeof providerOrId === 'string') {
          if (!patch) throw new Error(`Provider patch for '${providerOrId}' is missing`);
          if ('transport' in patch) {
            validateProviderAdapter(providerOrId, patch, identity);
            const registration: Registration<ProviderAdapter> = { owner: identity, value: patch };
            this.adapters.set(providerOrId, [...(this.adapters.get(providerOrId) ?? []), registration]);
            const result = disposable(() => {
              this.adapters.set(providerOrId, (this.adapters.get(providerOrId) ?? []).filter((item) => item !== registration));
            });
            disposables.push(result);
            return result;
          }
          const registration: Registration<ProviderPatch> = { owner: identity, value: patch };
          this.patches.set(providerOrId, [...(this.patches.get(providerOrId) ?? []), registration]);
          const result = disposable(() => {
            this.patches.set(providerOrId, (this.patches.get(providerOrId) ?? []).filter((item) => item !== registration));
          });
          disposables.push(result);
          return result;
        }
        validateProvider(providerOrId, identity);
        const existing = this.providers.get(providerOrId.id);
        if (existing) throw new Error(`Provider '${providerOrId.id}' is already registered by ${existing.owner.name}`);
        const registration: Registration<ProviderDefinition> = { owner: identity, value: providerOrId };
        this.providers.set(providerOrId.id, registration);
        const result = disposable(() => {
          if (this.providers.get(providerOrId.id) === registration) this.providers.delete(providerOrId.id);
        });
        disposables.push(result);
        return result;
      }) as AgentUsePluginAPI['registerProvider'],
      unregisterProvider: (providerId) => {
        if (this.providers.get(providerId)?.owner === identity) this.providers.delete(providerId);
        this.patches.set(providerId, (this.patches.get(providerId) ?? []).filter((item) => item.owner !== identity));
        this.adapters.set(providerId, (this.adapters.get(providerId) ?? []).filter((item) => item.owner !== identity));
      },
    };

    try {
      if (typeof exported === 'function') {
        await (exported as AgentUseExtension)(api);
      } else if (isLegacyEventPlugin(exported)) {
        for (const [event, handler] of Object.entries(exported) as Array<[keyof PluginEvents, (event: unknown) => unknown]>) {
          api.on(event, async (payload) => { await handler(payload); });
        }
        log.debug('Loaded through the legacy event-object compatibility adapter');
      } else {
        throw new Error('Invalid plugin format: default export must be an AgentUse extension activation function or legacy event-handler object');
      }
      const activated = { identity, disposables };
      this.activated.push(activated);
      return disposable(async () => {
        await Promise.allSettled([...disposables].reverse().map((item) => item.dispose()));
        this.activated = this.activated.filter((item) => item !== activated);
      });
    } catch (error) {
      await Promise.allSettled(disposables.reverse().map((item) => item.dispose()));
      throw error;
    }
  }

  getProvider(providerId: string): ProviderDefinition | undefined { return this.providers.get(providerId)?.value; }
  getProviderOwner(providerId: string): PluginIdentity | undefined { return this.providers.get(providerId)?.owner; }
  listProviders(): ProviderDefinition[] { return [...this.providers.values()].map((item) => item.value); }
  listProviderContributions(): Array<{
    owner: PluginIdentity;
    providerId: string;
    provider: ProviderDefinition | ProviderAdapter;
    kind: 'provider' | 'adapter';
  }> {
    return [
      ...[...this.providers.entries()].map(([providerId, item]) => ({
        owner: item.owner,
        providerId,
        provider: item.value,
        kind: 'provider' as const,
      })),
      ...[...this.adapters.entries()].flatMap(([providerId, items]) => items.map((item) => ({
        owner: item.owner,
        providerId,
        provider: item.value,
        kind: 'adapter' as const,
      }))),
    ];
  }
  getProviderAdapterContributions(providerId: string): Array<{ owner: PluginIdentity; adapter: ProviderAdapter }> {
    return (this.adapters.get(providerId) ?? [])
      .map((item) => ({ owner: item.owner, adapter: item.value }))
      .sort((a, b) => (b.adapter.priority ?? 0) - (a.adapter.priority ?? 0));
  }

  getProviderPatch(providerId: string): ProviderPatch | undefined {
    const values = this.patches.get(providerId) ?? [];
    if (values.length === 0) return undefined;
    return values.reduce<ProviderPatch>((result, item) => ({
      ...result,
      ...item.value,
      headers: { ...result.headers, ...item.value.headers },
    }), {});
  }

  private eventContext(signal?: AbortSignal): PluginEventContext {
    return { signal: signal ?? new AbortController().signal };
  }

  private reportEventError(registration: Registration<PluginEventHandler<any>>, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.info(`Plugin '${registration.owner.name}' failed: ${message}`);
    logger.warn(`Plugin error in ${registration.owner.source}: ${message}`);
  }

  async emit<E extends keyof PluginEvents>(event: E, payload: PluginEvents[E], signal?: AbortSignal): Promise<void> {
    for (const registration of this.events.get(event) ?? []) {
      try {
        await registration.value(structuredClone(payload), this.eventContext(signal));
      } catch (error) {
        this.reportEventError(registration, error);
      }
    }
  }

  /** Pi-style interception: handlers share and may mutate tool input in registration order. */
  async dispatchToolCall(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult> {
    let decision: ToolCallEventResult = {};
    for (const registration of this.events.get('tool:call') ?? []) {
      try {
        const result = await registration.value(event, this.eventContext(signal)) as ToolCallEventResult | void;
        if (result) decision = { ...decision, ...result };
        if (decision.block) break;
      } catch (error) {
        this.reportEventError(registration, error);
      }
    }
    return decision;
  }

  /** Pi-style result chaining: returned fields become the next handler's input. */
  async dispatchToolResult(event: ToolResultEvent, signal?: AbortSignal): Promise<ToolResultEvent> {
    const current = { ...event };
    for (const registration of this.events.get('tool:result') ?? []) {
      try {
        const result = await registration.value(
          structuredClone(current),
          this.eventContext(signal),
        ) as { output?: unknown; isError?: boolean } | void;
        if (result && Object.hasOwn(result, 'output')) current.output = result.output;
        if (result?.isError !== undefined) current.isError = result.isError;
      } catch (error) {
        this.reportEventError(registration, error);
      }
    }
    return current;
  }

  /** Completion handlers may replace only final text; telemetry stays immutable. */
  async dispatchAgentComplete(event: AgentCompleteEvent, signal?: AbortSignal): Promise<AgentCompleteEvent> {
    const current = structuredClone(event);
    for (const registration of this.events.get('agent:complete') ?? []) {
      try {
        const result = await registration.value(
          structuredClone(current),
          this.eventContext(signal),
        ) as { text?: string } | void;
        if (result?.text !== undefined) current.result.text = result.text;
      } catch (error) {
        this.reportEventError(registration, error);
      }
    }
    return current;
  }

  async dispose(): Promise<void> {
    for (const plugin of [...this.activated].reverse()) {
      await Promise.allSettled([...plugin.disposables].reverse().map((item) => item.dispose()));
    }
    this.activated = [];
    this.events.clear();
    this.providers.clear();
    this.patches.clear();
    this.adapters.clear();
  }
}
