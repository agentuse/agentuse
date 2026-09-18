import { responseMetadataFromRaw, responseMetadataFromStep, type ResponseMetadata } from '../telemetry/response-metadata';
import { streamText, isStepCount, asSchema, type ModelMessage, type ToolSet } from 'ai';
import { readResultBytePage } from '../tools/results';
import { repairSmuggledXmlToolCall } from './tool-call-repair';
import { createHash, randomBytes } from 'crypto';
import type { ParsedAgent } from '../parser';
import { createModel } from '../models';
import { resolveModelInfo, resolveModelProvider } from '../utils/model-utils';
import { BUILTIN_PROVIDERS } from '../providers/registry-sources';
import { OPENCODE_GO_PROVIDER_ID } from '../providers/opencode-go';
import {
  resolveModelRouteCompatibility,
  isGPT6Astra,
  resolveReasoningCompatibility,
  prepareThinkingReplay,
  type ReasoningLevel,
} from '../model-compatibility';
import { CodexAuth } from '../auth/codex';
import { logger } from '../utils/logger';
import {
  createStallWatchdog,
  estimateModelContextTokens,
  MODEL_STALL_MAX_ATTEMPTS,
  ModelStreamStallError,
  ModelStreamTransportError,
  MODEL_TRANSPORT_MAX_ATTEMPTS,
  isModelStreamTransportDrop,
  modelStallRetryDelayMs,
  resolveModelStallPolicy,
  waitForModelStallRetry,
  type StallWatchdog,
} from './model-stall';
import { ContextManager } from '../context-manager';
import { compactMessages } from '../compactor';
import { addLanguageModelUsage } from '../session/usage';
import type { AgentChunk } from './types';
import { isSuspendSignal } from './suspend';
import { sanitizeWALInput, type EffectWAL } from './effect-wal';
import { BashPermissionController, LeaseStore } from './approval-lease';
import { GateSealStore } from './gate-seal';
import {
  ApprovalInputLedger,
  ApprovalInputLedgerError,
  approvalInputDigest,
  isDuplicateApprovalInputLedgerError,
} from './approval-input-ledger';
import { approvalToolContract, ApprovalToolContractError } from '../tools/tool-contract';
import { applyGateDecisionEffects } from './gate-decision';
import { attachCommandToPendingGate, withGatePlanPreflight } from './gate-preflight';
import { isMockMode, resolveMockApprovalDecision, mockGateDecisionResult } from './mock-tools';
import { registerSDKTelemetryOnce } from '../telemetry/sdk-telemetry';
import { recordErrorMarker } from './session-helper';
import { extractApiErrorDetail } from './api-error';
import { toErrorMessage } from '../utils/error-message';
import { completeApprovalValueDisplay, type CompleteApprovalValueDisplay } from '../utils/approval-value';
import { getSessionUrl } from '../tools/await-human';
import type { CompactionReason, SessionManager } from '../session';
import {
  ToolDispatchDeniedError,
  ToolDispatcher,
  ToolInputValidationError,
  type ReusableResultWriter,
  type ToolOutputArtifactWriter,
} from './tool-dispatcher';
import {
  CODE_EXEC_TOOL,
  codeModeEligibleToolNames,
  createCodeExecTool,
  isCodeModeEnabled,
  type CodeModeResultAccess,
  type NestedToolTrace,
} from './code-mode';
import { codeModeResultId, type CodeModeResultReference } from '../session/code-mode-results';
import { injectIntentParam } from './tool-intent';
import { stripInlineMediaData } from '../tools/media.js';
import { createResultsTool, RESULTS_TOOL } from '../tools/results.js';
import { messagesContainInlineMedia } from '../session/media-cache.js';
import { stripToolBlocks, hasReasoningParts, lastAssistantMessage } from '../session/message-utils';
import { OUTCOME_NUDGE_PROMPT, shouldRequestOutcome } from './outcome';
import { REPORT_COMPLETE_TOOL, REPORT_INCOMPLETE_TOOL } from '../tools/report-outcome.js';
import type { RunOutcome } from '../tools/report-outcome.js';
import {
  SUBMIT_AGENT_SOURCE_NUDGE_PROMPT,
  SUBMIT_AGENT_SOURCE_TOOL,
  type AgentSourceSubmission,
} from '../onboarding/submit-agent-source.js';
import {
  SUBMIT_PROJECT_SUGGESTIONS_NUDGE_PROMPT,
  SUBMIT_PROJECT_SUGGESTIONS_TOOL,
  type ProjectSuggestionsSubmission,
} from '../onboarding/submit-project-suggestions.js';
import { applyProviderSystemMessages, providerUsesAnthropicProtocol } from '../plugin/provider-behavior';
import { loadedPluginProtocol, loadedPluginRegistryProvider } from '../plugin/provider-runtime';
import type {
  ModelFallbackEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '../plugin/types';
import {
  availableModelCandidates,
  clearModelCooldown,
  markModelCooldown,
  shouldTryNextModel,
} from './model-fallback';

// Constants
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_GATE_MACHINE_REJECTIONS = 3;

class GateMachineRejectionLoopError extends Error {
  constructor(count: number, reason: string) {
    super(
      `await_human stopped after ${count} consecutive runtime rejections. ` +
      `The request is not converging on a valid approval contract. Last rejection: ${reason}`
    );
    this.name = 'GateMachineRejectionLoopError';
  }
}
// Chunk types that commit externally visible output or have crossed the
// irreversible tool-call boundary in the current step. Their presence makes
// that step unsafe to retry. Reasoning and partial tool-input assembly are
// deliberately excluded: they have no external effect, so a provider that
// drops after either can safely restart from the same model-step checkpoint.
const MODEL_COMMITTED_OUTPUT_CHUNK_TYPES = new Set([
  'text-delta',
  'tool-call',
  'tool-result',
  'tool-error',
]);
// Agent creation has the same two-phase contract as project discovery. Keep
// three turns for submit/validation repair and one for report_complete so a
// model cannot spend the entire budget browsing the project and then lose the
// only accepted delivery path.
const AGENT_SOURCE_DELIVERY_RESERVE = 4;
const AGENT_SOURCE_OUTCOME_RESERVE = 1;
// Project discovery must retain enough model turns to hand its findings back
// through the validated tool. Exploration gets the main budget; delivery keeps
// three turns for submit/validation repair and one for report_complete.
const PROJECT_SUGGESTIONS_DELIVERY_RESERVE = 4;
const PROJECT_SUGGESTIONS_OUTCOME_RESERVE = 1;

// Trailing-debounce window for context snapshots. Long enough that a burst of
// model steps collapses into one write, short enough that a crash between rest
// points loses at most the last step or two.
const CONTEXT_SNAPSHOT_DEBOUNCE_MS = 1500;
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
    (!BUILTIN_PROVIDERS.includes(provider) && !loadedPluginRegistryProvider(provider))
    || provider === OPENCODE_GO_PROVIDER_ID;

  const override = agent.config.maxOutputTokens;
  const anthropicThinkingMax =
    isAnthropicModel(agent.config.model) ? resolveAnthropicThinking(agent)?.maxOutputTokens : undefined;
  if (anthropicThinkingMax) {
    if (!override) return anthropicThinkingMax;
    // The documented use of `maxOutputTokens` is "my agent must emit a large
    // single response"; letting the thinking ceiling silently override it would
    // cap the visible answer at budget + reserve no matter what the author set.
    const registryOutput = resolveModelInfo(agent.config.model)?.limit?.output;
    const clamped = registryOutput ? Math.min(override, registryOutput) : override;
    return Math.max(clamped, anthropicThinkingMax);
  }

  if (isCustomProvider) return override ?? CUSTOM_PROVIDER_MAX_OUTPUT_TOKENS;

  const registryOutput = resolveModelInfo(agent.config.model)?.limit?.output;
  if (override) return registryOutput ? Math.min(override, registryOutput) : override;

  if (isAnthropicModel(agent.config.model) && registryOutput && registryOutput > 0) {
    return Math.min(registryOutput, DEFAULT_MAX_OUTPUT_TOKENS);
  }
  return undefined;
}

function isAnthropicModel(model: string): boolean {
  const provider = resolveModelProvider(model);
  return provider === 'anthropic' || loadedPluginProtocol(provider) === 'anthropic';
}

/**
 * Gate attachment needs the provider's streamed object to remain shared with
 * the approval card. Schema transforms may instead deliberately produce a
 * Date, array, Map, or application instance. Only reconcile identities when
 * both values are ordinary records; mutating an arbitrary normalized value
 * into the provider object would silently destroy that root transform.
 */
function areCompatiblePlainRecords(raw: unknown, normalized: unknown): raw is Record<string, unknown> {
  const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  return isPlainRecord(raw) && isPlainRecord(normalized);
}

async function awaitToolApprovalAbortable<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new Error('Tool approval aborted');
  if (!signal) return await operation();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Tool approval aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new Error('Tool approval aborted');
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Match the SDK's per-tool context contract when our generic approval wrapper
 * takes precedence over its normal needsApproval path. */
async function validateToolApprovalContext(
  toolName: string,
  tool: any,
  context: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (tool?.contextSchema == null) return context;
  const schema = asSchema(tool.contextSchema);
  if (!schema.validate) return context;
  const result = await awaitToolApprovalAbortable(() => schema.validate!(context), signal);
  if (!result.success) {
    throw new Error(`Invalid tool context for '${toolName}': ${result.error.message}`);
  }
  return result.value;
}

function approvalStatusType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return (value as { type?: string }).type;
  return undefined;
}

function isApprovedHistoricalToolCall(opts: {
  toolCall: { toolName: string; toolCallId?: string; input?: unknown };
  messages?: ModelMessage[];
}): boolean {
  const callId = opts.toolCall.toolCallId;
  if (!callId || !Array.isArray(opts.messages)) return false;
  const last = opts.messages.at(-1) as any;
  if (last?.role !== 'tool' || !Array.isArray(last.content)) return false;
  const approvedIds = new Set(last.content
    .filter((part: any) => part?.type === 'tool-approval-response' && part.approved === true)
    .map((part: any) => part.approvalId)
    .filter((id: unknown): id is string => typeof id === 'string'));
  if (approvedIds.size === 0) return false;
  return opts.messages.some((message: any) => (
    message?.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part: any) => (
      part?.type === 'tool-approval-request'
      && part.toolCallId === callId
      && approvedIds.has(part.approvalId)
    ))
  ));
}

function rejectedHistoricalToolCalls(messages: ModelMessage[] | undefined): Array<{
  toolCallId: string;
  toolName: string;
  reason?: string;
}> {
  if (!Array.isArray(messages) || messages.at(-1)?.role !== 'tool') return [];
  const rejectedApprovalIds = new Set<string>();
  const reasonByApprovalId = new Map<string, string>();
  for (const part of ((messages.at(-1) as any)?.content ?? [])) {
    if (part?.type === 'tool-approval-response' && part.approved === false && typeof part.approvalId === 'string') {
      rejectedApprovalIds.add(part.approvalId);
      if (typeof part.reason === 'string') reasonByApprovalId.set(part.approvalId, part.reason);
    }
  }
  if (rejectedApprovalIds.size === 0) return [];
  const rejectedCallIds = new Set<string>();
  const reasonByCallId = new Map<string, string>();
  for (const message of messages as any[]) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'tool-approval-request' && rejectedApprovalIds.has(part.approvalId) && typeof part.toolCallId === 'string') {
        rejectedCallIds.add(part.toolCallId);
        const reason = reasonByApprovalId.get(part.approvalId);
        if (reason) reasonByCallId.set(part.toolCallId, reason);
      }
    }
  }
  const result: Array<{ toolCallId: string; toolName: string; reason?: string }> = [];
  for (const message of messages as any[]) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part?.type === 'tool-call'
        && rejectedCallIds.has(part.toolCallId)
        && typeof part.toolName === 'string'
      ) {
        const reason = reasonByCallId.get(part.toolCallId);
        result.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          ...(reason !== undefined && { reason }),
        });
      }
    }
  }
  return result;
}

function cloneProviderInput(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch (error) {
    throw new ApprovalInputLedgerError(
      `Approval input restoration failed: provider input cannot be safely copied: ${toErrorMessage(error)}`
    );
  }
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
  const isReasoningModel = resolveModelInfo(agent.config.model)?.reasoning === true;
  return {
    promptCacheKey: configured.promptCacheKey ?? defaultOpenAIPromptCacheKey(agent),
    ...(isReasoningModel && { reasoningSummary: 'auto' }),
    // The installed SDK predates Astra and otherwise drops reasoning options.
    ...(isGPT6Astra(agent.config.model) && { forceReasoning: true }),
    ...configured,
    ...(isGPT6Astra(agent.config.model) &&
      (configured.reasoningEffort === 'none' || configured.reasoningEffort === 'minimal') &&
      { reasoningEffort: 'low' }),
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
      resolveModelInfo(agent.config.model)?.limit?.output ?? Number.MAX_SAFE_INTEGER,
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
  reasoning?: Exclude<ReasoningLevel, 'max'>;
  providerOptions?: Record<string, Record<string, unknown>>;
  anthropicThinkingBudget?: number;
} {
  const requestedReasoning = agent.config.reasoning;
  if (requestedReasoning) {
    return resolveReasoningCompatibility(agent.config.model, requestedReasoning);
  }
  const anthropicThinkingBudget =
    isAnthropicModel(agent.config.model) ? resolveAnthropicThinking(agent)?.budgetTokens : undefined;
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

function mergeProviderOptions(
  base: Record<string, Record<string, unknown>> | undefined,
  extra: Record<string, Record<string, unknown>> | undefined
): Record<string, Record<string, unknown>> | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const merged = { ...base };
  for (const [provider, options] of Object.entries(extra)) {
    merged[provider] = { ...(base[provider] ?? {}), ...options };
  }
  return merged;
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

function buildReusableResultWriter(options: {
  sessionManager?: SessionManager;
  sessionID?: string;
  agentId?: string;
  messageID?: string;
}): ReusableResultWriter | undefined {
  if (
    !options.sessionManager
    || typeof options.sessionManager.recordDirectToolResult !== 'function'
    || !options.sessionID
    || !options.agentId
    || !options.messageID
  ) {
    return undefined;
  }

  return async (tool, toolInput, output, completedAt) => {
    return options.sessionManager!.recordDirectToolResult(
      options.sessionID!,
      options.agentId!,
      options.messageID!,
      { tool, toolInput, output: stripInlineMediaData(output), completedAt },
    );
  };
}

export function buildCodeModeTraceHooks(options: {
  sessionManager?: SessionManager;
  sessionID?: string;
  agentId?: string;
  messageID?: string;
}): {
  onNestedToolStart?: (trace: Omit<NestedToolTrace, 'output' | 'error' | 'endedAt'>) => Promise<void>;
  onNestedToolFinish?: (trace: NestedToolTrace) => Promise<CodeModeResultReference | void>;
  resultAccess?: CodeModeResultAccess;
} {
  if (!options.sessionManager || !options.sessionID || !options.agentId || !options.messageID) return {};
  const partIds = new Map<string, Promise<string | undefined>>();
  const manager = options.sessionManager;
  const sessionID = options.sessionID;
  const agentId = options.agentId;
  const messageID = options.messageID;

  return {
    onNestedToolStart: async (trace) => {
      const part = manager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: trace.callId,
        parentCallID: trace.parentCallId,
        tool: trace.toolName,
        state: {
          status: 'running',
          input: trace.input,
          metadata: { parentCallId: trace.parentCallId, codeMode: true },
          time: { start: trace.startedAt },
        },
      } as any).catch((error) => {
        logger.debug(`Failed to log nested Code Mode tool call: ${toErrorMessage(error)}`);
        return undefined;
      });
      partIds.set(trace.callId, part);
      await part;
    },
    onNestedToolFinish: async (trace) => {
      const partId = await partIds.get(trace.callId);
      if (!partId) return;
      const resultId = codeModeResultId(messageID, partId);
      const resultReference = trace.error === undefined && trace.reusableResult
        ? {
            resultId,
            tool: trace.toolName,
            ...trace.reusableResult,
            completedAt: trace.endedAt,
          }
        : undefined;
      const state = trace.error === undefined
        ? {
            status: 'completed' as const,
            input: trace.input,
            output: stripInlineMediaData(trace.output),
            metadata: {
              parentCallId: trace.parentCallId,
              codeMode: true,
              ...(resultReference && { codeModeResult: resultReference }),
            },
            time: { start: trace.startedAt, end: trace.endedAt },
          }
        : {
            status: 'error' as const,
            input: trace.input,
            error: trace.error,
            metadata: { parentCallId: trace.parentCallId, codeMode: true },
            time: { start: trace.startedAt, end: trace.endedAt },
          };
      try {
        await manager.updatePart(sessionID, agentId, messageID, partId, { state });
        if (resultReference) {
          await manager.recordCodeModeResult(sessionID, agentId, messageID, partId, resultReference);
          return resultReference;
        }
      } catch (error) {
        logger.debug(`Failed to complete nested Code Mode tool call: ${toErrorMessage(error)}`);
      } finally {
        partIds.delete(trace.callId);
      }
      return undefined;
    },
    resultAccess: {
      read: (resultId) => manager.readCodeModeResult(sessionID, agentId, resultId),
      page: (resultId, options) => readResultBytePage(manager, sessionID, agentId, resultId, options),
      list: (limit) => manager.listCodeModeResults(sessionID, agentId, limit),
      grep: (resultId, options) => manager.grepCodeModeResult(sessionID, agentId, resultId, options),
      jq: (resultId, expression, options, signal) => manager.jqCodeModeResult(
        sessionID,
        agentId,
        resultId,
        expression,
        options,
        signal
      ),
    },
  };
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
 * All assistant/tool messages produced by one streamText segment.
 *
 * AI SDK v7's `response` is metadata for the FINAL step only. A normal final
 * `stop` after several tool rounds commonly has `response.messages: []`, which
 * erased the completed tool trace before an outcome-nudge or compaction
 * segment. `responseMessages` is the accumulated history across every step.
 * Keep the response fallback for hand-built stream mocks and older SDK shapes.
 */
async function accumulatedResponseMessages(stream: any): Promise<ModelMessage[]> {
  if (stream?.responseMessages !== undefined) {
    return await stream.responseMessages as ModelMessage[];
  }
  const response = await stream.response;
  return (response?.messages as ModelMessage[] | undefined) ?? [];
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
  /** Internal closed-tool replay runner only: capture before gate preflight and
   * stop before another model step, compaction, or outcome recovery. */
  replay?: { stopped(): boolean };
  agentSourceSubmission?: AgentSourceSubmission;
  projectSuggestionsSubmission?: ProjectSuggestionsSubmission;
  pluginEvents?: {
    toolCall?(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult>;
    toolResult?(event: ToolResultEvent, signal?: AbortSignal): Promise<ToolResultEvent>;
    modelFallback?(event: ModelFallbackEvent, signal?: AbortSignal): Promise<void>;
  };
};

type ExecuteAgentAttemptOptions = ExecuteAgentCoreOptions & {
  /** Shared across candidate attempts so a pre-output model fallback does not
   * consume the approval authority for the resumed execution segment. */
  approvalLeaseStore: LeaseStore;
};

async function systemMessagesForModel(
  messages: Array<{ role: string; content: string }>,
  model: string
): Promise<Array<{ role: string; content: string }>> {
  return applyProviderSystemMessages(messages, model);
}

function providerOptionsForModel(providerOptions: unknown, model: string): unknown {
  if (!providerOptions || typeof providerOptions !== 'object' || Array.isArray(providerOptions)) {
    return providerOptions;
  }
  const provider = resolveModelProvider(model);
  const optionProvider = loadedPluginProtocol(provider) ?? provider;
  const selected = (providerOptions as Record<string, unknown>)[optionProvider];
  return selected === undefined ? undefined : { [optionProvider]: selected };
}

/** Rebuild provider-specific history metadata when fallback crosses providers. */
function messagesForFallbackModel(
  messages: ModelMessage[],
  systemMessages: Array<{ role: string; content: string }>,
  model: string
): ModelMessage[] {
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem]?.role === 'system') {
    firstNonSystem++;
  }
  const rebuilt = [
    ...systemMessages,
    ...messages.slice(firstNonSystem),
  ] as ModelMessage[];
  return rebuilt.map((message: any) => {
    const providerOptions = providerOptionsForModel(message.providerOptions, model);
    const content = Array.isArray(message.content)
      ? message.content.map((part: any) => {
          const partProviderOptions = providerOptionsForModel(part?.providerOptions, model);
          if (partProviderOptions === part?.providerOptions) return part;
          const next = { ...part };
          if (partProviderOptions === undefined) delete next.providerOptions;
          else next.providerOptions = partProviderOptions;
          return next;
        })
      : message.content;
    const next = { ...message, content };
    if (providerOptions === undefined) delete next.providerOptions;
    else next.providerOptions = providerOptions;
    return next;
  });
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
 * Run one execution segment against an ordered model alias. A transient failure
 * may move to the next candidate only before the provider emits output or
 * invokes a tool in this segment. Resumes/redos start at the model already
 * selected for the session and may continue forward through the remaining
 * candidates; persisted history is provider-neutral at this boundary.
 */
export async function* executeAgentCore(
  agent: ParsedAgent,
  tools: ToolSet,
  options: ExecuteAgentCoreOptions
): AsyncGenerator<AgentChunk> {
  const configuredCandidates = agent.config.modelCandidates ?? [agent.config.model];
  const selectedIndex = configuredCandidates.indexOf(agent.config.model);
  const configured = options.messages && selectedIndex >= 0
    ? configuredCandidates.slice(selectedIndex)
    : options.messages
      ? [agent.config.model]
      : configuredCandidates;
  const candidates = availableModelCandidates(configured);
  const initiallyPreparedModel = agent.config.model;
  const approvalLeaseStore = new LeaseStore();

  try {
  for (let index = 0; index < candidates.length; index++) {
    const model = candidates[index]!;
    const attemptSystemMessages = model === initiallyPreparedModel
      ? options.systemMessages
      : await systemMessagesForModel(options.systemMessages, model);
    if (model === initiallyPreparedModel) agent.config.model = model;
    else await persistSelectedModel(agent, model, attemptSystemMessages, options);
    const attemptAgent: ParsedAgent = {
      ...agent,
      config: { ...agent.config, model, reasoning: agent.config.modelCandidateReasoning?.[model] ?? agent.config.reasoning },
    };
    const crossesProvider = resolveModelProvider(model) !== resolveModelProvider(initiallyPreparedModel);
    let meaningfulOutput = false;
    let fallbackError: unknown;
    const attempt = executeAgentAttempt(attemptAgent, tools, {
      ...options,
      systemMessages: attemptSystemMessages,
      ...(options.messages && crossesProvider && {
        messages: messagesForFallbackModel(options.messages, attemptSystemMessages, model),
      }),
      approvalLeaseStore,
    });

    try {
      for await (const chunk of attempt) {
        if (isMeaningfulModelChunk(chunk)) meaningfulOutput = true;
        if (chunk.type === 'error' && !meaningfulOutput && shouldTryNextModel(chunk.error)) {
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
      if (!meaningfulOutput && shouldTryNextModel(error)) {
        markModelCooldown(model, agent.config.modelFallbackCooldownMs);
        if (index + 1 < candidates.length) fallbackError = error;
        else throw error;
      } else {
        throw error;
      }
    }

    if (fallbackError !== undefined) {
      const nextModel = candidates[index + 1]!;
      logger.warn(
        `Model ${model} failed before producing output; falling back to ${nextModel}: ` +
        toErrorMessage(fallbackError)
      );
      await options.pluginEvents?.modelFallback?.({
        agent: {
          name: agent.name,
          model,
          ...(agent.description && { description: agent.description }),
        },
        ...(options.sessionID && { sessionId: options.sessionID }),
        from: model,
        to: nextModel,
        reason: toErrorMessage(fallbackError),
        attempt: index + 2,
      }, options.abortSignal);
      continue;
    }

    clearModelCooldown(model);
    return;
  }
  } finally {
    // The lease belongs to this logical execution segment, not to an individual
    // provider attempt. A failed candidate may hand off to another model, but
    // no later continuation may inherit the approval.
    approvalLeaseStore.revoke();
  }
}

async function* executeAgentAttempt(
  agent: ParsedAgent,
  tools: ToolSet,
  options: ExecuteAgentAttemptOptions
): AsyncGenerator<AgentChunk> {
  // SDK-layer execution witness (debug trace of every tool execute via the
  // v7 telemetry integration). Idempotent; complements the effect WAL.
  registerSDKTelemetryOnce();

  let rawResponseMetadata: ResponseMetadata | undefined;
  const requestFingerprints = new Map<string, import('../telemetry/request-fingerprint').RequestFingerprint>();
  const model = await createModel(agent.config.model, {
    ...(options.sessionID && { sessionId: options.sessionID }),
    onRequestFingerprint: (id, fingerprint) => {
      requestFingerprints.set(id, fingerprint);
      if (requestFingerprints.size > 32) requestFingerprints.delete(requestFingerprints.keys().next().value!);
    },
  });

  // Internal abort: tripped the instant a suspension begins so the AI SDK stops
  // the step loop and in-flight tool executes receive the signal (bash kills its
  // process tree). Without it, the SDK's eagerly-dispatched sibling tool calls
  // keep executing while the gate is pending — the 2026-07-16 ghost posts
  // (agentuse-lab#165). Combined with the caller's signal when one exists.
  const runAbort = new AbortController();
  const effectiveAbortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, runAbort.signal])
    : runAbort.signal;

  // Stall watchdog: a provider stream that opens and then goes silent used to
  // hang until the session timeout killed the whole run. The watchdog aborts
  // only its own per-attempt controller (never runAbort or the caller's
  // signal), so a silent model step can be retried instead of ending the run.
  let stallWatchdog: StallWatchdog | undefined;

  // Approval leases (agentuse-lab#165, Phase 2): gated commands declared in
  // `tools.bash.gated` only run when covered by the latest approved await_human
  // changes[]. The store is file-based in the session directory (granted at
  // resume time, possibly by another process) and read per call.
  const effectPatterns = agent.config.tools?.bash?.gated ?? [];
  const bashPermission = new BashPermissionController(effectPatterns);
  const leaseStore = options.approvalLeaseStore;
  const approvalInputLedger = new ApprovalInputLedger(options.sessionID, options.agentId);
  // Gate seal (reject-is-terminal): bound whenever the run has a session, since
  // any approval-enabled agent can carry an await_human gate regardless of
  // whether it also declares gated bash commands.
  const gateSealStore = new GateSealStore();
  if (options.sessionManager && options.sessionID && options.agentId) {
    try {
      const sessionDir = await options.sessionManager.getSessionDirectory(options.sessionID, options.agentId);
      if (effectPatterns.length > 0) leaseStore.bind(sessionDir);
      gateSealStore.bind(sessionDir);
      approvalInputLedger.bind(sessionDir);
    } catch (error) {
      logger.debug(`[Lease] failed to bind session-dir stores: ${(error as Error).message}`);
    }
  }

  // A rejected manual approval never enters toolApproval or execute in this
  // SDK invocation. Retire its canonical ledger record only after the resumed
  // run has completed preparation and entered executeAgentCore, beyond the
  // worker's rollback boundary. This keeps a pre-run failure retryable while
  // ensuring a started rejection can never later be changed into execution.
  // Declared outside the run's try so the exit path below can flush a pending
  // context snapshot.
  let contextManager: ContextManager | null = null;

  // A context snapshot is a full 200-800KB pretty-printed rewrite of the active
  // transcript, and prepareStep asks for one on every model step. Coalesce the
  // writes onto a trailing debounce and flush on every path that ends or
  // suspends the run, so a long post-compaction run costs roughly one write per
  // rest point instead of one per step, with nothing lost at rest.
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotWrites: Promise<void> = Promise.resolve();
  let lastSnapshot: { messages: number; tokens: number } | undefined;

  const writeContextSnapshot = async (): Promise<void> => {
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
      const snapshotMessages = contextManager.getMessages();
      // Unchanged since the last write: what is on disk is already current.
      if (lastSnapshot?.messages === snapshotMessages.length && lastSnapshot.tokens === stats.activeTokens) {
        return;
      }
      await options.sessionManager.writeContextSnapshot(options.sessionID, options.agentId, {
        version: 1,
        updatedAt: stats.updatedAt,
        ...(options.messageID && { messageID: options.messageID }),
        messages: snapshotMessages,
        usage: stats,
      });
      lastSnapshot = { messages: snapshotMessages.length, tokens: stats.activeTokens };
    } catch (error) {
      logger.debug(`Failed to persist compacted context: ${(error as Error).message}`);
    }
  };

  // Serialized so a debounced write and a flush can never overlap on the file.
  const queueContextSnapshotWrite = (): Promise<void> => {
    snapshotWrites = snapshotWrites.then(writeContextSnapshot);
    return snapshotWrites;
  };

  const persistContextSnapshot = (): void => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      void queueContextSnapshotWrite();
    }, CONTEXT_SNAPSHOT_DEBOUNCE_MS);
  };

  const flushContextSnapshot = async (): Promise<void> => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    await queueContextSnapshotWrite();
  };

  let pluginTerminateRequested = false;

  try {
  // Initialize context manager if enabled
  const usesAnthropicCacheControl = isAnthropicModel(agent.config.model)
    || await providerUsesAnthropicProtocol(agent.config.model);
  const initialMessages: any[] = prepareThinkingReplay(agent.config.model, options.messages ?? [
    ...options.systemMessages,
    usesAnthropicCacheControl
      ? buildUserMessage(options.userMessage, options.cacheableUserMessage)
      : { role: 'user', content: options.userMessage }
  ]);
  let messages = usesAnthropicCacheControl
    ? applyAnthropicCacheControlToMessages(initialMessages)
    : initialMessages;
  const writeToolOutputArtifact = buildToolOutputArtifactWriter(options);
  const writeReusableResult = options.replay ? undefined : buildReusableResultWriter(options);
  const dispatcher = new ToolDispatcher(tools, {
    ...(options.effectWal && { effectWal: options.effectWal }),
    ...(options.pluginEvents && { pluginEvents: options.pluginEvents }),
    abortSignal: effectiveAbortSignal,
    ...(writeToolOutputArtifact && { writeToolOutputArtifact }),
    ...(writeReusableResult && { writeReusableResult }),
    // Replay tools only read frozen recordings and capture proposals. Live
    // execution permits must not prevent calls from reaching that boundary.
    ...(!options.replay && { bashPermission }),
    onPluginTerminate: () => { pluginTerminateRequested = true; },
  });
  for (const rejected of rejectedHistoricalToolCalls(options.messages)) {
    if (typeof dispatcher.get(rejected.toolName)?.execute !== 'function' || !approvalInputLedger.isBound) continue;
    approvalInputLedger.invalidate(
      rejected.toolName,
      rejected.toolCallId,
    );
  }
  let codeModeHiddenTools = new Set<string>();
  const traceHooks = buildCodeModeTraceHooks(options);
  if (
    !options.replay
    && options.sessionManager
    && options.sessionID
    && options.agentId
  ) {
    const resultsTool = createResultsTool({
      manager: options.sessionManager,
      sessionId: options.sessionID,
      agentId: options.agentId,
    });
    dispatcher.register(
      RESULTS_TOOL,
      agent.config.intent === false ? resultsTool : injectIntentParam(RESULTS_TOOL, resultsTool),
    );
  }
  if (isCodeModeEnabled() && !options.replay && dispatcher.get(CODE_EXEC_TOOL) === undefined) {
    const codeModeTools = dispatcher.codeModeTools();
    const codeModeToolNames = codeModeEligibleToolNames(Object.keys(codeModeTools));
    const codeExecTool = createCodeExecTool({
      dispatcher,
      toolNames: codeModeToolNames,
      toolDefinitions: codeModeTools,
      abortSignal: effectiveAbortSignal,
      ...traceHooks,
    });
    // Registered after the loader's intent pass, so label it here; otherwise a
    // program row shows only "code_exec" beside the described calls it made.
    dispatcher.register(
      CODE_EXEC_TOOL,
      agent.config.intent === false ? codeExecTool : injectIntentParam(CODE_EXEC_TOOL, codeExecTool)
    );
    // Keep transport-sensitive tools and Bash visible on the direct path as
    // well. Bash needs that path for gated commands and remains useful for a
    // standalone process whose output does not need programmatic composition.
    // Other dual-path tools may require direct binary or provider-native
    // delivery that cannot cross the QuickJS JSON bridge.
    codeModeHiddenTools = new Set(codeModeToolNames.filter(
      name => name !== 'tools__bash'
        && typeof codeModeTools[name]?.toModelOutput !== 'function'
    ));
  }
  const dispatchingTools = dispatcher.modelTools();
  for (const name of codeModeHiddenTools) delete dispatchingTools[name];
  const modelFacingTools = usesAnthropicCacheControl
    ? applyAnthropicCacheControlToTools(dispatchingTools)
    : dispatchingTools;

  if (ContextManager.isEnabled()) {
    contextManager = new ContextManager(
      agent.config.model,
      async (messagesToCompact) => compactMessages(messagesToCompact, agent.config.model, options.abortSignal)
    );
    await contextManager.initialize();

    contextManager.setMessages(messages);
  }

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
      persistContextSnapshot();
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

  // `stopWhen` predicate: stop after the current step when a plugin explicitly
  // asks to terminate. A blocking interceptor normally sets both `block` and
  // `terminate`, producing a denied tool result and preventing another turn.
  const stopOnPluginTerminate = (): boolean => pluginTerminateRequested || options.replay?.stopped() === true;

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

  // `stopWhen` predicate: end the run the moment report_complete lands and its
  // execute function actually records a completed outcome. Checking the shared
  // slot matters for guarded completion tools: a rejected report_complete call
  // must return its tool error to the model and leave room for correction.
  // During
  // the outcome-recovery segment, either verdict ends the run: that segment is
  // mechanically restricted to the two outcome tools and has no bookkeeping
  // left to perform. The tool executes before this runs, so its result is still
  // streamed and journaled.
  //
  // Outside recovery, deliberately NOT report_incomplete: that path is told to
  // finish bookkeeping after declaring, so it must keep stepping.
  const stopOnDeliveredOutcome = ({ steps }: { steps: Array<{ content?: unknown }> }): boolean => {
    const content = steps[steps.length - 1]?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part: any) =>
      (part?.type === 'tool-result' || part?.type === 'tool-call') &&
      (
        (part?.toolName === REPORT_COMPLETE_TOOL && !!options.runOutcome?.complete) ||
        (outcomeNudgeSpent && part?.toolName === REPORT_INCOMPLETE_TOOL)
      )
    );
  };

  // The creator recovery segment exposes one schema-backed delivery tool. End
  // that segment as soon as its execute function accepts a valid source, then
  // let the ordinary outcome recovery ask for report_complete separately.
  const stopOnDeliveredAgentSource = ({ steps }: { steps: Array<{ content?: unknown }> }): boolean => {
    if (!agentSourceSubmissionRecoveryActive || !options.agentSourceSubmission?.source) return false;
    const content = steps[steps.length - 1]?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part: any) =>
      (part?.type === 'tool-result' || part?.type === 'tool-call') &&
      part?.toolName === SUBMIT_AGENT_SOURCE_TOOL
    );
  };

  const stopOnDeliveredProjectSuggestions = ({ steps }: { steps: Array<{ content?: unknown }> }): boolean => {
    if (!projectSuggestionsRecoveryActive || !options.projectSuggestionsSubmission?.result) return false;
    const content = steps[steps.length - 1]?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part: any) =>
      (part?.type === 'tool-result' || part?.type === 'tool-call') &&
      part?.toolName === SUBMIT_PROJECT_SUGGESTIONS_TOOL
    );
  };

  // Set once an await_human gate opens in a stream: from that point every sibling
  // tool call in the same turn is barrier-denied (never executed) and the model is
  // told to re-issue after approval. Function-scoped so the tool-call yield sites
  // below can stamp those siblings postSuspend; a resume starts a fresh
  // executeAgentCore, so it never leaks past the suspend.
  let gateBarrierActive = false;
  let gateBarrierCallId: string | undefined;
  // The session resume API addresses one pending decision at a time and the AI
  // SDK requires all approval responses to occupy the same trailing tool
  // message. Claim one ordinary manual approval per stream segment so a model
  // cannot create two durable records that the current protocol cannot resolve
  // atomically. The first callback to claim wins synchronously.
  let manualGenericApprovalCallId: string | undefined;
  let genericApprovalState: {
    toolCallId: string;
    toolName: string;
    payload: Record<string, unknown>;
  } | undefined;

  // `streamText` may run several model/tool steps inside one stream. Keep the
  // canonical input for each model step so a later silent provider call can be
  // retried without replaying tool calls that already completed. `prepareStep`
  // can run ahead of our stream consumer, so checkpoints are queued and paired
  // with the corresponding `start-step` chunk in stream order.
  const preparedStepInputs: ModelMessage[][] = [];
  let activeStepInput: ModelMessage[] | undefined;
  let activeStepProducedCommittedOutput = false;

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
    const {
      reasoning,
      providerOptions: reasoningProviderOptions,
      anthropicThinkingBudget,
    } = resolveReasoning(agent);
    if (agent.config.reasoning) {
      logger.debug(
        agent.config.reasoning === 'none' && !isGPT6Astra(agent.config.model)
          ? 'Reasoning disabled (reasoning: none).'
          : `Reasoning enabled. Requested effort: ${agent.config.reasoning}; resolved effort: ${reasoning ?? 'native'}`
      );
    } else if (anthropicThinkingBudget) {
      logger.debug(`Reasoning enabled via anthropic.thinking budget: ${anthropicThinkingBudget} tokens.`);
    }
    // Per-response output ceiling. Without this, the AI SDK caps model ids it
    // doesn't recognize (e.g. claude-sonnet-5) at 4096, silently truncating runs.
    const maxOutputTokens = resolveMaxOutputTokens(agent);

    // Only include provider options if they exist and match the model provider
    let providerOptions: any = undefined;
    let usesCodexBackend = false;
    if (provider === 'openai') {
      const openaiOptions = openAIOptionsWithCacheDefaults(agent);
      // Check if using Codex OAuth (Responses API) vs regular API key (Chat Completions API)
      const codexAccess = await CodexAuth.access();
      if (codexAccess) {
        usesCodexBackend = true;
        // Codex OAuth uses the Responses API, which requires a top-level
        // `instructions` field. Keep system messages in AgentUse's internal
        // history for persistence/resume, but collapse them into that field in
        // their existing order and tell the OpenAI provider not to emit the
        // same content again as developer input items.
        const instructions = messages
          .filter(message => message.role === 'system' && typeof message.content === 'string')
          .map(message => message.content as string)
          .join('\n\n') || 'You are a helpful assistant.';

        providerOptions = {
          openai: {
            ...openaiOptions,
            instructions,
            systemMessageMode: 'remove',
            store: false,
          }
        };
      } else {
        providerOptions = { openai: openaiOptions };
      }
    } else if (
      provider === OPENCODE_GO_PROVIDER_ID &&
      !resolveModelRouteCompatibility(agent.config.model).supportsStore
    ) {
      // OpenCode Go's Responses models can run without server-side retention.
      // Send complete multi-step history so tool-result turns do not depend on
      // an upstream stored response (which Grok may reject under ZDR).
      providerOptions = { openai: { store: false } };
    } else if (provider === 'anthropic' && anthropicThinkingBudget) {
      // Extended thinking is an explicit opt-in (it bills new output tokens).
      // When enabled, Claude streams its reasoning, which the session trace
      // renders inline. cacheControl is applied per-message elsewhere, so the
      // top-level options carry only the thinking directive.
      providerOptions = { anthropic: { thinking: { type: 'enabled', budgetTokens: anthropicThinkingBudget } } };
    }
    providerOptions = mergeProviderOptions(providerOptions, reasoningProviderOptions);

    // Cap each segment to the remaining step budget so compaction restarts do
    // not multiply the effective step limit (each streamText call counts steps
    // from zero). Onboarding's structured-output flows reserve their final
    // turns for delivery: exploration cannot consume them, and the forced
    // submission segment must still leave one turn for the final outcome call.
    const agentSourceReserve = options.agentSourceSubmission
      && !options.agentSourceSubmission.source
      ? agentSourceSubmissionRecoveryActive
        ? AGENT_SOURCE_OUTCOME_RESERVE
        : AGENT_SOURCE_DELIVERY_RESERVE
      : 0;
    const projectSuggestionsReserve = options.projectSuggestionsSubmission
      && !options.projectSuggestionsSubmission.result
      ? projectSuggestionsRecoveryActive
        ? PROJECT_SUGGESTIONS_OUTCOME_RESERVE
        : PROJECT_SUGGESTIONS_DELIVERY_RESERVE
      : 0;
    const structuredDeliveryReserve = Math.max(agentSourceReserve, projectSuggestionsReserve);
    const remainingSteps = Math.max(1, options.maxSteps - stepCount - structuredDeliveryReserve);
    const policyForMessages = (stepMessages: ModelMessage[]) => resolveModelStallPolicy({
      modelString: agent.config.model,
      contextTokens: contextManager?.getStats().activeTokens ?? estimateModelContextTokens(stepMessages),
      reasoning: agent.config.reasoning,
      anthropicThinking: Boolean(anthropicThinkingBudget),
      codexBackend: usesCodexBackend,
    });
    // One watchdog per streamText call. The previous segment's timer is dropped
    // here as well as on stream end, so a compaction retry never leaves one armed.
    stallWatchdog?.dispose();
    const watchdog = createStallWatchdog(policyForMessages(messages), effectiveAbortSignal);
    stallWatchdog = watchdog;

    const streamConfig: any = {
      include: { rawChunks: true },
      model,
      messages,
      // Our message pipeline carries system-role messages inside `messages`
      // (fresh runs prepend them; resumed sessions rehydrate them). v7 rejects
      // that by default in favor of `instructions`; keep the legacy behavior.
      allowSystemInMessages: true,
      maxRetries: MAX_RETRIES,
      // A missing-outcome recovery turn has exactly one job. Require a tool
      // call there; prose or ordinary tools can only duplicate work or mutate
      // state after the original turn already ended.
      toolChoice: (outcomeNudgeSpent || agentSourceSubmissionRecoveryActive || projectSuggestionsRecoveryActive)
        ? 'required' as const
        : 'auto' as const,
      // Provider-agnostic reasoning effort -> the SDK maps it to the provider's
      // native control (Anthropic thinking budget / OpenAI reasoningEffort).
      ...(reasoning && { reasoning }),
      stopWhen: contextManager
        ? [isStepCount(remainingSteps), stopForCompaction, stopOnSuspend, stopOnDeliveredOutcome, stopOnDeliveredAgentSource, stopOnDeliveredProjectSuggestions, stopOnPluginTerminate]
        : [isStepCount(remainingSteps), stopOnSuspend, stopOnDeliveredOutcome, stopOnDeliveredAgentSource, stopOnDeliveredProjectSuggestions, stopOnPluginTerminate],
      abortSignal: watchdog.signal,
      // Deterministic fix for the XML-drift failure mode (fields smuggled into
      // neighboring strings as <parameter> markup); anything else falls through
      // to the normal invalid-input -> tool-error -> model-retry path.
      repairToolCall: repairSmuggledXmlToolCall,
      ...(providerOptions && { providerOptions }),
      prepareStep: async ({ messages: stepMessages }: { messages: ModelMessage[] }) => {
        preparedStepInputs.push([...stepMessages]);

        // Measurement + cache annotation only. Compaction runs BETWEEN
        // streamText calls (the segment loop), because messages returned from
        // prepareStep do not replace the SDK's accumulated history, so
        // compacting here re-summarizes every step without ever shrinking the
        // real conversation.
        if (contextManager) {
          contextManager.setMessages(stepMessages as any[]);
          persistContextSnapshot();
        }
        watchdog.beginStep(policyForMessages(stepMessages));

        return {
          messages: usesAnthropicCacheControl
            ? applyAnthropicCacheControlToStepMessages(stepMessages as any[])
            : stepMessages
        };
      },
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
    const toolsForStream: ToolSet = agentSourceSubmissionRecoveryActive
      ? Object.fromEntries(
          [SUBMIT_AGENT_SOURCE_TOOL]
            .filter((name) => modelFacingTools[name] !== undefined)
            .map((name) => [name, modelFacingTools[name]])
        ) as ToolSet
      : projectSuggestionsRecoveryActive
      ? Object.fromEntries(
          [SUBMIT_PROJECT_SUGGESTIONS_TOOL]
            .filter((name) => modelFacingTools[name] !== undefined)
            .map((name) => [name, modelFacingTools[name]])
        ) as ToolSet
      : outcomeNudgeSpent
      ? Object.fromEntries(
          [REPORT_COMPLETE_TOOL, REPORT_INCOMPLETE_TOOL]
            .filter((name) => modelFacingTools[name] !== undefined)
            .map((name) => [name, modelFacingTools[name]])
        ) as ToolSet
      : { ...modelFacingTools };
    const awaitHumanPresent = !!(toolsForStream as any).await_human;
    let coreToolApproval: ((opts: { toolCall: { toolName: string; toolCallId?: string; input?: any } }) => unknown) | undefined;
    if (!options.replay && (awaitHumanPresent || effectPatterns.length > 0)) {
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
          {
            effectPatterns,
            onInlineResolution: clearInlineGateState,
            // await_human is a host-owned schema with no user transforms.
            // Validate its final shared object after an internal command gets
            // attached, so card readability/refinement rules still hold.
            validateAttachedInput: async (input) => {
              const schema = asSchema(dispatcher.get('await_human')?.inputSchema);
              if (!schema.validate) return undefined;
              const result = await schema.validate(input);
              return result.success ? undefined : result.error.message;
            },
            resolveAttachedInput: () => pendingGateInput,
          },
        );
      }

      coreToolApproval = async (opts: { toolCall: { toolName: string; toolCallId?: string; input?: any } }) => {
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
          if (command && bashPermission.isGated(command)) {
            if (gatePendingThisStep) {
              const attached = pendingGateInput
                ? attachCommandToPendingGate(pendingGateInput, command)
                : false;
              if (attached && pendingGateInput && gateBarrierCallId) {
                dispatcher.replaceLatestPreparedDirectCall(
                  'await_human',
                  gateBarrierCallId,
                  pendingGateInput,
                );
                approvedToolInputOverrides.set(gateBarrierCallId, { executedInput: pendingGateInput });
                const emittedGate = emittedToolCalls.get(gateBarrierCallId);
                if (emittedGate) emittedGate.toolInput = pendingGateInput;
              }
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
              bashPermission.grantApprovedDirectCall(callId ?? 'unknown', command);
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

    if (
      dispatcher.names().some(name => typeof dispatcher.get(name)?.execute === 'function')
      || options.pluginEvents?.toolCall
    ) {
      streamConfig.toolApproval = async (opts: {
        toolCall: { toolName: string; toolCallId?: string; input?: any; providerExecuted?: boolean };
        messages?: ModelMessage[];
      }) => {
        const toolCallId = opts.toolCall.toolCallId ?? 'unknown';
        const executable = typeof dispatcher.get(opts.toolCall.toolName)?.execute === 'function';
        const tool = dispatcher.get(opts.toolCall.toolName);
        const historicalApproval = executable && isApprovedHistoricalToolCall(opts);
        let toolContract: string | undefined;
        let reservation: ReturnType<ApprovalInputLedger['reserve']> | undefined;
        // Do not make sessionless execution depend on durable approval storage.
        // A bound session reserves every executable identity before policy so a
        // changed tool that removed needsApproval cannot bypass an older
        // pending approval with the same call id.
        if (executable && approvalInputLedger.isBound && !historicalApproval) {
          try {
            reservation = approvalInputLedger.reserve(opts.toolCall.toolName, toolCallId);
          } catch (error) {
            if (error instanceof ApprovalInputLedgerError || error instanceof ApprovalToolContractError) {
              return { type: 'denied' as const, reason: error.message };
            }
            throw error;
          }
        }
        let effectiveRawInput = opts.toolCall.input;
        let preparedInput = opts.toolCall.input;
        if (historicalApproval) {
          try {
            try {
              toolContract = await approvalToolContract(tool, opts.toolCall.toolName, effectiveAbortSignal);
            } catch (contractError) {
              // Claiming the record is one-shot even when the current tool is
              // incompatible. Otherwise a downgraded/missing contract could be
              // fixed later and execute a value the current run rejected.
              try {
                approvalInputLedger.consume(
                  opts.toolCall.toolName, toolCallId, opts.toolCall.input,
                  Date.now(), '__incompatible-approval-contract__',
                );
              } catch { /* consumption is best effort; the contract error wins */ }
              throw contractError;
            }
            // Re-run current plugin policy against an isolated copy of the
            // signed provider input. A mutation would authorize bytes the human
            // did not approve, so require a new approval instead of accepting it.
            if (options.pluginEvents?.toolCall) {
              const policyInput = cloneProviderInput(opts.toolCall.input);
              const policy = await dispatcher.preflightWithInput({
                toolCallId,
                toolName: opts.toolCall.toolName,
                input: policyInput,
                abortSignal: effectiveAbortSignal,
              });
              if (policy.decision.block) {
                approvalInputLedger.invalidate(opts.toolCall.toolName, toolCallId);
                return {
                  type: 'denied' as const,
                  reason: policy.decision.reason ?? `Tool '${opts.toolCall.toolName}' was blocked by a plugin`,
                };
              }
              if (approvalInputDigest(policy.input) !== approvalInputDigest(opts.toolCall.input)) {
                approvalInputLedger.invalidate(opts.toolCall.toolName, toolCallId);
                return {
                  type: 'denied' as const,
                  reason: 'Tool policy changed the approved input. The call was not executed; request a new approval for the updated input.',
                };
              }
            }
            preparedInput = approvalInputLedger.consume(
              opts.toolCall.toolName,
              toolCallId,
              opts.toolCall.input,
              Date.now(),
              toolContract,
            );
            dispatcher.seedPreparedDirectCall(opts.toolCall.toolName, toolCallId, preparedInput);
          } catch (error) {
            dispatcher.discardPreparedDirectCall(toolCallId);
            // Policy rejection above already performs atomic invalidation. A
            // failed consume (for example an absent record) must preserve its
            // own denial reason instead of attempting a second invalidation.
            if (!historicalApproval) approvalInputLedger.discard(opts.toolCall.toolName, toolCallId, reservation);
            if (error instanceof ApprovalInputLedgerError || error instanceof ApprovalToolContractError) {
              return { type: 'denied' as const, reason: error.message };
            }
            throw error;
          }
        } else if (executable) {
          try {
            const prepared = await dispatcher.prepareDirectCall({
              toolCallId,
              toolName: opts.toolCall.toolName,
              // Plugins and schema transforms receive their own copy. The
              // post-plugin raw value becomes the SDK approval/signature input;
              // the transformed canonical value remains dispatcher-only.
              input: cloneProviderInput(opts.toolCall.input),
              abortSignal: effectiveAbortSignal,
            });
            preparedInput = prepared.normalizedInput;
            effectiveRawInput = prepared.effectiveRawInput;
          } catch (error) {
            dispatcher.discardPreparedDirectCall(toolCallId);
            approvalInputLedger.discard(opts.toolCall.toolName, toolCallId, reservation);
            if (
              error instanceof ToolDispatchDeniedError
              || error instanceof ToolInputValidationError
              || error instanceof ApprovalInputLedgerError
            ) {
              return { type: 'denied' as const, reason: error.message };
            }
            throw error;
          }
        } else if (options.pluginEvents?.toolCall) {
          // Provider/client tools never reach the dispatcher execution path,
          // but plugins still own their policy decision. Keep this preflight
          // deliberately normalization-free: the provider retains the tool's
          // native schema and execution contract.
          const decision = await dispatcher.preflight({
            toolCallId,
            toolName: opts.toolCall.toolName,
            input: cloneProviderInput(opts.toolCall.input),
            abortSignal: effectiveAbortSignal,
          });
          if (decision.block) {
            return {
              type: 'denied' as const,
              reason: decision.reason ?? `Tool '${opts.toolCall.toolName}' was blocked by a plugin`,
            };
          }
        }
        try {
          if (
            executable
            && opts.toolCall.toolName === 'await_human'
            && areCompatiblePlainRecords(opts.toolCall.input, preparedInput)
          ) {
            // The model-facing gate preflight wraps execute outside the
            // dispatcher and already captured this parsed object. Reconcile
            // canonical input into that identity so later sibling attachment
            // and gate validation observe one shared payload.
            const rawInput = opts.toolCall.input as Record<string, unknown>;
            for (const key of Object.keys(rawInput)) delete rawInput[key];
            Object.assign(rawInput, preparedInput as Record<string, unknown>);
            preparedInput = rawInput;
          }
          const approvalOptions = {
            ...opts,
            toolCall: { ...opts.toolCall, input: preparedInput },
          };
          if (executable) {
            // Keep the canonical queued input as the same copied object handed
            // to core approval. Gate attachment can happen while sibling
            // approvals are still resolving, before this callback returns.
            dispatcher.replaceLatestPreparedDirectCall(
              opts.toolCall.toolName,
              toolCallId,
              approvalOptions.toolCall.input,
            );
          }
          // A generic callback has precedence in AI SDK. When this wrapper is
          // installed only to prepare canonical inputs, reproduce the SDK's
          // per-tool needsApproval fallback instead of silently bypassing it.
          let approval = coreToolApproval
            ? await coreToolApproval(approvalOptions)
            : undefined;
          if (approvalStatusType(approval) === undefined || approvalStatusType(approval) === 'not-applicable') {
            if (typeof tool?.needsApproval === 'function') {
              const context = await validateToolApprovalContext(
                opts.toolCall.toolName,
                tool,
                // Tool names are user-controlled identifiers. Looking them up
                // through Object.prototype would give a tool named
                // "constructor" (or "toString") an unrelated inherited value
                // as its execution context.
                (opts as any).toolsContext != null
                  && Object.prototype.hasOwnProperty.call((opts as any).toolsContext, opts.toolCall.toolName)
                  ? (opts as any).toolsContext[opts.toolCall.toolName]
                  : undefined,
                effectiveAbortSignal,
              );
              const required = await awaitToolApprovalAbortable(
                () => (tool.needsApproval as any)(preparedInput, {
                  toolCallId,
                  messages: (opts as any).messages ?? [],
                  context,
                }),
                effectiveAbortSignal,
              );
              approval = required ? 'user-approval' : undefined;
            } else {
              approval = tool?.needsApproval ? 'user-approval' : undefined;
            }
          }
          if (executable) {
            const approvedInput = approvalOptions.toolCall.input;
            if (
              opts.toolCall.toolName === 'await_human'
              && areCompatiblePlainRecords(opts.toolCall.input, approvedInput)
            ) {
              // The streamed tool-call event already holds this object by
              // reference. Apply gate attachment edits in place so the log,
              // approval signature, and eventual execute observe one payload.
              Object.assign(opts.toolCall.input, approvedInput);
            }
            dispatcher.replaceLatestPreparedDirectCall(
              opts.toolCall.toolName,
              toolCallId,
              approvedInput,
            );
            const emitted = emittedToolCalls.get(toolCallId);
            if (emitted) emitted.toolInput = approvedInput;
            approvedToolInputOverrides.set(toolCallId, { executedInput: approvedInput });
          }
          if (effectiveAbortSignal?.aborted) {
            throw effectiveAbortSignal.reason ?? new Error('Tool approval aborted');
          }
          const status = approvalStatusType(approval);
          if (
            !historicalApproval
            && status === 'user-approval'
            && executable
            && opts.toolCall.toolName !== 'await_human'
          ) {
            if (manualGenericApprovalCallId && manualGenericApprovalCallId !== toolCallId) {
              const reason =
                `Tool '${opts.toolCall.toolName}' was denied because another tool call in this step ` +
                'already requires manual approval. Request this action again after that decision is resolved.';
              dispatcher.discardPreparedDirectCall(toolCallId);
              approvalInputLedger.discard(opts.toolCall.toolName, toolCallId, reservation);
              return { type: 'denied' as const, reason };
            }
            manualGenericApprovalCallId = toolCallId;
          }
          if (historicalApproval || status === 'user-approval' || status === 'approved') {
            // The provider/SDK approval signature is deliberately bound to the
            // post-plugin raw payload, while execute receives the canonical
            // schema result. Preserve both on AgentUse's audit projection;
            // `toolInput` stays the canonical value for existing consumers.
            const auditInput = approvedToolInputOverrides.get(toolCallId);
            if (auditInput) {
              auditInput.rawApprovedInput = effectiveRawInput;
              const emitted = emittedToolCalls.get(toolCallId);
              if (emitted) emitted.rawApprovedInput = effectiveRawInput;
            }
          }
          if (!historicalApproval && status === 'user-approval' && executable) {
            try {
              toolContract = await approvalToolContract(tool, opts.toolCall.toolName, effectiveAbortSignal);
              const canonicalDisplay = completeApprovalValueDisplay(preparedInput);
              const signedRawDisplay = completeApprovalValueDisplay(effectiveRawInput);
              approvalInputLedger.store(
                opts.toolCall.toolName,
                toolCallId,
                effectiveRawInput,
                preparedInput,
                Date.now(),
                toolContract,
                reservation,
              );
              const auditInput = approvedToolInputOverrides.get(toolCallId);
              if (auditInput) {
                auditInput.canonicalDisplay = canonicalDisplay;
                auditInput.signedRawDisplay = signedRawDisplay;
              }
            } catch (error) {
              dispatcher.discardPreparedDirectCall(toolCallId);
              // A duplicate call identity is denied, but its existing durable
              // record belongs to the first suspended approval and must remain
              // available for that approval's resume.
              if (!isDuplicateApprovalInputLedgerError(error)) approvalInputLedger.discard(opts.toolCall.toolName, toolCallId, reservation);
              if (error instanceof ApprovalInputLedgerError || error instanceof ApprovalToolContractError) {
                return { type: 'denied' as const, reason: error.message };
              }
              throw error;
            }
            if (opts.toolCall.toolName !== 'await_human') {
              opts.toolCall.input = effectiveRawInput;
            }
            // The initial SDK invocation will emit an approval request and stop.
            // A fresh invocation restores this value from the durable ledger.
            dispatcher.discardPreparedDirectCall(toolCallId);
            approvalInputLedger.release(reservation);
          } else if (status === 'denied') {
            dispatcher.discardPreparedDirectCall(toolCallId);
            approvalInputLedger.discard(opts.toolCall.toolName, toolCallId, reservation);
          } else if (!historicalApproval) {
            if (opts.toolCall.toolName !== 'await_human') opts.toolCall.input = effectiveRawInput;
            approvalInputLedger.release(reservation);
          }
          return approval;
        } catch (error) {
          dispatcher.discardPreparedDirectCall(toolCallId);
          approvalInputLedger.discard(opts.toolCall.toolName, toolCallId, reservation);
          throw error;
        }
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
  const emittedToolCalls = new Map<string, {
    toolInput: unknown;
    rawApprovedInput?: unknown;
  }>();
  const approvedToolInputOverrides = new Map<string, {
    /** Canonical schema value passed to execute and retained as `toolInput`. */
    executedInput: unknown;
    /** Signed post-plugin provider value, present only for approved calls. */
    rawApprovedInput?: unknown;
    /** Complete, tagged reviewer displays computed before JSON persistence. */
    canonicalDisplay?: CompleteApprovalValueDisplay;
    signedRawDisplay?: CompleteApprovalValueDisplay;
  }>();
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
  // One creator delivery recovery per run. The flag is active only for the
  // constrained stream where submit_agent_source is the sole available tool.
  let agentSourceSubmissionRecoverySpent = false;
  let agentSourceSubmissionRecoveryActive = false;
  let projectSuggestionsRecoverySpent = false;
  let projectSuggestionsRecoveryActive = false;
  // Whether the run has produced any visible prose yet, and whether prose from
  // here on is redundant (set only when the nudge fires on top of an existing
  // report). See the text-delta case.
  let sawText = false;
  let suppressTextAfterNudge = false;
  // Unlike the general doom-loop detector, this tracks outcomes rather than
  // exact call arguments. Models often vary option ids and prose while retrying
  // the same invalid gate, so argument equality cannot recognize the loop.
  let consecutiveGateMachineRejections = 0;
  const recordGateMachineRejection = (reason: string): GateMachineRejectionLoopError | undefined => {
    consecutiveGateMachineRejections++;
    return consecutiveGateMachineRejections >= MAX_CONSECUTIVE_GATE_MACHINE_REJECTIONS
      ? new GateMachineRejectionLoopError(consecutiveGateMachineRejections, reason)
      : undefined;
  };
  const resetGateMachineRejections = () => {
    consecutiveGateMachineRejections = 0;
  };
  // Stall retries across model steps. Reset as soon as the active step produces
  // output, so the budget covers one stall episode rather than the whole run.
  let stallAttempt = 0;
  // Transport-drop retries across model steps. Separate budget from the stall
  // one: a dropped connection and a silent provider are different failures and
  // one must not consume the other's attempts.
  let transportAttempt = 0;
  // Decide what a detected stall means: retry the active step from its prepared
  // input, or give up with an error that names the stall and attempt count.
  const classifyStall = (
    producedOutput: boolean
  ): { retry: true } | { retry: false; error: ModelStreamStallError } => {
    const failure = stallWatchdog?.failure ?? new ModelStreamStallError(0);
    const seconds = Math.round(failure.idleMs / 1000);
    if (!producedOutput && stallAttempt + 1 < MODEL_STALL_MAX_ATTEMPTS) {
      stallAttempt++;
      const delayMs = modelStallRetryDelayMs(stallAttempt);
      logger.warn(
        `Model stream stalled after ${seconds}s with no output; retrying ` +
        `in ${Math.round(delayMs / 100) / 10}s ` +
        `(attempt ${stallAttempt + 1} of ${MODEL_STALL_MAX_ATTEMPTS})`
      );
      return { retry: true };
    }
    const error = new ModelStreamStallError(failure.idleMs, stallAttempt + 1, failure.phase);
    logger.warn(`⚠️  ${error.message}`);
    return { retry: false, error };
  };
  // Decide what a mid-stream transport drop means. Same checkpoint contract as
  // a stall: the active step is safe to restart only while it has committed no
  // visible text and begun no tool call, so a retry can never double an effect.
  const classifyTransportDrop = (
    error: unknown,
    producedOutput: boolean
  ): { retry: true } | { retry: false; error: ModelStreamTransportError } => {
    const detail = toErrorMessage(error);
    if (!producedOutput && transportAttempt + 1 < MODEL_TRANSPORT_MAX_ATTEMPTS) {
      transportAttempt++;
      const delayMs = modelStallRetryDelayMs(transportAttempt);
      logger.warn(
        `Model stream connection dropped (${detail}); retrying ` +
        `in ${Math.round(delayMs / 100) / 10}s ` +
        `(attempt ${transportAttempt + 1} of ${MODEL_TRANSPORT_MAX_ATTEMPTS})`
      );
      return { retry: true };
    }
    const failure = new ModelStreamTransportError(detail, transportAttempt + 1);
    logger.warn(`⚠️  ${failure.message}`);
    return { retry: false, error: failure };
  };
  while (runAnotherSegment) {
    // Some retry paths continue directly from stream handling. This backstop
    // makes the terminal plugin policy apply to every prospective segment.
    if (pluginTerminateRequested) break;
  runAnotherSegment = false;
  let segmentFinishReason: string | undefined;
  segmentToolCalls.clear();
  emittedToolCalls.clear();
  approvedToolInputOverrides.clear();
  preparedStepInputs.length = 0;
  activeStepInput = undefined;
  activeStepProducedCommittedOutput = false;
  // Usage from completed steps in a stream that later stalls. The normal final
  // `finish` chunk is cumulative, but an aborted stream has no final total; fold
  // these settled steps into the next segment's cumulative usage explicitly.
  let completedStepUsageInSegment: any;
  // Set when the active step must be restarted from its checkpoint, holding the
  // attempt number that sets the backoff. A stall and a transport drop both
  // land here; the two carry their own budgets but share the recovery.
  let segmentRetryAttempt: number | undefined;

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
  const stalledStepState = (): { input: ModelMessage[]; producedOutput: boolean } => {
    // The SDK calls prepareStep before it emits start-step. If the provider then
    // stays completely silent, the pending checkpoint is the active call even
    // though the consumer has not seen its boundary marker yet.
    const pendingInput = preparedStepInputs[preparedStepInputs.length - 1];
    return pendingInput
      ? { input: pendingInput, producedOutput: false }
      : { input: activeStepInput ?? segmentInput, producedOutput: activeStepProducedCommittedOutput };
  };

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
      const isModelProgress = chunk.type === 'text-delta'
        || chunk.type === 'reasoning-delta'
        || chunk.type === 'tool-input-delta'
        || chunk.type === 'tool-call';
      stallWatchdog?.notify(isModelProgress);
      if (chunk.type === 'start-step') {
        activeStepInput = preparedStepInputs.shift() ?? activeStepInput ?? segmentInput;
        activeStepProducedCommittedOutput = false;
      }
      if (!activeStepProducedCommittedOutput && MODEL_COMMITTED_OUTPUT_CHUNK_TYPES.has(chunk.type)) {
        activeStepProducedCommittedOutput = true;
        stallAttempt = 0;
        transportAttempt = 0;
      }
      // A stall aborts only our per-attempt controller, so the SDK reports it as
      // a plain abort (or error) chunk. Claim it here, before the generic
      // handling below calls it an "execution timeout or manual cancellation".
      if (stallWatchdog?.stalled && !suspendState && (chunk.type === 'abort' || chunk.type === 'error')) {
        const stalledStep = stalledStepState();
        const decision = classifyStall(stalledStep.producedOutput);
        if (decision.retry) {
          messages = [...stalledStep.input];
          contextManager?.setMessages(messages);
          segmentRetryAttempt = stallAttempt;
          break;
        }
        yield { type: 'error', error: decision.error };
        return;
      }
      // Some providers report a dead socket as an error chunk rather than
      // throwing out of the iterator. Claim it before `case 'error'` yields it
      // as a run-ending verdict, since the connection dying says nothing about
      // the request.
      if (
        chunk.type === 'error'
        && !suspendState
        && !effectiveAbortSignal.aborted
        && isModelStreamTransportDrop((chunk as { error?: unknown }).error)
      ) {
        const droppedStep = stalledStepState();
        const decision = classifyTransportDrop((chunk as { error?: unknown }).error, droppedStep.producedOutput);
        if (decision.retry) {
          messages = [...droppedStep.input];
          contextManager?.setMessages(messages);
          segmentRetryAttempt = transportAttempt;
          break;
        }
        yield { type: 'error', error: decision.error };
        return;
      }
      switch (chunk.type) {
        case 'start-step':
          rawResponseMetadata = undefined;
          break;
        case 'raw':
          rawResponseMetadata = responseMetadataFromRaw(chunk.rawValue) ?? rawResponseMetadata;
          break;
        case 'tool-call': {
          // A model-stream idle window measures whether the provider can emit.
          // Tool execution is a separate phase and may legitimately exceed that
          // window (notably a delegated subagent), so leave it to the tool and
          // session timeouts until every in-flight tool has settled.
          stallWatchdog?.pause();
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
          const hasInputAudit = approvedToolInputOverrides.has(toolCallId);
          const inputAudit = approvedToolInputOverrides.get(toolCallId);
          // Map presence is significant: canonical transforms may deliberately
          // yield null, undefined, false, 0, or an empty string.
          const loggedInput = hasInputAudit
            ? inputAudit!.executedInput
            : Object.prototype.hasOwnProperty.call(chunk, 'input')
              ? (chunk as any).input
              : (chunk as any).args;
          toolStartTimes.set(toolCallId, startTime);
          lastToolCall = { id: toolCallId, name: chunk.toolName };
          segmentToolCalls.set(toolCallId, {
            tool: chunk.toolName ?? 'unknown',
            input: loggedInput,
            resolved: false,
          });

          const emittedToolCall = {
            type: 'tool-call',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolInput: loggedInput,
            ...(inputAudit && Object.prototype.hasOwnProperty.call(inputAudit, 'rawApprovedInput') && {
              rawApprovedInput: inputAudit.rawApprovedInput,
            }),
            toolStartTime: startTime,
            ...(options.subAgentNames?.has(chunk.toolName!) && { isSubAgent: true }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };
          emittedToolCalls.set(toolCallId, emittedToolCall as {
            toolInput: unknown;
            rawApprovedInput?: unknown;
          });
          yield emittedToolCall as any;
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
          const rawToolResult = stripInlineMediaData((chunk as any).result || (chunk as any).output);
          const machineGateSource = toolResultObject(rawToolResult)?.source;
          const gateLoopError = chunk.toolName === 'await_human' && machineGateSource === 'gate-preflight'
            ? recordGateMachineRejection(toolResultObject(rawToolResult)?.comment ?? toolResultStr)
            : undefined;
          if (!gateLoopError && machineGateSource !== 'gate-preflight' && toolSuccess) {
            resetGateMachineRejections();
          }

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
            toolResultRaw: rawToolResult,
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };

          if (gateLoopError) {
            runAbort.abort(gateLoopError);
            yield { type: 'error', error: gateLoopError };
            return;
          }

          // Clean up
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }

          if (toolStartTimes.size === 0) stallWatchdog?.resume();

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
          if (toolStartTimes.size === 0) stallWatchdog?.resume();
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
          logger.warn(`⚠️  Stream interrupted (${stepCount} steps completed)`);
          // Preserve explicit cancellation evidence; an SDK abort alone proves no deadline.
          const abortError = new Error('Stream interrupted; cancellation reason is unknown');
          abortError.name = 'AbortError';
          yield { type: 'error', error: effectiveAbortSignal.aborted ? (effectiveAbortSignal.reason ?? abortError) : abortError };
          return;

        // Handle other AI SDK chunk types that we don't need to process but shouldn't warn about
        case 'finish-step': {
          const responseMetadata = responseMetadataFromStep(chunk, rawResponseMetadata);
          rawResponseMetadata = undefined;
          const headers = chunk.response?.headers;
          const requestId = headers?.['x-request-id'] ?? headers?.['x-oai-request-id'];
          const requestFingerprint = requestId ? requestFingerprints.get(requestId) : undefined;
          if (requestId) requestFingerprints.delete(requestId);
          const { usage, usageKind } = usageFromStreamChunk(chunk);
          if (usage) {
            completedStepUsageInSegment = addLanguageModelUsage(completedStepUsageInSegment, usage);
          }
          if (contextManager && usage) {
            contextManager.updateUsage(usage, usageKind);
          }
          if (usage || contextManager || responseMetadata) {
            yield {
              type: 'usage',
              ...(requestFingerprint && { requestFingerprint }),
              ...(responseMetadata && { responseMetadata }),
              ...(usage && { usage }),
              ...(usageKind && { usageKind }),
              ...(contextManager && { contextUsage: contextManager.getStats() }),
            };
          }
          break;
        }
        case 'tool-approval-response':
        case 'tool-output-denied': {
          // A pre-dispatch decision blocked the call before execute ran. This
          // includes policy/lease denials and recoverable canonical-input
          // validation failures. The v7 stream carries the outcome as a
          // 'tool-approval-response' with approved:false and the reason;
          // journal it as a failed tool result so the session and next model
          // step both see what must change. Approved responses need no
          // journaling; the normal tool-call/-result path covers execution.
          if (chunk.type === 'tool-approval-response' && (chunk as any).approved !== false) break;
          const toolCall = (chunk as any).toolCall ?? chunk;
          const toolCallId = toolCall.toolCallId || (chunk as any).toolCallId || 'unknown';
          const toolName = toolCall.toolName || (chunk as any).toolName;
          const reason = typeof (chunk as any).reason === 'string'
            ? (chunk as any).reason
            : rejectedHistoricalToolCalls(messages).find((call) => call.toolCallId === toolCallId)?.reason
              ?? 'Execution denied before dispatch.';
          const gateLoopError = toolName === 'await_human'
            && reason.startsWith("Invalid input for tool 'await_human'")
            ? recordGateMachineRejection(reason)
            : undefined;
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;
          const deniedCall = segmentToolCalls.get(toolCallId);
          if (deniedCall) deniedCall.resolved = true;
          yield {
            type: 'tool-result',
            toolName,
            toolCallId,
            toolResult: JSON.stringify({ success: false, denied: true, error: reason }),
            toolResultRaw: { success: false, denied: true, reason },
            toolSuccess: false,
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration }),
            ...((suspendState || (gateBarrierActive && toolCallId !== gateBarrierCallId)) && { postSuspend: true })
          };
          if (gateLoopError) {
            runAbort.abort(gateLoopError);
            yield { type: 'error', error: gateLoopError };
            return;
          }
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }
          break;
        }

        case 'start':
        case 'tool-approval-request': {
          const requested = (chunk as any).toolCall ?? chunk;
          const toolCallId = requested.toolCallId ?? (chunk as any).toolCallId;
          const toolName = requested.toolName ?? (chunk as any).toolName;
          // The SDK also emits this event for callback decisions (`approved`
          // and `denied`). Those are automatic terminal paths, never a human
          // suspension.
          if (!(chunk as any).isAutomatic && toolCallId && toolName) {
            const approvalId = (chunk as any).approvalId;
            if (typeof approvalId !== 'string' || approvalId.length === 0) {
              yield { type: 'error', error: new Error(`Tool approval request for '${toolName}' is missing approvalId`) };
              break;
            }
            const signature = typeof (chunk as any).signature === 'string'
              ? (chunk as any).signature
              : undefined;
            const resumeToken = randomBytes(24).toString('base64url');
            const approvalUrl = getSessionUrl(options.sessionID);
            const signedRawInput = approvedToolInputOverrides.get(toolCallId)?.rawApprovedInput;
            const canonicalDisplay = approvedToolInputOverrides.get(toolCallId)?.canonicalDisplay;
            const signedRawDisplay = approvedToolInputOverrides.get(toolCallId)?.signedRawDisplay;
            // Generic SDK approvals do not throw our await_human suspend
            // signal. Surface an explicit transition so the consumer writes a
            // durable pending part before this stream ends.
            genericApprovalState = {
              toolCallId,
              toolName,
              payload: {
                kind: 'tool_approval',
                approvalId,
                toolCallId,
                toolName,
                ...(signature && { signature }),
                resumeToken,
                ...(approvalUrl && { approvalUrl }),
                ...(approvedToolInputOverrides.get(toolCallId)
                  && Object.prototype.hasOwnProperty.call(approvedToolInputOverrides.get(toolCallId)!, 'rawApprovedInput')
                  && { signedRawInput }),
                ...(canonicalDisplay && {
                  canonicalInputDisplay: canonicalDisplay.text,
                  canonicalInputDigest: canonicalDisplay.sha256,
                }),
                ...(signedRawDisplay && {
                  signedRawInputDisplay: signedRawDisplay.text,
                  signedRawInputDigest: signedRawDisplay.sha256,
                }),
                approvalRequest: {
                  type: 'tool-approval-request',
                  approvalId,
                  toolCallId,
                  ...(signature && { signature }),
                },
              },
            };
          }
          break;
        }
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
        case 'text-start':
        case 'text-end':
          // AI SDK streaming events for text generation boundaries (not tool-related)
          // These indicate when the LLM starts/stops generating text content.
          // tool-approval-request precedes the toolApproval decision; the
          // outcome is journaled via the denied response above or the normal
          // tool-call/-result path. Safe to ignore.
          break;

        default:
          logger.debug(`[STREAM] Unknown chunk type received: ${chunk.type}`);
          break;
      }
    }

    if (segmentRetryAttempt !== undefined) {
      // The active model step generated nothing. Its prepared input already
      // contains every settled assistant/tool turn from earlier steps, so the
      // next segment resumes there without replaying completed effects.
      if (completedStepUsageInSegment) {
        priorSegmentsUsage = addLanguageModelUsage(priorSegmentsUsage, completedStepUsageInSegment);
      }
      stallWatchdog?.dispose();
      stallWatchdog = undefined;
      await waitForModelStallRetry(segmentRetryAttempt, effectiveAbortSignal);
      runAnotherSegment = true;
      continue;
    }

    if (options.replay?.stopped()) return;

    // Unlike await_human, a generic AI SDK approval does not throw from tool
    // execution. Let the SDK close the segment so responseMessages contains the
    // exact assistant tool-call + approval-request turn, then snapshot that
    // unmodified turn and stop before compaction or any recovery segment.
    if (genericApprovalState) {
      try {
        messages = [...segmentInput, ...await accumulatedResponseMessages(stream)];
        contextManager?.setMessages(messages);
      } catch (error) {
        logger.debug(`Could not capture generic tool approval history: ${toErrorMessage(error)}`);
      }
      options.effectWal?.append({
        event: 'suspended',
        gateCallId: genericApprovalState.toolCallId,
        gateTool: genericApprovalState.toolName,
        turnToolCalls: [...segmentToolCalls.entries()].map(([id, call]) => ({
          callId: id,
          tool: call.tool,
          input: sanitizeWALInput(call.input),
          resolved: call.resolved,
        })),
      });
      const contextSnapshot = buildContextSnapshot();
      yield {
        type: 'suspended',
        toolName: genericApprovalState.toolName,
        toolCallId: genericApprovalState.toolCallId,
        suspend: { toolCallId: genericApprovalState.toolCallId },
        toolResultRaw: genericApprovalState.payload,
        ...(contextSnapshot && {
          contextUsage: contextSnapshot.usage,
          contextSnapshot,
        }),
      };
      return;
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
        messages = [...segmentInput, ...await accumulatedResponseMessages(stream)];
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

    // `terminate` is a run-level policy decision, not merely a stop condition
    // for the SDK's current step. Reconciliation above still records the
    // completed turn, but no compaction or structured-delivery recovery may
    // start another model segment afterward.
    if (pluginTerminateRequested) break;

    // A replay measures the first completed generation, not a synthesized
    // outcome or revision. Compaction may continue a still-active turn, but a
    // finished turn ends the test even without report_complete.
    if (options.replay) {
      if (runAnotherSegment) continue;
      return;
    }

    // Creator delivery recovery. Some smaller models correctly inspect and
    // author the project, then hallucinate that the schema-backed submission
    // tool is absent and declare the run incomplete without trying it. The
    // runtime knows the toolset authoritatively, so recover that narrow case in
    // the same conversation with only submit_agent_source exposed. Unrelated
    // report_incomplete reasons remain terminal and are never overwritten.
    const justRanAgentSourceRecovery = agentSourceSubmissionRecoveryActive;
    agentSourceSubmissionRecoveryActive = false;
    const incompleteReason = options.runOutcome?.incomplete?.reason ?? '';
    const falselyClaimedSubmissionUnavailable =
      incompleteReason.includes(SUBMIT_AGENT_SOURCE_TOOL) &&
      /(?:missing|unavailable|not (?:present|available|provided)|cannot (?:access|find|use)|can't (?:access|find|use)|environment)/i.test(incompleteReason);
    const canRecoverMissingAgentSource =
      !justRanAgentSourceRecovery &&
      !runAnotherSegment &&
      !suspendState &&
      !agentSourceSubmissionRecoverySpent &&
      !options.agentSourceSubmission?.source &&
      modelFacingTools[SUBMIT_AGENT_SOURCE_TOOL] !== undefined &&
      stepCount < options.maxSteps &&
      !['length', 'content-filter', 'error'].includes(segmentFinishReason ?? '') &&
      (!options.runOutcome?.incomplete || falselyClaimedSubmissionUnavailable);

    if (canRecoverMissingAgentSource) {
      try {
        messages = [...segmentInput, ...await accumulatedResponseMessages(stream)];
        messages.push({ role: 'user', content: SUBMIT_AGENT_SOURCE_NUDGE_PROMPT } as ModelMessage);
        contextManager?.setMessages(messages);
        if (falselyClaimedSubmissionUnavailable && options.runOutcome) {
          delete options.runOutcome.incomplete;
        }
        agentSourceSubmissionRecoverySpent = true;
        agentSourceSubmissionRecoveryActive = true;
        runAnotherSegment = true;
        logger.debug('Creator stopped without submitting source; forcing one schema-backed submission turn.');
      } catch (recoveryError) {
        logger.debug(`Agent source submission recovery skipped: ${(recoveryError as Error).message}`);
      }
    }

    // Project discovery uses the same structured-delivery guarantee as agent
    // creation. If the model stops after inspecting files without submitting,
    // give the existing conversation one constrained turn where the validated
    // suggestions tool is the only possible action.
    const justRanProjectSuggestionsRecovery = projectSuggestionsRecoveryActive;
    projectSuggestionsRecoveryActive = false;
    const projectSuggestionsFalselyUnavailable =
      incompleteReason.includes(SUBMIT_PROJECT_SUGGESTIONS_TOOL) &&
      /(?:missing|unavailable|not (?:present|available|provided)|cannot (?:access|find|use)|can't (?:access|find|use)|environment)/i.test(incompleteReason);
    const canRecoverMissingProjectSuggestions =
      !justRanProjectSuggestionsRecovery &&
      !runAnotherSegment &&
      !suspendState &&
      !projectSuggestionsRecoverySpent &&
      !options.projectSuggestionsSubmission?.result &&
      modelFacingTools[SUBMIT_PROJECT_SUGGESTIONS_TOOL] !== undefined &&
      stepCount < options.maxSteps &&
      !['length', 'content-filter', 'error'].includes(segmentFinishReason ?? '') &&
      (!options.runOutcome?.incomplete || projectSuggestionsFalselyUnavailable);

    if (canRecoverMissingProjectSuggestions) {
      try {
        messages = [...segmentInput, ...await accumulatedResponseMessages(stream)];
        messages.push({ role: 'user', content: SUBMIT_PROJECT_SUGGESTIONS_NUDGE_PROMPT } as ModelMessage);
        contextManager?.setMessages(messages);
        if (projectSuggestionsFalselyUnavailable && options.runOutcome) {
          delete options.runOutcome.incomplete;
        }
        projectSuggestionsRecoverySpent = true;
        projectSuggestionsRecoveryActive = true;
        runAnotherSegment = true;
        logger.debug('Discovery stopped without submitting suggestions; forcing one schema-backed submission turn.');
      } catch (recoveryError) {
        logger.debug(`Project suggestions submission recovery skipped: ${(recoveryError as Error).message}`);
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
      // Legacy resumed snapshots can omit outcome tools. Requiring a tool
      // call with an empty tool set is rejected by the SDK.
      (modelFacingTools[REPORT_COMPLETE_TOOL] !== undefined ||
        modelFacingTools[REPORT_INCOMPLETE_TOOL] !== undefined) &&
      // A plugin's terminal policy ends the run after the current SDK step.
      // Do not spend the reserved outcome-only segment afterward: it would
      // invoke the model again despite the explicit termination request.
      !stopOnPluginTerminate() &&
      shouldRequestOutcome({
        outcome: options.runOutcome,
        segmentFinishReason,
        stepCount,
        maxSteps: options.maxSteps,
        alreadyAsked: outcomeNudgeSpent,
        suspended: Boolean(suspendState),
        structuredDeliveryCompleted: Boolean(
          options.agentSourceSubmission?.source
          || options.projectSuggestionsSubmission?.result
        ),
      })
    ) {
      try {
        messages = [...segmentInput, ...await accumulatedResponseMessages(stream)];
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
    // Some providers throw the abort out of the iterator instead of emitting an
    // abort chunk; the stall verdict is the same either way.
    if (stallWatchdog?.stalled && !suspendState) {
      const stalledStep = stalledStepState();
      const decision = classifyStall(stalledStep.producedOutput);
      if (decision.retry) {
        messages = [...stalledStep.input];
        contextManager?.setMessages(messages);
        if (completedStepUsageInSegment) {
          priorSegmentsUsage = addLanguageModelUsage(priorSegmentsUsage, completedStepUsageInSegment);
        }
        stallWatchdog?.dispose();
        stallWatchdog = undefined;
        await waitForModelStallRetry(stallAttempt, effectiveAbortSignal);
        runAnotherSegment = true;
        continue;
      }
      yield { type: 'error', error: decision.error };
      return;
    }
    // A transport drop under a live stream: the request was accepted, bytes
    // were flowing, and the connection died underneath. That is not a model
    // verdict, and the SDK's own retry covers stream creation only, so without
    // this a socket blip ends the whole run (production: `TypeError:
    // terminated`, quora-engage-answer 2026-09-09, and 16 more in eight weeks).
    // Excluded by design: a run the caller cancelled, and a suspension drain,
    // where a dead socket is the intended consequence rather than a fault.
    if (isModelStreamTransportDrop(error) && !suspendState && !effectiveAbortSignal.aborted) {
      const droppedStep = stalledStepState();
      const decision = classifyTransportDrop(error, droppedStep.producedOutput);
      if (decision.retry) {
        messages = [...droppedStep.input];
        contextManager?.setMessages(messages);
        if (completedStepUsageInSegment) {
          priorSegmentsUsage = addLanguageModelUsage(priorSegmentsUsage, completedStepUsageInSegment);
        }
        stallWatchdog?.dispose();
        stallWatchdog = undefined;
        await waitForModelStallRetry(transportAttempt, effectiveAbortSignal);
        runAnotherSegment = true;
        continue;
      }
      yield { type: 'error', error: decision.error };
      return;
    }
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
    // Disarm the idle timer for this segment; a new one is armed by createStream.
    stallWatchdog?.dispose();
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
        lastSnapshot = { messages: finalMessages.length, tokens: stats.activeTokens };
      }
    } catch (err) {
      logger.debug(`Failed to persist end-of-run media context snapshot: ${(err as Error).message}`);
    }
  }

  } finally {
    // Land any debounced context snapshot before the run lets go. This is the
    // one path every ending shares — completion, suspension, cancellation and
    // provider failure all unwind through here — so a rest point is never left
    // with a snapshot that only existed in memory.
    await flushContextSnapshot();
    // Approval-lease cleanup belongs to executeAgentCore's logical segment,
    // which may span more than one provider attempt.
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

function toolResultObject(output: unknown): { source?: string; comment?: string } | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  const value = record.type === 'json' && record.value && typeof record.value === 'object' && !Array.isArray(record.value)
    ? record.value as Record<string, unknown>
    : record;
  return {
    ...(typeof value.source === 'string' && { source: value.source }),
    ...(typeof value.comment === 'string' && { comment: value.comment }),
  };
}

/**
 * Classify a nominally successful tool result that actually reads like a soft
 * failure (a tool that reports an error in its return value instead of
 * throwing). The normalized AgentChunk carries this classification so terminal
 * and session projections render the same single failed lifecycle.
 */
export function isSoftToolError(chunk: any, resultStr: string): boolean {
  if (!resultStr || typeof resultStr !== 'string') return false;
  // The results tool is a retrieval surface. Its payload may faithfully
  // contain an earlier tool's error text, which must not turn the successful
  // lookup into a second failed lifecycle. Actual results-tool failures throw.
  if (chunk.toolName === RESULTS_TOOL) return false;
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
