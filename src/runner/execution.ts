import { streamText, isStepCount, type ModelMessage, type ToolSet } from 'ai';
import { repairSmuggledXmlToolCall } from './tool-call-repair';
import { createHash } from 'crypto';
import type { ParsedAgent } from '../parser';
import { createModel } from '../models';
import { getModelFromRegistry } from '../generated/models';
import { resolveModelProvider, toRegistryKey } from '../utils/model-utils';
import { BUILTIN_PROVIDERS } from '../providers/registry-sources';
import { OPENCODE_GO_PROVIDER_ID } from '../providers/opencode-go';
import { CodexAuth } from '../auth/codex';
import { logger } from '../utils/logger';
import { ContextManager } from '../context-manager';
import { compactMessages } from '../compactor';
import { addLanguageModelUsage } from '../session/usage';
import type { AgentChunk } from './types';
import { isSuspendSignal } from './suspend';
import { wrapToolsWithWAL, sanitizeWALInput, type EffectWAL } from './effect-wal';
import { LeaseStore, isEffectful } from './approval-lease';
import { GateSealStore } from './gate-seal';
import { applyGateDecisionEffects } from './gate-decision';
import { attachCommandToPendingGate, withGatePlanPreflight } from './gate-preflight';
import { isMockMode, resolveMockApprovalDecision, mockGateDecisionResult } from './mock-tools';
import { registerSDKTelemetryOnce } from '../telemetry/sdk-telemetry';
import { recordErrorMarker } from './session-helper';
import { extractApiErrorDetail } from './api-error';
import { toErrorMessage } from '../utils/error-message';
import type { CompactionReason, ModelToolOutputArtifactRef, SessionManager, ToolOutputArtifactRef } from '../session';
import { clampToolResultForModel } from '../tools/tool-output-limits.js';
import { stripInlineMediaData } from '../tools/media.js';
import { messagesContainInlineMedia } from '../session/media-cache.js';
import { stripToolBlocks, hasReasoningParts, lastAssistantMessage } from '../session/message-utils';
import { OUTCOME_NUDGE_PROMPT, shouldRequestOutcome } from './outcome';
import { REPORT_COMPLETE_TOOL } from '../tools/report-outcome.js';
import type { RunOutcome } from '../tools/report-outcome.js';
import { ANTHROPIC_IDENTITY_PROMPT, addAnthropicIdentity } from '../utils/anthropic';
import {
  availableModelCandidates,
  clearModelCooldown,
  isTransientModelError,
  markModelCooldown,
} from './model-fallback';

// Constants
const MAX_RETRIES = 3;
const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' as const };
const OPENAI_CACHE_KEY_PREFIX = 'agentuse';
// Tokens reserved for the visible answer above the extended-thinking budget, so
// max_tokens stays comfortably greater than thinking.budget_tokens.
const ANTHROPIC_THINKING_ANSWER_RESERVE = 8192;
// Default per-response output ceiling for first-class Anthropic models when the
// agent sets no explicit cap. The AI SDK defaults model ids it doesn't recognize
// (anything newer than @ai-sdk/anthropic's hardcoded table, e.g. claude-sonnet-5)
// to a tiny 4096 max_tokens, which silently truncates normal-length outputs and
// tool-call arguments — fatal, since a `length` finish ends the agentic loop. We
// pass the model's real limit from our own registry instead, capped here so an
// unattended run can't emit a runaway single response. 32000 fits any realistic
// single-step write, stays under the 64k `output-128k` beta threshold, and is 8x
// the broken default. Agents that need bigger single outputs set `maxOutputTokens`.
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
// Custom/local OpenAI-compatible gateways expose no reliable output limit, so they
// keep a fixed conservative ceiling (local reasoning models otherwise generate
// unbounded thinking tokens).
const CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS = 16384;

// Resolve the per-response max_tokens to send to the provider. Precedence:
//   1. Explicit `maxOutputTokens` frontmatter — honored, clamped to the model's
//      real ceiling when the registry knows it (avoids provider max_tokens
//      errors). With extended thinking on it is additionally raised to the
//      thinking floor (budget + answer reserve), since max_tokens must exceed
//      the thinking budget.
//   2. Extended thinking without an explicit override — the budget-aware ceiling.
//   3. Custom/local gateway — fixed conservative cap (real limit unknowable),
//      overridable by an explicit agent setting.
//   4. First-class Anthropic model — the model's registry output limit, capped to
//      DEFAULT_MAX_OUTPUT_TOKENS. This is the fix for the SDK's 4096 fallback.
//   5. Everything else (OpenAI/Google, model unknown to the registry) — return
//      undefined so the SDK uses its own (correct, model-max) default.
export function resolveMaxOutputTokens(agent: ParsedAgent): number | undefined {
  const provider = resolveModelProvider(agent.config.model);
  const isCustomProvider =
    !BUILTIN_PROVIDERS.includes(provider) || provider === OPENCODE_GO_PROVIDER_ID;

  const override = agent.config.maxOutputTokens;
  const anthropicThinkingMax =
    provider === 'anthropic' ? resolveAnthropicThinking(agent)?.maxOutputTokens : undefined;
  if (anthropicThinkingMax) {
    if (!override) return anthropicThinkingMax;
    // The documented use of `maxOutputTokens` is "my agent must emit a large
    // single response"; letting the thinking ceiling silently override it would
    // cap the visible answer at budget + reserve no matter what the author set.
    const registryOutput = getModelFromRegistry(toRegistryKey(agent.config.model))?.limit?.output;
    const clamped = registryOutput ? Math.min(override, registryOutput) : override;
    return Math.max(clamped, anthropicThinkingMax);
  }

  if (isCustomProvider) return override ?? CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS;

  const registryOutput = getModelFromRegistry(toRegistryKey(agent.config.model))?.limit?.output;
  if (override) return registryOutput ? Math.min(override, registryOutput) : override;

  if (provider === 'anthropic' && registryOutput && registryOutput > 0) {
    return Math.min(registryOutput, DEFAULT_MAX_OUTPUT_TOKENS);
  }
  return undefined;
}

function isAnthropicModel(model: string): boolean {
  return resolveModelProvider(model) === 'anthropic';
}

function defaultOpenAIPromptCacheKey(agent: ParsedAgent): string {
  const source = `${agent.config.model}:${agent.name}`;
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const slug = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  return [OPENAI_CACHE_KEY_PREFIX, slug || 'agent', hash].join('-');
}

export function openAIOptionsWithCacheDefaults(agent: ParsedAgent): Record<string, unknown> {
  const configured = agent.config.openai ?? {};
  // Reasoning-capable models already generate (and bill) reasoning tokens; ask
  // for an `auto` summary by default so the reasoning is visible in the session
  // trace at ~no extra cost. Gate on the registry's reasoning flag: the
  // Responses API rejects reasoningSummary on non-reasoning models (gpt-4o), and
  // an unknown model is treated as non-reasoning (a broken run is worse than an
  // opt-in-able missing summary). Explicit user config always wins.
  const isReasoningModel = getModelFromRegistry(toRegistryKey(agent.config.model))?.reasoning === true;
  return {
    promptCacheKey: configured.promptCacheKey ?? defaultOpenAIPromptCacheKey(agent),
    ...(isReasoningModel && { reasoningSummary: 'auto' }),
    ...configured,
  };
}

/**
 * Resolve Claude extended-thinking settings from agent config (opt-in). Returns
 * `undefined` when thinking is not configured. When set, `max_tokens` must
 * exceed the budget, so reserve headroom above it for the visible answer and
 * clamp to the model's output limit when known. Pure + exported for testing.
 */
export function resolveAnthropicThinking(
  agent: ParsedAgent
): { budgetTokens: number; maxOutputTokens: number } | undefined {
  const budgetTokens = agent.config.anthropic?.thinking?.budgetTokens;
  if (!budgetTokens) return undefined;
  const maxOutputTokens = Math.max(
    budgetTokens + 1,
    Math.min(
      getModelFromRegistry(toRegistryKey(agent.config.model))?.limit?.output ?? Number.MAX_SAFE_INTEGER,
      budgetTokens + ANTHROPIC_THINKING_ANSWER_RESERVE
    )
  );
  return { budgetTokens, maxOutputTokens };
}

/**
 * Decide how reasoning is configured for a run. The provider-agnostic top-level
 * `reasoning` knob is primary: it becomes the AI SDK's `reasoning` call option,
 * which the provider maps to its own control (Anthropic -> thinking budget as a
 * % of maxOutputTokens, OpenAI -> reasoningEffort). The legacy
 * `anthropic.thinking.budgetTokens` stays as an explicit escape hatch, honored
 * only when `reasoning` is unset (so the two never double-apply). Pure +
 * exported for testing.
 */
export function resolveReasoning(agent: ParsedAgent): {
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  anthropicThinkingBudget?: number;
} {
  const reasoning = agent.config.reasoning;
  if (reasoning) return { reasoning };
  const provider = resolveModelProvider(agent.config.model);
  const anthropicThinkingBudget =
    provider === 'anthropic' ? resolveAnthropicThinking(agent)?.budgetTokens : undefined;
  return anthropicThinkingBudget ? { anthropicThinkingBudget } : {};
}

function withAnthropicCacheControl(providerOptions: any): any {
  return {
    ...providerOptions,
    anthropic: {
      ...(providerOptions?.anthropic ?? {}),
      cacheControl: ANTHROPIC_CACHE_CONTROL,
    },
  };
}

function hasAnthropicCacheControl(providerOptions: any): boolean {
  return Boolean(
    providerOptions?.anthropic?.cacheControl ??
    providerOptions?.anthropic?.cache_control
  );
}

// Remove a message-level Anthropic cacheControl breakpoint, returning
// providerOptions without it (or undefined if nothing else remains). Leaves
// content-part breakpoints alone, they are re-derived by buildUserMessage.
function withoutAnthropicCacheControl(providerOptions: any): any {
  if (!hasAnthropicCacheControl(providerOptions)) return providerOptions;
  const { cacheControl: _c, cache_control: _s, ...restAnthropic } = providerOptions.anthropic;
  const nextProviderOptions = { ...providerOptions };
  if (Object.keys(restAnthropic).length === 0) {
    delete nextProviderOptions.anthropic;
  } else {
    nextProviderOptions.anthropic = restAnthropic;
  }
  return Object.keys(nextProviderOptions).length === 0 ? undefined : nextProviderOptions;
}

// Strip stale message-level breakpoints from the whole history. Stamped
// messages persist across steps (setMessages / snapshots), so without this the
// per-step stampers pile a fresh breakpoint on each new last message while the
// old ones ride along, blowing past Anthropic's 4-breakpoint limit.
function clearAnthropicCacheControlFromMessages(messages: any[]): any[] {
  return messages.map((message) =>
    hasAnthropicCacheControl(message?.providerOptions)
      ? { ...message, providerOptions: withoutAnthropicCacheControl(message.providerOptions) }
      : message
  );
}

function messageHasCacheableContentPart(message: any): boolean {
  return Array.isArray(message?.content) &&
    message.content.some((part: any) => hasAnthropicCacheControl(part?.providerOptions));
}

function buildUserMessage(userMessage: string, cacheableUserMessage: string | undefined): any {
  if (
    !cacheableUserMessage ||
    !userMessage.startsWith(cacheableUserMessage) ||
    userMessage.length === cacheableUserMessage.length
  ) {
    return { role: 'user', content: userMessage };
  }

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: cacheableUserMessage,
        providerOptions: withAnthropicCacheControl(undefined),
      },
      {
        type: 'text',
        text: userMessage.slice(cacheableUserMessage.length),
      },
    ],
  };
}

function applyAnthropicCacheControlToMessages(messages: any[]): any[] {
  let lastSystemIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'system') {
      lastSystemIndex = index;
      break;
    }
  }
  if (lastSystemIndex === -1) return messages;

  return messages.map((message, index) =>
    index === lastSystemIndex
      ? { ...message, providerOptions: withAnthropicCacheControl(message.providerOptions) }
      : message
  );
}

function applyAnthropicCacheControlToLastMessage(messages: any[]): any[] {
  if (messages.length === 0) return messages;

  const lastMessageIndex = messages.length - 1;
  return messages.map((message, index) =>
    index === lastMessageIndex
      ? messageHasCacheableContentPart(message)
        ? message
        : { ...message, providerOptions: withAnthropicCacheControl(message.providerOptions) }
      : message
  );
}

function applyAnthropicCacheControlToStepMessages(messages: any[]): any[] {
  // Clear stale breakpoints first so re-stamping is idempotent, the request
  // then carries exactly the intended breakpoints (system + last message)
  // regardless of how many steps' worth of stamps persisted in history.
  return applyAnthropicCacheControlToLastMessage(
    applyAnthropicCacheControlToMessages(
      clearAnthropicCacheControlFromMessages(messages)
    )
  );
}

function applyAnthropicCacheControlToTools(tools: ToolSet): ToolSet {
  const entries = Object.entries(tools);
  if (entries.length === 0) return tools;

  const lastToolName = entries[entries.length - 1][0];
  return Object.fromEntries(entries.map(([name, tool]) => [
    name,
    name === lastToolName
      ? { ...tool, providerOptions: withAnthropicCacheControl((tool as any).providerOptions) }
      : tool
  ])) as ToolSet;
}

type ToolOutputArtifactWriter = (toolName: string, result: unknown) => Promise<ToolOutputArtifactRef | undefined>;

function modelToolOutputArtifactRef(artifact: ToolOutputArtifactRef): ModelToolOutputArtifactRef {
  return {
    kind: artifact.kind,
    path: artifact.path,
    bytes: artifact.bytes,
    originalChars: artifact.originalChars,
  };
}

function attachToolOutputArtifact(value: unknown, artifact: ToolOutputArtifactRef): unknown {
  const modelArtifact = modelToolOutputArtifactRef(artifact);
  if (typeof value === 'string') {
    return `${value}\n\n[Full tool output saved to session artifact: ${modelArtifact.path} (${modelArtifact.bytes} bytes).]`;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const metadata = objectValue.metadata && typeof objectValue.metadata === 'object' && !Array.isArray(objectValue.metadata)
      ? objectValue.metadata as Record<string, unknown>
      : {};
    return {
      ...objectValue,
      metadata: {
        ...metadata,
        fullOutputArtifact: modelArtifact,
      },
    };
  }

  return {
    value,
    metadata: {
      fullOutputArtifact: modelArtifact,
    },
  };
}

function buildToolOutputArtifactWriter(options: {
  sessionManager?: SessionManager;
  sessionID?: string;
  agentId?: string;
  messageID?: string;
}): ToolOutputArtifactWriter | undefined {
  if (!options.sessionManager || !options.sessionID || !options.agentId || !options.messageID) {
    return undefined;
  }

  return async (toolName, result) => {
    return options.sessionManager!.writeToolOutputArtifact(
      options.sessionID!,
      options.agentId!,
      options.messageID!,
      toolName,
      result
    );
  };
}

function limitModelFacingToolOutputs(tools: ToolSet, writeToolOutputArtifact?: ToolOutputArtifactWriter): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const originalExecute = (tool as any).execute;
    if (typeof originalExecute !== 'function') return [name, tool];

    return [name, {
      ...tool,
      execute: async (...args: unknown[]) => {
        const result = await originalExecute(...args);
        const clamped = clampToolResultForModel(result);
        if (clamped.truncated) {
          logger.debug(`[ToolOutput] Truncated model-facing result for ${name}`);
          if (writeToolOutputArtifact) {
            try {
              const artifact = await writeToolOutputArtifact(name, result);
              if (artifact) {
                return attachToolOutputArtifact(clamped.value, artifact);
              }
            } catch (error) {
              logger.debug(`[ToolOutput] Failed to persist full result for ${name}: ${(error as Error).message}`);
            }
          }
        }
        return clamped.value;
      }
    }];
  })) as ToolSet;
}

function isContextLimitError(error: unknown): boolean {
  const errorMessage = toErrorMessage(error);
  const errorLower = errorMessage.toLowerCase();
  return (
    errorLower.includes('context_length_exceeded') ||
    errorLower.includes('context length') ||
    errorLower.includes('maximum context') ||
    errorLower.includes('token limit') ||
    errorLower.includes('context window') ||
    errorLower.includes('too many tokens')
  );
}

function usageFromStreamChunk(chunk: any): { usage?: any; usageKind?: 'cumulative' | 'step' } {
  const totalUsage = chunk.totalUsage;
  const stepUsage = chunk.usage;
  const usage = totalUsage ?? stepUsage;
  const usageKind = totalUsage ? 'cumulative' : stepUsage ? 'step' : undefined;
  return {
    ...(usage && { usage }),
    ...(usageKind && { usageKind }),
  };
}

/**
 * Core agent execution as an async generator
 */
type ExecuteAgentCoreOptions = {
  userMessage: string;
  cacheableUserMessage?: string | undefined;
  systemMessages: Array<{role: string, content: string}>;
  messages?: ModelMessage[];
  maxSteps: number;
  abortSignal?: AbortSignal;
  subAgentNames?: Set<string>;
  sessionManager?: SessionManager;
  sessionID?: string;
  agentId?: string;
  messageID?: string;
  effectWal?: EffectWAL;
  runOutcome?: RunOutcome;
};

function systemMessagesForModel(
  messages: Array<{ role: string; content: string }>,
  model: string
): Array<{ role: string; content: string }> {
  const providerNeutral = messages.filter((message) => message.content !== ANTHROPIC_IDENTITY_PROMPT);
  return addAnthropicIdentity(providerNeutral, model);
}

function isMeaningfulModelChunk(chunk: AgentChunk): boolean {
  return chunk.type === 'llm-first-token'
    || chunk.type === 'text'
    || chunk.type === 'reasoning'
    || chunk.type === 'tool-call'
    || chunk.type === 'tool-result'
    || chunk.type === 'suspended';
}

async function persistSelectedModel(
  agent: ParsedAgent,
  model: string,
  systemMessages: Array<{ role: string; content: string }>,
  options: ExecuteAgentCoreOptions
): Promise<void> {
  agent.config.model = model;
  if (!options.sessionManager || !options.sessionID || !options.agentId) return;
  try {
    await options.sessionManager.updateSession(options.sessionID, options.agentId, { model });
    if (options.messageID) {
      await options.sessionManager.updateMessage(options.sessionID, options.agentId, options.messageID, {
        assistant: {
          modelID: model,
          providerID: resolveModelProvider(model),
          system: systemMessages.map((message) => message.content),
        },
      });
    }
  } catch (error) {
    logger.debug(`Failed to persist fallback model ${model}: ${toErrorMessage(error)}`);
  }
}

/**
 * Run a fresh session against an ordered model alias. A transient failure may
 * move to the next candidate only before the provider emits output or invokes a
 * tool. Resumes/redos carry messages and therefore stay pinned to one model.
 */
export async function* executeAgentCore(
  agent: ParsedAgent,
  tools: ToolSet,
  options: ExecuteAgentCoreOptions
): AsyncGenerator<AgentChunk> {
  const configured = options.messages
    ? [agent.config.model]
    : (agent.config.modelCandidates ?? [agent.config.model]);
  const candidates = availableModelCandidates(configured);
  const initiallyPreparedModel = agent.config.model;

  for (let index = 0; index < candidates.length; index++) {
    const model = candidates[index]!;
    const attemptSystemMessages = model === initiallyPreparedModel
      ? options.systemMessages
      : systemMessagesForModel(options.systemMessages, model);
    if (model === initiallyPreparedModel) agent.config.model = model;
    else await persistSelectedModel(agent, model, attemptSystemMessages, options);
    const attemptAgent: ParsedAgent = {
      ...agent,
      config: { ...agent.config, model },
    };
    let meaningfulOutput = false;
    let fallbackError: unknown;
    const attempt = executeAgentAttempt(attemptAgent, tools, {
      ...options,
      systemMessages: attemptSystemMessages,
    });

    try {
      for await (const chunk of attempt) {
        if (isMeaningfulModelChunk(chunk)) meaningfulOutput = true;
        if (chunk.type === 'error' && !meaningfulOutput && isTransientModelError(chunk.error)) {
          markModelCooldown(model, agent.config.modelFallbackCooldownMs);
          if (index + 1 < candidates.length) {
            fallbackError = chunk.error;
            break;
          }
          yield chunk;
          return;
        }
        yield chunk;
      }
    } catch (error) {
      if (!meaningfulOutput && isTransientModelError(error)) {
        markModelCooldown(model, agent.config.modelFallbackCooldownMs);
        if (index + 1 < candidates.length) fallbackError = error;
        else throw error;
      } else {
        throw error;
      }
    }

    if (fallbackError !== undefined) {
      logger.warn(
        `Model ${model} failed before producing output; falling back to ${candidates[index + 1]}: ` +
        toErrorMessage(fallbackError)
      );
      continue;
    }

    clearModelCooldown(model);
    return;
  }
}

async function* executeAgentAttempt(
  agent: ParsedAgent,
  tools: ToolSet,
  options: ExecuteAgentCoreOptions
): AsyncGenerator<AgentChunk> {
  // SDK-layer execution witness (debug trace of every tool execute via the
  // v7 telemetry integration). Idempotent; complements the effect WAL.
  registerSDKTelemetryOnce();

  const model = await createModel(agent.config.model);

  // Internal abort: tripped the instant a suspension begins so the AI SDK stops
  // the step loop and in-flight tool executes receive the signal (bash kills its
  // process tree). Without it, the SDK's eagerly-dispatched sibling tool calls
  // keep executing while the gate is pending — the 2026-07-16 ghost posts
  // (agentuse-lab#165). Combined with the caller's signal when one exists.
  const runAbort = new AbortController();
  const effectiveAbortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, runAbort.signal])
    : runAbort.signal;

  // Approval leases (agentuse-lab#165, Phase 2): gated commands declared in
  // `tools.bash.gated` only run when covered by the latest approved await_human
  // changes[]. The store is file-based in the session directory (granted at
  // resume time, possibly by another process) and read per call.
  const effectPatterns = agent.config.tools?.bash?.gated ?? [];
  const leaseStore = new LeaseStore();
  // Gate seal (reject-is-terminal): bound whenever the run has a session, since
  // any approval-enabled agent can carry an await_human gate regardless of
  // whether it also declares gated bash commands.
  const gateSealStore = new GateSealStore();
  if (options.sessionManager && options.sessionID && options.agentId) {
    try {
      const sessionDir = await options.sessionManager.getSessionDirectory(options.sessionID, options.agentId);
      if (effectPatterns.length > 0) leaseStore.bind(sessionDir);
      gateSealStore.bind(sessionDir);
    } catch (error) {
      logger.debug(`[Lease] failed to bind session-dir stores: ${(error as Error).message}`);
    }
  }

  try {
  // Initialize context manager if enabled
  let contextManager: ContextManager | null = null;
  const usesAnthropicCacheControl = isAnthropicModel(agent.config.model);
  const initialMessages: any[] = options.messages ?? [
    ...options.systemMessages,
    usesAnthropicCacheControl
      ? buildUserMessage(options.userMessage, options.cacheableUserMessage)
      : { role: 'user', content: options.userMessage }
  ];
  let messages = usesAnthropicCacheControl
    ? applyAnthropicCacheControlToMessages(initialMessages)
    : initialMessages;
  const streamTools = usesAnthropicCacheControl
    ? applyAnthropicCacheControlToTools(tools)
    : tools;
  // WAL wraps innermost so execute entry/exit is journaled at the effect layer,
  // independent of the stream consumer (which a suspension abandons mid-step).
  const walledTools = options.effectWal
    ? wrapToolsWithWAL(streamTools, options.effectWal)
    : streamTools;
  const modelFacingTools = limitModelFacingToolOutputs(
    walledTools,
    buildToolOutputArtifactWriter(options)
  );

  if (ContextManager.isEnabled()) {
    contextManager = new ContextManager(
      agent.config.model,
      async (messagesToCompact) => compactMessages(messagesToCompact, agent.config.model, options.abortSignal)
    );
    await contextManager.initialize();

    contextManager.setMessages(messages);
  }

  const persistContextSnapshot = async () => {
    if (
      !contextManager?.hasCompacted() ||
      !options.sessionManager ||
      !options.sessionID ||
      !options.agentId
    ) {
      return;
    }

    try {
      const stats = contextManager.getStats();
      await options.sessionManager.writeContextSnapshot(options.sessionID, options.agentId, {
        version: 1,
        updatedAt: stats.updatedAt,
        ...(options.messageID && { messageID: options.messageID }),
        messages: contextManager.getMessages(),
        usage: stats,
      });
    } catch (error) {
      logger.debug(`Failed to persist compacted context: ${(error as Error).message}`);
    }
  };

  // Record a visible session marker when a compaction actually runs, so the
  // event shows up in `agentuse sessions` and the serve web view instead of
  // only the CLI logs.
  const persistCompactionPart = async (
    before: { tokens: number; messages: number; usagePercentage: number },
    reason: CompactionReason,
  ) => {
    if (
      !contextManager ||
      !options.sessionManager ||
      !options.sessionID ||
      !options.agentId ||
      !options.messageID
    ) {
      return;
    }
    try {
      const after = contextManager.getStats();
      await options.sessionManager.addPart(options.sessionID, options.agentId, options.messageID, {
        type: 'compaction',
        reason,
        tokensBefore: before.tokens,
        tokensAfter: after.activeTokens,
        messagesBefore: before.messages,
        messagesAfter: contextManager.getMessages().length,
        ...(Number.isFinite(before.usagePercentage) && { usagePercentBefore: before.usagePercentage }),
        time: { start: Date.now() },
      } as any);
    } catch (error) {
      logger.debug(`Failed to persist compaction marker: ${(error as Error).message}`);
    }
  };

  const compactActiveContext = async (opts: { persist?: boolean; reason?: CompactionReason } = {}): Promise<ModelMessage[]> => {
    if (!contextManager) return messages;
    const before = contextManager.getStats();
    const messagesBefore = contextManager.getMessages().length;
    const compacted = await contextManager.compact(opts.reason);
    messages = usesAnthropicCacheControl
      ? applyAnthropicCacheControlToMessages(compacted as any[])
      : compacted;
    contextManager.setMessages(messages);
    // compact() is a no-op when there is nothing to fold in; only mark a real one.
    if (contextManager.getStats().compactions > before.compactions) {
      await persistCompactionPart(
        { tokens: before.activeTokens, messages: messagesBefore, usagePercentage: before.usagePercentage },
        opts.reason ?? 'limit',
      );
    }
    if (opts.persist !== false) {
      await persistContextSnapshot();
    }
    return messages;
  };

  // Surface a compaction failure in the session log (with the provider's
  // response body, not just "Error"). Best-effort; used by the non-fatal
  // compaction paths where the throw never reaches the run-level catch.
  const recordCompactionFailure = async (error: unknown) => {
    if (!options.sessionManager || !options.sessionID || !options.agentId || !options.messageID) return;
    const apiDetail = extractApiErrorDetail(error);
    await recordErrorMarker(options.sessionManager, options.sessionID, options.agentId, options.messageID, {
      source: 'compaction',
      message: toErrorMessage(error),
      ...(apiDetail?.detail !== undefined && { detail: apiDetail.detail }),
      ...(apiDetail?.statusCode !== undefined && { statusCode: apiDetail.statusCode }),
    });
  };

  const compactAtSuspensionBoundary = async () => {
    if (!contextManager?.shouldCompactAtBoundary()) return;
    try {
      await compactActiveContext({ persist: false, reason: 'approval' });
    } catch (error) {
      logger.warn(`Approval-boundary context compaction failed; suspending with full active context.`);
      logger.debug(`Approval-boundary compaction error: ${(error as Error).message}`);
      // This failure is non-fatal (the run suspends with full context) so it
      // never reaches the run-level catch — surface it in the session log here.
      await recordCompactionFailure(error);
    }
  };

  // `stopWhen` predicate: stop the step loop the moment a step carries a
  // SuspendSignal tool-error. This runs synchronously inside the SDK's own
  // loop, so the next LLM step can never start while our (async) consumer is
  // still dequeuing the suspend chunk — without it, v7 launches step N+1
  // before the drain-side abort lands (agentuse-lab#165).
  const stopOnSuspend = ({ steps }: { steps: Array<{ content?: unknown }> }): boolean => {
    const content = steps[steps.length - 1]?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part: any) => part?.type === 'tool-error' && isSuspendSignal(part.error));
  };

  // `stopWhen` predicate: end the current streamText segment once the provider's
  // real per-step token usage crosses the compaction threshold. We then compact
  // between segments (see the segment loop) so the reduction actually persists,
  // unlike compacting inside prepareStep where the SDK rebuilds the full history
  // every step.
  const stopForCompaction = ({ steps }: { steps: Array<{ usage?: { inputTokens?: number; outputTokens?: number } }> }): boolean => {
    if (!contextManager) return false;
    const last = steps[steps.length - 1];
    const used = (last?.usage?.inputTokens ?? 0) + (last?.usage?.outputTokens ?? 0);
    return used > 0 && used >= contextManager.compactionThresholdTokens();
  };

  // `stopWhen` predicate: end the run the moment report_complete lands. That
  // call IS the final answer, so the step the SDK would otherwise run next has
  // nothing left to say — it costs a full model round-trip (seconds, and the
  // whole context re-sent) to produce either silence or a duplicate of the
  // report. The tool executed before this runs, so its result is still streamed
  // and journaled.
  //
  // Deliberately NOT report_incomplete: that path is told to finish bookkeeping
  // after declaring, so it must keep stepping.
  const stopOnDeliveredOutcome = ({ steps }: { steps: Array<{ content?: unknown }> }): boolean => {
    const content = steps[steps.length - 1]?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part: any) =>
      (part?.type === 'tool-result' || part?.type === 'tool-call') &&
      part?.toolName === REPORT_COMPLETE_TOOL
    );
  };

  // Set once an await_human gate opens in a stream: from that point every sibling
  // tool call in the same turn is barrier-denied (never executed) and the model is
  // told to re-issue after approval. Function-scoped so the tool-call yield sites
  // below can stamp those siblings postSuspend; a resume starts a fresh
  // executeAgentCore, so it never leaks past the suspend.
  let gateBarrierActive = false;
  let gateBarrierCallId: string | undefined;

  // Function to create stream with current messages
  const createStream = async () => {
    // Check if we need to compact before creating stream
    contextManager?.setMessages(messages);
    if (contextManager?.shouldCompact()) {
      try {
        messages = await compactActiveContext();
      } catch (error) {
        // Proactive compaction is best-effort. If the summarizer call fails
        // (e.g. a transient provider error), don't kill the run — proceed with
        // the un-compacted context (compactActiveContext leaves `messages`
        // untouched on throw) and let the provider's real limit be the backstop.
        // A genuine context-length rejection is still caught and retried by
        // createStreamWithCompactionRetry below.
        logger.warn('Pre-stream context compaction failed; continuing with full context.');
        logger.debug(`Pre-stream compaction error: ${(error as Error).message}`);
        await recordCompactionFailure(error);
        contextManager?.setMessages(messages);
      }
    }

    // Extract provider options based on model provider
    const provider = resolveModelProvider(agent.config.model);

    // Reasoning config. The top-level `reasoning` (provider-agnostic) becomes the
    // SDK's `reasoning` param; the legacy `anthropic.thinking.budgetTokens` is
    // used only when `reasoning` is unset (see resolveReasoning).
    const { reasoning, anthropicThinkingBudget } = resolveReasoning(agent);
    if (reasoning) {
      logger.debug(
        reasoning === 'none'
          ? 'Reasoning disabled (reasoning: none).'
          : `Reasoning enabled. Effort at: ${reasoning}`
      );
    } else if (anthropicThinkingBudget) {
      logger.debug(`Reasoning enabled via anthropic.thinking budget: ${anthropicThinkingBudget} tokens.`);
    }
    // Per-response output ceiling. Without this, the AI SDK caps model ids it
    // doesn't recognize (e.g. claude-sonnet-5) at 4096, silently truncating runs.
    const maxOutputTokens = resolveMaxOutputTokens(agent);

    // Only include provider options if they exist and match the model provider
    let providerOptions: any = undefined;
    if (provider === 'openai') {
      const openaiOptions = openAIOptionsWithCacheDefaults(agent);
      // Check if using Codex OAuth (Responses API) vs regular API key (Chat Completions API)
      const codexAccess = await CodexAuth.access();
      if (codexAccess) {
        // Codex OAuth uses Responses API which requires `instructions` field
        const systemMessage = messages.find(m => m.role === 'system');
        const instructions = typeof systemMessage?.content === 'string'
          ? systemMessage.content
          : 'You are a helpful assistant.';

        providerOptions = {
          openai: {
            instructions,
            store: false,
            ...openaiOptions
          }
        };
      } else {
        providerOptions = { openai: openaiOptions };
      }
    } else if (provider === 'anthropic' && anthropicThinkingBudget) {
      // Extended thinking is an explicit opt-in (it bills new output tokens).
      // When enabled, Claude streams its reasoning, which the session trace
      // renders inline. cacheControl is applied per-message elsewhere, so the
      // top-level options carry only the thinking directive.
      providerOptions = { anthropic: { thinking: { type: 'enabled', budgetTokens: anthropicThinkingBudget } } };
    }

    // Cap each segment to the remaining step budget so compaction restarts do
    // not multiply the effective step limit (each streamText call counts steps
    // from zero).
    const remainingSteps = Math.max(1, options.maxSteps - stepCount);
    const streamConfig: any = {
      model,
      messages,
      // Our message pipeline carries system-role messages inside `messages`
      // (fresh runs prepend them; resumed sessions rehydrate them). v7 rejects
      // that by default in favor of `instructions`; keep the legacy behavior.
      allowSystemInMessages: true,
      maxRetries: MAX_RETRIES,
      toolChoice: 'auto' as const,
      // Provider-agnostic reasoning effort -> the SDK maps it to the provider's
      // native control (Anthropic thinking budget / OpenAI reasoningEffort).
      ...(reasoning && { reasoning }),
      stopWhen: contextManager
        ? [isStepCount(remainingSteps), stopForCompaction, stopOnSuspend, stopOnDeliveredOutcome]
        : [isStepCount(remainingSteps), stopOnSuspend, stopOnDeliveredOutcome],
      abortSignal: effectiveAbortSignal,
      // Deterministic fix for the XML-drift failure mode (fields smuggled into
      // neighboring strings as <parameter> markup); anything else falls through
      // to the normal invalid-input -> tool-error -> model-retry path.
      repairToolCall: repairSmuggledXmlToolCall,
      ...(providerOptions && { providerOptions }),
      ...((usesAnthropicCacheControl || contextManager) && {
        prepareStep: async ({ messages: stepMessages }: { messages: ModelMessage[] }) => {
          // Measurement + cache annotation only. Compaction runs BETWEEN
          // streamText calls (the segment loop), because messages returned from
          // prepareStep do not replace the SDK's accumulated history, so
          // compacting here re-summarizes every step without ever shrinking the
          // real conversation.
          if (contextManager) {
            contextManager.setMessages(stepMessages as any[]);
            await persistContextSnapshot();
          }

          return {
            messages: usesAnthropicCacheControl
              ? applyAnthropicCacheControlToStepMessages(stepMessages as any[])
              : stepMessages
          };
        }
      }),
      // Resolved from our own model registry (with thinking/custom/override
      // precedence), so a stale SDK model table can't silently cap us at 4096.
      ...(maxOutputTokens && { maxOutputTokens }),
    };

    // Lease enforcement (agentuse-lab#165, Phase 2) + gate-rides-alone barrier
    // (agentuse-lab#169/#182). The SDK consults this synchronously and in STREAM
    // ORDER before any tool in the step is dispatched (executeToolsFromStream
    // queues nothing until model-call-end). Three guarantees ride on that:
    //   1. an uncovered effectful command can never run beside a pending gate
    //      (lease coverage, order-independent), and
    //   2. a gated command streaming AFTER a plain await_human gate is attached
    //      to that gate's final payload, then denied until the reviewer approves,
    //   3. EVERY other sibling that streams in AFTER an await_human gate in the
    //      same step is denied (gate-first order only).
    // A generic (all-tools) approval fn is safe: no tool defines its own
    // needsApproval, so nothing is being overridden by taking sole authority.
    const toolsForStream: ToolSet = { ...modelFacingTools };
    const awaitHumanPresent = !!(toolsForStream as any).await_human;
    if (awaitHumanPresent || effectPatterns.length > 0) {
      // Barrier state, scoped to this streamText. Real gates suspend and end the
      // stream. Machine preflight/verify decisions and mocked gates resolve
      // inline, so the outer preflight wrapper explicitly clears this state
      // before the SDK starts the next step.
      let gatePendingThisStep = false;
      let pendingGateInput: Record<string, unknown> | undefined;
      let pendingMockDecision: ReturnType<typeof mockGateDecisionResult> | undefined;

      const clearInlineGateState = (result: unknown) => {
        gatePendingThisStep = false;
        pendingGateInput = undefined;
        pendingMockDecision = undefined;
        gateBarrierActive = false;
        gateBarrierCallId = undefined;
        if (
          result
          && typeof result === 'object'
          && (result as Record<string, unknown>).source === 'gate-preflight'
        ) {
          // Mock approval effects are applied from toolApproval so a later step
          // can use the lease. If final-payload validation rejects inline, undo
          // that provisional grant.
          leaseStore.revoke();
        }
      };

      if ((toolsForStream as any).await_human) {
        (toolsForStream as any).await_human = withGatePlanPreflight(
          (toolsForStream as any).await_human,
          { effectPatterns, onInlineResolution: clearInlineGateState },
        );
      }

      streamConfig.toolApproval = (opts: { toolCall: { toolName: string; toolCallId?: string; input?: any } }) => {
        const { toolName, toolCallId: callId, input } = opts.toolCall;

        // The gate itself: mark the step gated, then run and suspend. Returning
        // undefined (not-applicable) lets await_human execute normally.
        if (toolName === 'await_human') {
          // Reject is terminal (runtime guarantee): once a human rejected a
          // prior gate this run, the gate is sealed. Deny any further
          // await_human PRE-dispatch so it never re-suspends / re-asks the human
          // (and never runs the verify pre-review). The run may still finish its
          // own cleanup; it just cannot gate again. `comment` does not seal, so
          // the revise-and-re-gate path is unaffected. See gate-seal.ts.
          if (gateSealStore.isSealed()) {
            options.effectWal?.append({
              event: 'gate-sealed-denied',
              ...(callId && { callId }),
              tool: 'await_human',
            });
            return {
              type: 'denied' as const,
              reason: 'The human reviewer REJECTED this request, which is terminal: the approval gate is closed for this run. Do not call await_human again. Perform any required cleanup (for example status updates) and end the run with a short summary of the rejection. (A reviewer who wanted changes rather than a stop would have used Comment, not Reject.)',
            };
          }
          gatePendingThisStep = true;
          pendingGateInput = input && typeof input === 'object'
            ? input as Record<string, unknown>
            : undefined;
          gateBarrierActive = true;
          gateBarrierCallId = callId;

          // Mocked approval (--mock-approval): the gate resolves inline with a
          // deterministic decision instead of suspending. Apply the decision's
          // durable side effects HERE, pre-dispatch (the mocked execute only
          // returns the payload the model sees), so the next step observes the
          // same lease a real resume would grant. If a later call in this step
          // auto-attaches a command, the effectful branch below re-applies the
          // same decision to the final payload. The outer wrapper clears barrier
          // state when the inline mocked gate finishes.
          if (isMockMode() && resolveMockApprovalDecision()) {
            const decision = mockGateDecisionResult(input, {
              ...(callId && { callId }),
              ...(options.sessionID && { runKey: options.sessionID }),
            });
            pendingMockDecision = decision;
            applyGateDecisionEffects({
              leaseStore,
              gateSealStore,
              status: decision.status,
              choice: decision.choice,
              gateInput: input,
              now: Date.now(),
              sealReason: 'mock reviewer rejected the gate (--mock-approval reject)',
            });
            options.effectWal?.append({
              event: 'mock-gate-decision',
              ...(callId && { callId }),
              tool: 'await_human',
              status: decision.status,
            });
            return undefined;
          }
          return undefined;
        }

        // Effectful bash is governed by the lease regardless of gate state:
        // a command beside a gate is attached then denied; otherwise a consumed
        // lease entry runs and every uncovered/reused command is denied.
        if (toolName === 'tools__bash') {
          const command = typeof input?.command === 'string' ? input.command : '';
          if (command && isEffectful(command, effectPatterns)) {
            if (gatePendingThisStep) {
              const attached = pendingGateInput
                ? attachCommandToPendingGate(pendingGateInput, command)
                : false;
              if (attached && pendingMockDecision) {
                // The mock decision was provisionally applied when the gate
                // streamed. Re-grant from the final, auto-attached payload.
                applyGateDecisionEffects({
                  leaseStore,
                  gateSealStore,
                  status: pendingMockDecision.status,
                  choice: pendingMockDecision.choice,
                  gateInput: pendingGateInput,
                  now: Date.now(),
                  sealReason: 'mock reviewer rejected the gate (--mock-approval reject)',
                });
              }
              options.effectWal?.append({
                event: attached ? 'gate-command-attached' : 'gate-barrier-denied',
                ...(callId && { callId }),
                tool: 'tools__bash',
                command: sanitizeWALInput(command),
              });
              return {
                type: 'denied' as const,
                reason: attached
                  ? 'This gated command was attached to the pending human approval request and was NOT executed. Wait for the approval result. If approved, re-issue this exact command once in a later step; do not open a second gate.'
                  : 'A human approval gate is open in this step, so this gated command was NOT executed. It was not auto-attached because the gate is an option-selection request or already describes the command. Wait for the decision, then issue only the selected and approved command in a later step.',
              };
            }

            const leaseDecision = leaseStore.consume(command);
            if (leaseDecision === 'approved') {
              options.effectWal?.append({
                event: 'lease-approved',
                ...(callId && { callId }),
                tool: 'tools__bash',
                command: sanitizeWALInput(command),
              });
              return 'approved';
            }
            options.effectWal?.append({
              event: 'lease-denied',
              ...(callId && { callId }),
              tool: 'tools__bash',
              command: sanitizeWALInput(command),
              reason: leaseDecision,
            });
            return {
              type: 'denied' as const,
              reason: leaseDecision === 'already-used'
                ? 'This gated command was approved previously, but that one-shot approval has already been used. It will NOT run again. If another execution is genuinely required, request a new human approval that lists the command again.'
                : leaseDecision === 'persistence-error'
                  ? 'This gated command was approved, but AgentUse could not persist one-shot consumption, so it was denied before execution. Do not retry automatically; report the approval-state storage failure.'
                  : 'This command is gated and is not covered by an approved plan. Do NOT retry or reword it. Call await_human with the full plan and emit this exact gated command alongside the gate so the runtime can attach it. The command will remain blocked until the reviewer approves. On option-selection gates, put one complete command per changes[] entry and bind each with optionId.',
            };
          }
        }

        // Gate-rides-alone barrier for siblings not handled by gated-command
        // attachment above. Deny pre-dispatch so nothing runs beside a pending
        // gate; the model re-issues after approval. Deterministic for the
        // gate-first stream order only; the reverse order is covered by the
        // lease (gated commands) and the suspend-drain abort, not here.
        if (gatePendingThisStep) {
          const command = typeof input?.command === 'string' ? input.command : undefined;
          options.effectWal?.append({
            event: 'gate-barrier-denied',
            ...(callId && { callId }),
            tool: toolName,
            ...(command !== undefined
              ? { command: sanitizeWALInput(command) }
              : { input: sanitizeWALInput(input) }),
          });
          return {
            type: 'denied' as const,
            reason: 'A human approval gate (await_human) is open in this step, so this non-gated sibling tool call was not run. Only an exact tools.bash.gated command may be emitted alongside a plain gate for automatic attachment. Wait for the approval result, then issue this call in a later step.',
          };
        }

        return undefined;
      };
    }

    // Add the per-stream wrapped toolset after approval/barrier state exists.
    if (Object.keys(toolsForStream).length > 0) {
      streamConfig.tools = toolsForStream;
    }

    return streamText(streamConfig);
  };

  const createStreamWithCompactionRetry = async () => {
    try {
      return await createStream();
    } catch (error) {
      if (!isContextLimitError(error) || !contextManager) {
        throw error;
      }

      const before = contextManager.getMessages();
      const compacted = await compactActiveContext();
      if (compacted.length === before.length) {
        throw error;
      }
      logger.warn('Context limit hit while creating stream; compacted context and retrying once.');
      return await createStream();
    }
  };

  // Declare timing variables before use
  let accumulatedText = '';
  const toolStartTimes = new Map<string, number>();
  // Every tool call the model emitted in the CURRENT segment (cleared per
  // segment), for the suspension WAL record: this is the raw in-flight
  // assistant turn that the stripped resume snapshot does not keep. `resolved`
  // flips when the call's result/error lands.
  const segmentToolCalls = new Map<string, { tool: string; input: unknown; resolved: boolean }>();
  let lastToolCall: { id: string; name?: string } | null = null;
  let llmGenerationStartTime: number | undefined;
  let llmFirstTokenTime: number | undefined;
  let currentModelStepStartedAt: number | undefined;
  const currentLlmModel = agent.config.model;
  let stepCount = 0; // Track step count to detect when we're approaching limit

  // `suspendedToolCallId` is the gate call we are suspending on; its blocks are
  // trimmed so the snapshot holds only settled context and the resolved part is
  // the single source of truth on resume. A tool that throws SuspendSignal is
  // recorded by the AI SDK as a synthetic "Agent execution suspended" tool-result
  // that a racing prepareStep can fold into the active messages just before we
  // suspend; persisting it makes the gate look resolved-with-a-stale-error and
  // collides with the re-appended resolved part on resume (see stripToolBlocks).
  const buildContextSnapshot = (suspendedToolCallId?: string) => {
    if (!contextManager) return undefined;
    const updatedAt = currentModelStepStartedAt ?? Date.now();
    const usage = { ...contextManager.getStats(), updatedAt };
    const raw = contextManager.getMessages();
    let messages = raw;
    if (suspendedToolCallId) {
      // If the suspended turn carries signed Anthropic thinking blocks, its
      // content must survive verbatim to resume (any edit to a thinking-bearing
      // assistant turn is rejected). Strip only the stale synthetic "suspended"
      // tool-RESULT, never the tool-CALL, which lives in that signed turn; the
      // reasoning-safe rehydrate path re-attaches the real resolved result.
      // Non-reasoning turns keep the original full strip.
      const last = lastAssistantMessage(raw);
      const preserveSignedTurn = last ? hasReasoningParts(last) : false;
      messages = stripToolBlocks(raw, new Set([suspendedToolCallId]), { resultsOnly: preserveSignedTurn });
    }
    return {
      version: 1 as const,
      updatedAt,
      ...(options.messageID && { messageID: options.messageID }),
      messages,
      usage,
    };
  };

  // Segment loop: one streamText call per iteration. Compaction runs BETWEEN
  // iterations (at the end of the loop) so the reduced history actually persists
  // into the next call. Compacting inside a single streamText (via prepareStep)
  // cannot persist — the SDK rebuilds the full history every step — which made
  // compaction re-fire every step. `priorSegmentsUsage` carries cumulative token
  // usage across segments so the consumer's cumulative-replace stays correct.
  let priorSegmentsUsage: any;
  let runAnotherSegment = true;
  // One outcome nudge per run (see the nudge block at the end of the loop).
  let outcomeNudgeSpent = false;
  // Whether the run has produced any visible prose yet, and whether prose from
  // here on is redundant (set only when the nudge fires on top of an existing
  // report). See the text-delta case.
  let sawText = false;
  let suppressTextAfterNudge = false;
  while (runAnotherSegment) {
  runAnotherSegment = false;
  let segmentFinishReason: string | undefined;
  segmentToolCalls.clear();

  let stream;
  try {
    // Track when we start the LLM generation
    llmGenerationStartTime = Date.now();
    currentModelStepStartedAt = llmGenerationStartTime;
    yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };

    stream = await createStreamWithCompactionRetry();
  } catch (error: any) {
    // Handle initial stream creation errors
    const errorMessage = toErrorMessage(error);

    // Check for token limit errors
    if (isContextLimitError(error)) {
      // Check if this is initial failure (no tool calls yet) vs mid-conversation
      const isInitialFailure = stepCount === 0;

      logger.error(isInitialFailure ? `
⚠️  INITIAL PROMPT TOO LARGE

Your initial prompt exceeds the model's context limit.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Reduce the size of your initial prompt/instructions
- Use a model with a larger context window (e.g., claude-sonnet-4-20250514)
- Split your task into multiple sequential steps

Error: ${errorMessage}` : `
⚠️  CONTEXT LIMIT EXCEEDED

The conversation history has grown too large for the model.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Lower the compaction threshold: COMPACTION_THRESHOLD=0.6 (current: 0.7)
- Keep fewer recent messages: COMPACTION_KEEP_RECENT=2 (current: 3)
- Use a model with a larger context window

Error: ${errorMessage}`);
    } else {
      logger.error('Failed to create stream:', error);
    }

    yield { type: 'error', error };
    return;
  }

  // What was actually sent this segment (createStream may compact pre-stream).
  const segmentInput = messages;

  // Suspension capture: when a gate registers we do NOT abandon the stream.
  // We abort the SDK (no further steps; in-flight effect executes get the
  // signal) and keep draining, so every already-dispatched sibling tool call is
  // journaled before 'suspended' is finally yielded. Returning immediately here
  // is what made the 2026-07-16 ghost posts invisible (agentuse-lab#165).
  let suspendState: { toolName?: string; toolCallId?: string; payload: unknown } | undefined;
  const DRAIN_CHUNK_TIMEOUT_MS = 10_000;
  const iterator = (stream.stream as AsyncIterable<any>)[Symbol.asyncIterator]();
  // While draining, never let a hung in-flight tool block the gate from
  // surfacing: bound the wait for each remaining chunk.
  const nextChunk = async (): Promise<IteratorResult<any> | 'drain-timeout'> => {
    if (!suspendState) return iterator.next();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'drain-timeout'>((resolve) => {
      timer = setTimeout(() => resolve('drain-timeout'), DRAIN_CHUNK_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([iterator.next(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    while (true) {
      const iteration = await nextChunk();
      if (iteration === 'drain-timeout') {
        logger.warn('Suspension drain timed out waiting for in-flight tool calls; suspending now (unresolved calls are in the effect WAL).');
        break;
      }
      if (iteration.done) break;
      const chunk = iteration.value;
      switch (chunk.type) {
        case 'tool-call': {
          stepCount++; // Each tool call counts as a step

          // Warn when approaching step limit
          if (stepCount >= options.maxSteps * 0.9 && stepCount < options.maxSteps) {
            logger.warn(`⚠️  Approaching step limit: ${stepCount}/${options.maxSteps} steps used`);
          } else if (stepCount >= options.maxSteps) {
            logger.warn(`⚠️  Step limit reached: ${stepCount}/${options.maxSteps} steps. Generation may be incomplete.`);
          }

          // Complete the current LLM generation segment before tool call
          if (llmGenerationStartTime) {
            const llmDuration = Date.now() - llmGenerationStartTime;
            // Emit a finish event for the LLM segment
            yield {
              type: 'finish',
              finishReason: 'tool-call' as any,
              toolStartTime: llmGenerationStartTime,
              toolDuration: llmDuration
            };
            llmGenerationStartTime = undefined;
            llmFirstTokenTime = undefined;
          }

          const startTime = Date.now();
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          toolStartTimes.set(toolCallId, startTime);
          lastToolCall = { id: toolCallId, name: chunk.toolName };
          segmentToolCalls.set(toolCallId, {
            tool: chunk.toolName ?? 'unknown',
            input: (chunk as any).input || (chunk as any).args,
            resolved: false,
          });

          yield {
            type: 'tool-call',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolInput: (chunk as any).input || (chunk as any).args,
            toolStartTime: startTime,
            ...(options.subAgentNames?.has(chunk.toolName!) && { isSubAgent: true }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };
          break;
        }

        case 'tool-result': {
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;
          const seenCall = segmentToolCalls.get(toolCallId);
          if (seenCall) seenCall.resolved = true;

          // Normalize ambiguous string results once so every projection agrees
          // on whether this lifecycle completed or failed.
          const toolResultStr = parseToolResult(chunk);
          const toolSuccess = !isSoftToolError(chunk, toolResultStr);

          // Note: we intentionally do NOT add the tool result to contextManager
          // here. `prepareStep` (createStream) is the single source of truth for
          // the active context: it calls contextManager.setMessages() with the
          // SDK's canonical, schema-valid step messages at the start of every
          // step. Adding the result here too created two racing writers — and
          // this one used a bare-string `output` (invalid per the AI SDK v5
          // ModelMessage schema) rather than the `{ type, value }` ToolResultOutput
          // form. When the bare-string add landed after prepareStep's setMessages
          // (e.g. just before a suspension), the persisted context snapshot ended
          // up with a duplicate, schema-invalid tool-result, which then failed
          // validation on resume ("messages do not match the ModelMessage[]
          // schema"). contextManager always has a prepareStep (see createStream's
          // condition), so dropping this redundant add is safe.

          yield {
            type: 'tool-result',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolResult: toolResultStr,
            toolSuccess,
            // Strip any inline base64 media before this raw value is persisted to
            // the session store / traces (stream.ts). stripInlineMediaData returns
            // a copy, so the AI SDK's own reference (used by toModelOutput to send
            // the real bytes to the model) keeps its data.
            toolResultRaw: stripInlineMediaData((chunk as any).result || (chunk as any).output),
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };

          // Clean up
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }

          // No new LLM segment starts while a suspension is draining: the SDK
          // is aborted and the run ends at the gate.
          if (suspendState) break;

          // Start tracking new LLM generation segment after tool result
          llmGenerationStartTime = Date.now();
          currentModelStepStartedAt = llmGenerationStartTime;
          llmFirstTokenTime = undefined;
          yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };
          break;
        }

        case 'tool-error': {
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;
          const chunkError = (chunk as any).error;
          const seenErroredCall = segmentToolCalls.get(toolCallId);
          if (seenErroredCall) seenErroredCall.resolved = true;

          if (isSuspendSignal(chunkError)) {
            if (!suspendState) {
              suspendState = {
                ...(chunk.toolName && { toolName: chunk.toolName }),
                ...(toolCallId && { toolCallId }),
                payload: chunkError.payload,
              };
              // Stop the SDK's step loop and hand the signal to in-flight
              // executes (bash kills its process tree). Then keep draining —
              // the suspension is finalized after the stream closes.
              runAbort.abort();
              options.effectWal?.append({
                event: 'gate-registered',
                ...(toolCallId && { callId: toolCallId }),
                ...(chunk.toolName && { tool: chunk.toolName }),
              });
            } else {
              logger.debug('Second suspend signal while draining; keeping the first gate.');
            }
            break;
          }

          // Pass tool errors as structured results to let AI decide on retry.
          // Unwrap retry/cause wrappers first: a tool whose execute makes its
          // own LLM call (e.g. `--mock`) surfaces an AI SDK RetryError whose
          // message collapses to "Failed after 3 attempts. Last error: Error",
          // hiding the provider's real status + reason. Recover them so the
          // session log is diagnosable.
          const apiDetail = extractApiErrorDetail(chunkError);
          const baseMessage =
            (typeof chunkError?.message === 'string' && chunkError.message) ||
            (typeof chunkError === 'string' ? chunkError : '') ||
            apiDetail?.message ||
            'Unknown error';
          const errorMessage = apiDetail
            ? [
                apiDetail.statusCode !== undefined ? `[${apiDetail.statusCode}]` : '',
                baseMessage,
                apiDetail.detail ? `:: ${apiDetail.detail}` : '',
              ]
                .filter(Boolean)
                .join(' ')
            : baseMessage;
          yield {
            type: 'tool-result',  // Treat as result so AI sees it
            toolCallId,  // Include toolCallId so session storage can match and update the pending tool call
            toolName: chunk.toolName,
            toolResult: JSON.stringify({
              success: false,
              error: {
                type: classifyError(errorMessage),
                message: errorMessage,
                retryable: isRetryable(errorMessage),
                suggestions: getSuggestions(errorMessage)
              }
            }),
            toolResultRaw: { error: errorMessage },
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };

          // Clean up
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }
          break;
        }

        case 'text-delta':
          const textContent = (chunk as any).text || (chunk as any).textDelta || (chunk as any).delta || (chunk as any).content;
          if (textContent && typeof textContent === 'string') {
            // Drop prose written in the nudge segment. The consumer ACCUMULATES
            // text across segments, and a model asked only for its outcome tool
            // routinely re-emits the whole report anyway — which would ship the
            // reader two copies. The report we already have is the deliverable;
            // the nudge exists solely to recover the structured verdict. Only
            // engaged once earlier text exists, so a run whose first segment was
            // silent can still speak.
            if (suppressTextAfterNudge) break;
            // Track time to first token
            if (!llmFirstTokenTime && llmGenerationStartTime) {
              llmFirstTokenTime = Date.now();
              yield { type: 'llm-first-token', llmFirstTokenTime };
            }
            accumulatedText += textContent;
            if (textContent.trim()) sawText = true;
            yield { type: 'text', text: textContent };
          }
          break;

        // Reasoning (extended thinking) stream. The provider emits these before
        // the visible answer and tool calls; we surface them as 'reasoning'
        // events so the session trace can render the model's "why" inline
        // instead of dropping it as unknown-chunk debug noise. Grouped by `id`:
        // deltas sharing an id form one reasoning block.
        case 'reasoning-start':
          // Boundary marker only — the part is created lazily on first delta.
          break;

        case 'reasoning-delta': {
          const reasoningText = (chunk as any).text ?? (chunk as any).delta;
          if (reasoningText && typeof reasoningText === 'string') {
            // Reasoning is genuinely the model's first output token, so count
            // it toward time-to-first-token if text hasn't started yet.
            if (!llmFirstTokenTime && llmGenerationStartTime) {
              llmFirstTokenTime = Date.now();
              yield { type: 'llm-first-token', llmFirstTokenTime };
            }
            yield { type: 'reasoning', reasoningId: (chunk as any).id, text: reasoningText };
          }
          break;
        }

        case 'reasoning-end':
          yield { type: 'reasoning', reasoningId: (chunk as any).id, reasoningDone: true };
          break;

        case 'finish':
          segmentFinishReason = chunk.finishReason;
          // Track the assistant's message
          if (contextManager && accumulatedText) {
            const assistantMessage: any = {
              role: 'assistant',
              content: accumulatedText
            };
            contextManager.addMessage(assistantMessage);
            accumulatedText = '';
          }

          // AI SDK semantics: totalUsage is cumulative across all steps;
          // usage is only this finish step. Preserve that distinction so
          // session persistence can avoid double-counting fallback providers.
          const { usage, usageKind } = usageFromStreamChunk(chunk);
          if (contextManager && usage) {
            contextManager.updateUsage(usage, usageKind);
          }
          // A segment's finish carries cumulative usage for THAT streamText call.
          // Offset by prior segments so the consumer's cumulative-replace yields a
          // correct cross-run total rather than just the last segment's.
          const emittedUsage = usage && usageKind === 'cumulative'
            ? addLanguageModelUsage(priorSegmentsUsage, usage)
            : usage;
          if (emittedUsage && usageKind === 'cumulative') {
            priorSegmentsUsage = emittedUsage;
          }

          // Log finish reason for debugging and warnings (suppressed while a
          // suspension drains: the abort-shaped finish is expected then).
          const finishReason = suspendState ? undefined : chunk.finishReason;
          if (finishReason === 'length') {
            logger.warn(`
⚠️  OUTPUT LENGTH LIMIT REACHED

The model reached its maximum output token limit. The response was truncated.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Use a model with a larger output limit
- Ask the agent to be more concise in its responses

Current step: ${stepCount}/${options.maxSteps}`);
          } else if (finishReason === 'content-filter') {
            logger.warn(`⚠️  Content filter triggered. Response may be incomplete.`);
          } else if (finishReason === 'error') {
            logger.warn(`⚠️  Generation stopped due to an error.`);
          }
          // Note: We can't directly detect step limit from finishReason, as AI SDK uses 'stop'

          // Complete final LLM segment if exists
          if (llmGenerationStartTime) {
            const llmDuration = Date.now() - llmGenerationStartTime;
            yield {
              type: 'finish',
              finishReason: chunk.finishReason,
              usage: emittedUsage,
              ...(usageKind && { usageKind }),
              ...(contextManager && { contextUsage: contextManager.getStats() }),
              toolStartTime: llmGenerationStartTime,
              toolDuration: llmDuration
            };
            llmGenerationStartTime = undefined;
            llmFirstTokenTime = undefined;
          } else {
            yield {
              type: 'finish',
              finishReason: chunk.finishReason,
              usage: emittedUsage,
              ...(usageKind && { usageKind }),
              ...(contextManager && { contextUsage: contextManager.getStats() })
            };
          }

          // We can't directly detect step limit from finishReason alone
          // since AI SDK just reports 'stop' when stepCountIs condition is met
          // But we can check our step count
          if (stepCount >= options.maxSteps && chunk.finishReason === 'stop') {
            logger.warn(`
⚠️  Agent stopped at step limit (${options.maxSteps} steps).
   To increase the limit, set MAX_STEPS environment variable:
   MAX_STEPS=2000 agentuse run <agent-file>`);
          }
          break;

        case 'error':
          if (suspendState) {
            // A consequence of our own drain abort; the suspension still surfaces.
            logger.debug(`Stream error during suspension drain (swallowed): ${toErrorMessage(chunk.error)}`);
            break;
          }
          yield { type: 'error', error: chunk.error };
          break;

        case 'abort':
          if (suspendState) {
            // Our own runAbort shutting the step loop down — expected during drain.
            logger.debug('Stream aborted during suspension drain (expected).');
            break;
          }
          logger.warn(`⚠️  Stream aborted - likely due to timeout or cancellation (${stepCount} steps completed)`);
          // Create an AbortError to properly signal timeout
          const abortError = new Error('Stream aborted - execution timeout or manual cancellation');
          abortError.name = 'AbortError';
          yield { type: 'error', error: abortError };
          return;

        // Handle other AI SDK chunk types that we don't need to process but shouldn't warn about
        case 'finish-step': {
          const { usage, usageKind } = usageFromStreamChunk(chunk);
          if (contextManager && usage) {
            contextManager.updateUsage(usage, usageKind);
          }
          if (usage || contextManager) {
            yield {
              type: 'usage',
              ...(usage && { usage }),
              ...(usageKind && { usageKind }),
              ...(contextManager && { contextUsage: contextManager.getStats() }),
            };
          }
          break;
        }
        case 'tool-approval-response':
        case 'tool-output-denied': {
          // Lease enforcement blocked an effectful call before execute ran
          // (agentuse-lab#165, Phase 2). The v7 stream carries the outcome as a
          // 'tool-approval-response' with approved:false (plus the redirect
          // reason); journal it as a failed tool result so the session shows
          // what was attempted. Approved responses need no journaling - the
          // normal tool-call/-result path covers the execution itself.
          if (chunk.type === 'tool-approval-response' && (chunk as any).approved !== false) break;
          const toolCall = (chunk as any).toolCall ?? chunk;
          const toolCallId = toolCall.toolCallId || (chunk as any).toolCallId || 'unknown';
          const toolName = toolCall.toolName || (chunk as any).toolName;
          const reason = typeof (chunk as any).reason === 'string'
            ? (chunk as any).reason
            : 'Execution denied: effectful command not covered by an approved plan (await_human re-gate required).';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;
          const deniedCall = segmentToolCalls.get(toolCallId);
          if (deniedCall) deniedCall.resolved = true;
          yield {
            type: 'tool-result',
            toolName,
            toolCallId,
            toolResult: JSON.stringify({ success: false, denied: true, error: reason }),
            toolResultRaw: { denied: true, reason },
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }
          break;
        }

        case 'start':
        case 'start-step':
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
        case 'tool-approval-request':
        case 'text-start':
        case 'text-end':
          // AI SDK streaming events for text generation boundaries (not tool-related)
          // These indicate when the LLM starts/stops generating text content.
          // tool-approval-request precedes the lease toolApproval decision; the
          // outcome is journaled via the denied tool-approval-response above or
          // the normal tool-call/-result path. Safe to ignore.
          break;

        default:
          logger.debug(`[STREAM] Unknown chunk type received: ${chunk.type}`);
          break;
      }
    }

    // A gate registered during this segment: finalize the suspension now that
    // the stream is fully drained (or the drain timed out). Every sibling tool
    // call the model emitted alongside the gate has been yielded (journaled by
    // the consumer) and recorded in the effect WAL by this point.
    if (suspendState) {
      const turnToolCalls = [...segmentToolCalls.entries()].map(([id, call]) => ({
        callId: id,
        tool: call.tool,
        input: sanitizeWALInput(call.input),
        resolved: call.resolved,
      }));
      const unresolvedCallIds = turnToolCalls
        .filter((call) => !call.resolved && call.callId !== suspendState!.toolCallId)
        .map((call) => call.callId);
      options.effectWal?.append({
        event: 'suspended',
        ...(suspendState.toolCallId && { gateCallId: suspendState.toolCallId }),
        ...(suspendState.toolName && { gateTool: suspendState.toolName }),
        // The raw in-flight assistant turn (the stripped resume snapshot drops
        // the gate's blocks; this record keeps what the model actually emitted).
        turnToolCalls,
        ...(unresolvedCallIds.length > 0 && { unresolvedCallIds }),
        ...(accumulatedText && { text: accumulatedText.slice(0, 8000) }),
      });
      // A new gate supersedes any previously approved plan: revoke the active
      // lease so nothing effectful can run until this gate is approved.
      leaseStore.revoke();
      await compactAtSuspensionBoundary();
      const contextSnapshot = buildContextSnapshot(suspendState.toolCallId);
      yield {
        type: 'suspended',
        ...(suspendState.toolName && { toolName: suspendState.toolName }),
        ...(suspendState.toolCallId && { toolCallId: suspendState.toolCallId }),
        ...(suspendState.toolCallId && { suspend: { toolCallId: suspendState.toolCallId } }),
        toolResultRaw: suspendState.payload,
        ...(contextSnapshot && {
          contextUsage: contextSnapshot.usage,
          contextSnapshot,
        })
      };
      return;
    }

    // Segment ended cleanly. Reconstruct the full conversation (what we sent
    // plus everything the model generated) and, if we are over the threshold
    // with a pending tool follow-up, compact and run another segment. Compaction
    // here persists because the next streamText call is built from `messages`.
    if (contextManager) {
      try {
        const segmentResponse: any = await stream.response;
        messages = [...segmentInput, ...((segmentResponse?.messages as any[]) ?? [])];
        contextManager.setMessages(messages);
        if (
          segmentFinishReason === 'tool-calls' &&
          stepCount < options.maxSteps &&
          contextManager.shouldCompact()
        ) {
          const compactionsBefore = contextManager.getStats().compactions;
          try {
            messages = await compactActiveContext({ reason: 'limit' }) as any[];
            // Only restart if compaction actually reduced the context. If it
            // no-ops (nothing left to fold), restarting would spin forever; let
            // the run end and the next createStream's hard-limit retry cope.
            runAnotherSegment = contextManager.getStats().compactions > compactionsBefore;
          } catch (compactionError) {
            // Compaction failed (e.g. a transient summarizer error). The segment
            // was cut short by stopForCompaction with tool work still pending, so
            // stopping here would silently truncate the run AND report it as a
            // clean completion (the exact "agent never called the subagent" +
            // "status: completed" failure). Surface the failure and continue with
            // the un-compacted context — the provider's real limit is the
            // backstop, and a genuine overflow is caught + retried in
            // createStreamWithCompactionRetry.
            logger.warn('Between-segment context compaction failed; continuing with full context.');
            logger.debug(`Between-segment compaction error: ${(compactionError as Error).message}`);
            await recordCompactionFailure(compactionError);
            messages = contextManager.getMessages();
            runAnotherSegment = true;
          }
        }
      } catch (reconcileError) {
        logger.debug(`Segment compaction check failed: ${(reconcileError as Error).message}`);
      }
    }

    // Outcome nudge. The model finished its turn without declaring an outcome,
    // so ask once and run one more segment. Worth the extra step because a tool
    // is re-presented on every step while a system-prompt rule competes with the
    // whole agent body; a single explicit ask recovers the verdict. Skipped when
    // compaction already scheduled a segment (that one will re-check on its own
    // clean finish) and capped at one ask per run so a model that simply refuses
    // cannot spin. Missing the call after that degrades to the pre-existing
    // behavior: free text, no headline.
    if (
      !runAnotherSegment &&
      shouldRequestOutcome({
        outcome: options.runOutcome,
        segmentFinishReason,
        stepCount,
        maxSteps: options.maxSteps,
        alreadyAsked: outcomeNudgeSpent,
        suspended: Boolean(suspendState),
      })
    ) {
      try {
        const segmentResponse: any = await stream.response;
        messages = [...segmentInput, ...((segmentResponse?.messages as any[]) ?? [])];
        // A user-role reminder, not system: providers vary on whether a
        // system message may appear mid-conversation, and every one of them
        // accepts a user turn.
        messages.push({ role: 'user', content: OUTCOME_NUDGE_PROMPT } as ModelMessage);
        contextManager?.setMessages(messages);
        outcomeNudgeSpent = true;
        // The report already exists, so anything the nudge segment writes is a
        // duplicate. A silent first segment keeps its voice.
        suppressTextAfterNudge = sawText;
        runAnotherSegment = true;
        logger.debug('Run ended with no outcome declared; asking once for report_complete/report_incomplete.');
      } catch (nudgeError) {
        // Best-effort: never fail a finished run over its own headline.
        logger.debug(`Outcome nudge skipped: ${(nudgeError as Error).message}`);
      }
    }

  } catch (error: any) {
    if (isSuspendSignal(error)) {
      // Thrown through the iteration itself (no chance to drain): still abort
      // so in-flight sibling executes get the signal, and leave a WAL record.
      runAbort.abort();
      leaseStore.revoke();
      options.effectWal?.append({
        event: 'suspended',
        via: 'thrown',
        ...(lastToolCall?.id && { gateCallId: lastToolCall.id }),
        ...(lastToolCall?.name && { gateTool: lastToolCall.name }),
      });
      await compactAtSuspensionBoundary();
      const contextSnapshot = buildContextSnapshot(lastToolCall?.id);
      yield {
        type: 'suspended',
        ...(lastToolCall?.name && { toolName: lastToolCall.name }),
        ...(lastToolCall?.id && { toolCallId: lastToolCall.id }),
        ...(lastToolCall?.id && { suspend: { toolCallId: lastToolCall.id } }),
        toolResultRaw: error.payload,
        ...(contextSnapshot && {
          contextUsage: contextSnapshot.usage,
          contextSnapshot,
        })
      };
      return;
    }

    // Check for token limit errors first
    const errorMessage = toErrorMessage(error);
    const errorLower = errorMessage.toLowerCase();

    if (
      errorLower.includes('context_length_exceeded') ||
      errorLower.includes('context length') ||
      errorLower.includes('maximum context') ||
      errorLower.includes('token limit') ||
      errorLower.includes('context window') ||
      errorLower.includes('too many tokens')
    ) {
      logger.error(`
⚠️  CONTEXT LIMIT EXCEEDED

The conversation history has grown too large for the model.

Suggestions:
- Break your task into smaller sub-agents (see docs on subagents)
- Lower the compaction threshold: COMPACTION_THRESHOLD=0.6 (current: 0.7)
- Keep fewer recent messages: COMPACTION_KEEP_RECENT=2 (current: 3)
- Use a model with a larger context window

Current step: ${stepCount}
Error: ${errorMessage}`);
      yield { type: 'error', error };
      return;
    }

    // Handle AI SDK errors gracefully
    if (error.name === 'AI_NoSuchToolError' || error.message?.includes('unavailable tool')) {
      // Extract tool name from the error message
      const toolNameMatch = error.message?.match(/tool '([^']+)'/);
      const toolName = toolNameMatch ? toolNameMatch[1] : 'unknown';

      logger.warn(`AI tried to call non-existent tool: ${toolName}`);

      // Return this as a tool result so the AI can adapt
      yield {
        type: 'tool-result',
        toolName: toolName,
        toolResult: JSON.stringify({
          success: false,
          error: {
            type: 'tool_not_found',
            message: `The tool '${toolName}' does not exist. Available tools: ${Object.keys(tools).join(', ')}`,
            retryable: false,
            suggestions: [
              'Check the available tools list',
              'Use a different tool with similar functionality',
              'Proceed without this tool'
            ]
          }
        }),
        toolResultRaw: { error: error.message }
      };

      // Continue execution - don't terminate the agent
      // The AI will receive the error as a tool result and can adapt

    } else {
      // For other errors, still try to handle gracefully
      logger.error('Stream processing error:', error);
      yield { type: 'error', error };
    }
  } finally {
    // Release the stream reader; for-await used to do this implicitly. Cancels
    // the stream when we returned early (suspension), no-op when it completed.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      // Iterator already closed.
    }
  }
  }

  // End-of-run: if the completed run read media that still lives in the active
  // context, persist a context snapshot so a later continue-session can replay
  // the actual image/PDF. Durable message parts only keep the stripped text ref
  // (the base64 is removed before persistence), and no snapshot is written on a
  // normal completion, only on suspension/compaction. writeContextSnapshot
  // externalizes the media to the session cache, so the snapshot stays lean.
  // (Requires the context manager; with CONTEXT_COMPACTION=false there is no
  // active-context snapshot and continued sessions fall back to text refs.)
  if (contextManager && options.sessionManager && options.sessionID && options.agentId) {
    try {
      const finalMessages = contextManager.getMessages();
      if (messagesContainInlineMedia(finalMessages)) {
        const stats = contextManager.getStats();
        await options.sessionManager.writeContextSnapshot(options.sessionID, options.agentId, {
          version: 1,
          updatedAt: stats.updatedAt,
          ...(options.messageID && { messageID: options.messageID }),
          messages: finalMessages,
          usage: stats,
        });
      }
    } catch (err) {
      logger.debug(`Failed to persist end-of-run media context snapshot: ${(err as Error).message}`);
    }
  }

  } finally {
    // An approval authorizes only the execution segment resumed from that gate.
    // Consume it on every exit — success, suspension, cancellation, provider
    // failure, or an exception during context/bootstrap work — so a later
    // continuation can never inherit authority from an earlier human decision.
    leaseStore.revoke();
  }
}

/**
 * Classify error type for intelligent retry decisions
 */
function classifyError(error: string): string {
  const errorLower = error.toLowerCase();
  if (errorLower.includes('no such tool') || errorLower.includes('unavailable tool') || errorLower.includes('tool not found')) {
    return 'tool_not_found';
  }
  if (errorLower.includes('500') || errorLower.includes('502') || errorLower.includes('503') || errorLower.includes('service unavailable')) {
    return 'server_error';
  }
  if (errorLower.includes('429') || errorLower.includes('rate limit')) {
    return 'rate_limit';
  }
  if (errorLower.includes('timeout') || errorLower.includes('timed out')) {
    return 'timeout';
  }
  if (errorLower.includes('401') || errorLower.includes('403') || errorLower.includes('unauthorized') || errorLower.includes('forbidden')) {
    return 'auth_error';
  }
  if (errorLower.includes('404') || errorLower.includes('not found')) {
    return 'not_found';
  }
  if (errorLower.includes('network') || errorLower.includes('connection')) {
    return 'network_error';
  }
  return 'unknown';
}

/**
 * Determine if error is retryable
 */
function isRetryable(error: string): boolean {
  const type = classifyError(error);
  return ['server_error', 'rate_limit', 'timeout', 'network_error'].includes(type);
}

/**
 * Get recovery suggestions based on error type
 */
function getSuggestions(error: string): string[] {
  const type = classifyError(error);
  switch (type) {
    case 'tool_not_found':
      return ['Check the available tools list', 'Use a different tool with similar functionality', 'Proceed without this tool'];
    case 'server_error':
      return ['Wait a moment and retry', 'Try alternative approach', 'Proceed with available information'];
    case 'rate_limit':
      return ['Wait before retrying', 'Use different tool', 'Reduce request frequency'];
    case 'timeout':
      return ['Retry with simpler request', 'Break into smaller tasks', 'Try alternative tool'];
    case 'auth_error':
      return ['Check credentials', 'Use different service', 'Proceed without this data'];
    case 'not_found':
      return ['Verify parameters', 'Try different search terms', 'Resource may not exist'];
    case 'network_error':
      return ['Check connection and retry', 'Try alternative service', 'Wait and retry'];
    default:
      return ['Review error details', 'Try alternative approach', 'Proceed with caution'];
  }
}

/**
 * Parse tool result from various formats
 */
function parseToolResult(chunk: any): string {
  let output = chunk.result || chunk.output;

  if (typeof output === 'object' && output !== null) {
    if (output.output) {
      output = output.output;
    } else if (output.content) {
      // Handle MCP content array format
      if (Array.isArray(output.content)) {
        output = output.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('\n\n');
      } else {
        output = output.content;
      }
    } else if (output.result) {
      output = output.result;
    } else {
      output = JSON.stringify(output);
    }
  }

  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Classify a nominally successful tool result that actually reads like a soft
 * failure (a tool that reports an error in its return value instead of
 * throwing). The normalized AgentChunk carries this classification so terminal
 * and session projections render the same single failed lifecycle.
 */
export function isSoftToolError(chunk: any, resultStr: string): boolean {
  if (!resultStr || typeof resultStr !== 'string') return false;
  // Skill content often documents errors (e.g. "not found" troubleshooting), so
  // it would always trip the heuristic; skip it.
  if (chunk.toolName === 'tools__skill_load' || chunk.toolName === 'tools__skill_read') return false;

  const firstLine = resultStr.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const errorPatterns = [
    /^Error\b/i,
    /^Error executing\b/i,
    /^Failed to\b/i,
    /^auth(?:entication)?\s+failed\b/i,
    /^unauthorized\b/i,
    /^permission denied\b/i,
    /^not found\b/i,
    /^invalid\s+(?:token|api[\s_-]?key)\b/i,
  ];
  return errorPatterns.some((pattern) => pattern.test(firstLine));
}
