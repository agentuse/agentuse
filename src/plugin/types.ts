export interface ToolCallTrace {
  name: string;
  type: 'tool' | 'subagent' | 'llm';
  startTime: number;
  duration: number;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  success?: boolean;
  input?: unknown;
  output?: unknown;
}

export interface AgentCompleteEvent {
  agent: { name: string; model: string; description?: string; filePath?: string };
  result: {
    text: string;
    duration: number;
    tokens?: number;
    toolCalls: number;
    toolCallTraces?: ToolCallTrace[];
    finishReason?: string;
    finishReasons?: string[];
    hasTextOutput: boolean;
  };
  isSubAgent: boolean;
  consoleOutput: string;
}

export interface AgentReference {
  name: string;
  model: string;
  description?: string;
  filePath?: string;
}

export interface AgentStartEvent {
  agent: AgentReference;
  sessionId?: string;
  trigger: 'scheduled' | 'manual' | 'slack' | 'api' | 'onboarding';
}

export interface AgentErrorEvent {
  agent: AgentReference;
  sessionId?: string;
  error: { name?: string; message: string; code?: string };
  duration: number;
}

export interface AgentSuspendEvent {
  agent: AgentReference;
  sessionId: string;
  reason: 'approval';
  toolCallId?: string;
  approvalUrl?: string;
}

export interface AgentResumeEvent {
  agent: AgentReference;
  sessionId: string;
  reason: 'approval' | 'continue';
}

export interface ModelFallbackEvent {
  agent: AgentReference;
  sessionId?: string;
  from: string;
  to: string;
  reason: string;
  attempt: number;
}

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
}

export interface ToolResultEventResult {
  output?: unknown;
  isError?: boolean;
}

export interface AgentCompleteEventResult {
  text?: string;
}

export interface PluginEvents {
  'agent:start': AgentStartEvent;
  'agent:complete': AgentCompleteEvent;
  'agent:error': AgentErrorEvent;
  'agent:suspend': AgentSuspendEvent;
  'agent:resume': AgentResumeEvent;
  'tool:call': ToolCallEvent;
  'tool:result': ToolResultEvent;
  'model:fallback': ModelFallbackEvent;
}

export interface PluginEventResults {
  'agent:start': void;
  'agent:complete': AgentCompleteEventResult;
  'agent:error': void;
  'agent:suspend': void;
  'agent:resume': void;
  'tool:call': ToolCallEventResult;
  'tool:result': ToolResultEventResult;
  'model:fallback': void;
}

export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface PluginEventContext {
  readonly signal: AbortSignal;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type PluginEventInput<E extends keyof PluginEvents> = E extends 'tool:call'
  ? PluginEvents[E]
  : DeepReadonly<PluginEvents[E]>;

export type PluginEventHandler<E extends keyof PluginEvents> = (
  event: PluginEventInput<E>,
  context: PluginEventContext,
) => PluginEventResults[E] | void | Promise<PluginEventResults[E] | void>;

/** @deprecated Export an AgentUseExtension and register handlers with api.on(). */
export interface PluginHandlers {
  'agent:complete'?: (event: AgentCompleteEvent) => void | Promise<void>;
}

/** @deprecated Use AgentUseExtension. */
export type Plugin = PluginHandlers;

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface ProviderModelDefinition {
  id: string;
  name: string;
  input: Array<'text' | 'image' | 'pdf' | 'audio'>;
  reasoning: boolean | {
    levels: Array<'minimal' | 'low' | 'medium' | 'high'>;
    default?: 'minimal' | 'low' | 'medium' | 'high';
  };
  contextWindow: number;
  maxOutputTokens: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  capabilities?: {
    tools?: boolean;
    parallelToolCalls?: boolean;
    promptCaching?: boolean;
    structuredOutput?: boolean;
  };
  compatibility?: Record<string, boolean | string | number>;
}

export type ProviderModels =
  | ProviderModelDefinition[]
  | {
      inherit: string;
      include?: string[];
      exclude?: string[];
      /** Apply transport-specific metadata without renaming inherited models. */
      patch?: Partial<Omit<ProviderModelDefinition, 'id' | 'name'>>;
    }
  | ((context: ProviderDiscoveryContext) => ProviderModelDefinition[] | Promise<ProviderModelDefinition[]>);

export interface ProviderDiscoveryContext {
  signal: AbortSignal;
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  log: PluginLogger;
}

export interface ResolvedProviderAuth {
  apiKey?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
  source: string;
}

export type PluginCredential = Record<string, unknown>;

export interface ProviderAuthContext extends ProviderDiscoveryContext {}
export interface ProviderAuthResolveInput { credential?: PluginCredential }

export interface ProviderAuthMethod {
  id: string;
  type: 'oauth' | 'api-key' | 'external';
  name: string;
  environment?: string[];
  credentialAliases?: string[];
  login(interaction: AuthInteraction, context: ProviderAuthContext): Promise<PluginCredential>;
  refresh?(credential: PluginCredential, context: ProviderAuthContext): Promise<PluginCredential>;
  resolve(
    input: ProviderAuthResolveInput,
    context: ProviderAuthContext,
  ): ResolvedProviderAuth | undefined | Promise<ResolvedProviderAuth | undefined>;
  logout?(credential: PluginCredential | undefined, context: ProviderAuthContext): void | Promise<void>;
}

export interface AuthInteraction {
  openBrowser(options: { url: string }): void | Promise<void>;
  showDeviceCode(options: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;
  prompt(options: { message: string; secret?: boolean }): Promise<string>;
  select<T extends string>(options: {
    message: string;
    choices: Array<{ value: T; label: string }>;
  }): Promise<T>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

export interface ProviderRuntimeContext extends ProviderDiscoveryContext {
  providerId: string;
  modelId: string;
  auth: { resolve(methodId?: string): Promise<ResolvedProviderAuth | undefined> };
}

/** Provider-scoped options forwarded without depending on an internal SDK type. */
export type ProviderOptions = Readonly<Record<string, Record<string, unknown>>>;

export type ProviderToolResultOutput =
  | { type: 'text' | 'error-text'; value: string }
  | { type: 'json' | 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }
  | { type: 'content'; value: unknown[] };

export type ProviderMessagePart = (
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'file'; filename?: string; data: string | Uint8Array | URL; mediaType: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: ProviderToolResultOutput }
  | { type: 'tool-approval-response'; approvalId: string; approved: boolean; reason?: string }
) & { providerOptions?: ProviderOptions };

export type ProviderMessage =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user' | 'assistant' | 'tool'; content: ProviderMessagePart[]; providerOptions?: ProviderOptions };

export type ProviderToolDefinition =
  | {
      type: 'function';
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      inputExamples?: Array<{ input: Record<string, unknown> }>;
      strict?: boolean;
      providerOptions?: ProviderOptions;
    }
  | { type: 'provider'; id: `${string}.${string}`; name: string; args: Record<string, unknown> };

export type ProviderToolChoice =
  | { type: 'auto' | 'none' | 'required' }
  | { type: 'tool'; toolName: string };

/** Normalized input delivered to every apiVersion 1 custom transport call. */
export interface ProviderRequest {
  messages: ProviderMessage[];
  tools: ProviderToolDefinition[];
  toolChoice?: ProviderToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseFormat?:
    | { type: 'text' }
    | { type: 'json'; schema?: Record<string, unknown>; name?: string; description?: string };
  providerOptions?: ProviderOptions;
  signal: AbortSignal;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
}

export type ProviderFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

/**
 * Events emitted by a custom provider. Warnings must precede output and every
 * successful stream must terminate with exactly one finish event.
 */
export type ProviderStreamEvent =
  | { type: 'warning'; feature: string; message?: string }
  | { type: 'text-delta'; delta: string; id?: string }
  | { type: 'reasoning-delta'; delta: string; id?: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'response-metadata'; id?: string; modelId?: string; timestamp?: number }
  | { type: 'error'; error: unknown }
  | { type: 'finish'; reason: ProviderFinishReason; rawReason?: string; usage?: ProviderUsage };

export type ProviderTransport =
  | {
      kind: 'anthropic-messages';
      baseURL?: string;
      headers?: Record<string, string>;
      compatibility?: Record<string, boolean | string | number>;
    }
  | {
      kind: 'openai-responses' | 'openai-chat-completions';
      baseURL?: string;
      headers?: Record<string, string>;
      compatibility?: Record<string, boolean | string | number>;
    }
  | {
      kind: 'custom';
      apiVersion: 1;
      providerOptionsKey?: string;
      stream(
        request: ProviderRequest,
        context: ProviderRuntimeContext,
      ): AsyncIterable<ProviderStreamEvent> | Promise<AsyncIterable<ProviderStreamEvent>>;
    };

export interface PromptContribution {
  id: string;
  content: string;
  position?: 'prepend' | 'append';
  portable?: boolean;
}

export interface ProviderPromptContext extends ProviderRuntimeContext {}

export interface ProviderPromptDefinition {
  system?(context: ProviderPromptContext): PromptContribution[] | Promise<PromptContribution[]>;
  helper?(context: ProviderPromptContext & { role: string }): PromptContribution[] | Promise<PromptContribution[]>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  models: ProviderModels;
  transport: ProviderTransport;
  auth?: { methods: ProviderAuthMethod[] };
  prompts?: ProviderPromptDefinition;
  media?: { image: boolean; pdf: boolean };
  override?: boolean;
}

/**
 * A conditional transport contributed to an existing provider namespace.
 * Adapters leave the built-in provider untouched unless `when` selects them.
 */
export interface ProviderAdapter {
  name: string;
  /** Defaults to inheriting the adapted provider's model catalog unchanged. */
  models?: ProviderModels;
  transport: ProviderTransport;
  auth?: { methods: ProviderAuthMethod[] };
  prompts?: ProviderPromptDefinition;
  media?: { image: boolean; pdf: boolean };
  priority?: number;
  when(context: ProviderRuntimeContext): boolean | Promise<boolean>;
}

export interface ProviderPatch {
  baseURL?: string;
  headers?: Record<string, string>;
}

export interface AgentUsePluginAPI {
  on<E extends keyof PluginEvents>(event: E, handler: PluginEventHandler<E>): Disposable;
  registerProvider(provider: ProviderDefinition): Disposable;
  registerProvider(providerId: string, patch: ProviderPatch | ProviderAdapter): Disposable;
  unregisterProvider(providerId: string): void;
  readonly log: PluginLogger;
}

/** Executable module contributed by an installed AgentUse plugin package. */
export type AgentUseExtension = (api: AgentUsePluginAPI) => void | Promise<void>;

export interface AgentUsePackageManifest {
  apiVersion: 1;
  extensions: string[];
}

export interface InstalledPluginRecord {
  name: string;
  version: string;
  source: string;
  directory: string;
  /** Local project plugin loaded directly from its working directory. */
  linked?: true;
  scope: 'global' | 'project';
  projectRoot?: string;
  commit?: string;
  ref?: string;
  installedAt: string;
  updatedAt: string;
}
