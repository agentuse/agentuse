import { streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import { createHash } from 'crypto';
import type { ParsedAgent } from '../parser';
import { createModel } from '../models';
import { getModelFromRegistry } from '../generated/models';
import { CodexAuth } from '../auth/codex';
import { logger } from '../utils/logger';
import { ContextManager } from '../context-manager';
import { compactMessages } from '../compactor';
import { addLanguageModelUsage } from '../session/usage';
import type { AgentChunk } from './types';
import { isSuspendSignal } from './suspend';
import { recordErrorMarker } from './session-helper';
import { extractApiErrorDetail } from './api-error';
import type { CompactionReason, ModelToolOutputArtifactRef, SessionManager, ToolOutputArtifactRef } from '../session';
import { clampToolResultForModel } from '../tools/tool-output-limits.js';

// Constants
const MAX_RETRIES = 3;
const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' as const };
const OPENAI_CACHE_KEY_PREFIX = 'agentuse';
// Tokens reserved for the visible answer above the extended-thinking budget, so
// max_tokens stays comfortably greater than thinking.budget_tokens.
const ANTHROPIC_THINKING_ANSWER_RESERVE = 8192;

function isAnthropicModel(model: string): boolean {
  return model.split(':')[0] === 'anthropic';
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

function openAIOptionsWithCacheDefaults(agent: ParsedAgent): Record<string, unknown> {
  const configured = agent.config.openai ?? {};
  // Reasoning-capable models already generate (and bill) reasoning tokens; ask
  // for an `auto` summary by default so the reasoning is visible in the session
  // trace at ~no extra cost. Gate on the registry's reasoning flag: the
  // Responses API rejects reasoningSummary on non-reasoning models (gpt-4o), and
  // an unknown model is treated as non-reasoning (a broken run is worse than an
  // opt-in-able missing summary). Explicit user config always wins.
  const isReasoningModel = getModelFromRegistry(agent.config.model)?.reasoning === true;
  return {
    promptCacheKey: configured.promptCacheKey ?? defaultOpenAIPromptCacheKey(agent),
    ...(isReasoningModel && { reasoningSummary: 'auto' }),
    ...configured,
  };
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
  return applyAnthropicCacheControlToLastMessage(
    applyAnthropicCacheControlToMessages(messages)
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
  const errorMessage = error instanceof Error ? error.message : String(error);
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
export async function* executeAgentCore(
  agent: ParsedAgent,
  tools: ToolSet,
  options: {
    userMessage: string;
    cacheableUserMessage?: string | undefined;
    systemMessages: Array<{role: string, content: string}>;
    messages?: ModelMessage[];
    maxSteps: number;
    abortSignal?: AbortSignal;
    subAgentNames?: Set<string>;  // Track which tools are subagents
    sessionManager?: SessionManager;
    sessionID?: string;
    agentId?: string;
    messageID?: string;
  }
): AsyncGenerator<AgentChunk> {
  const model = await createModel(agent.config.model);

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
  const modelFacingTools = limitModelFacingToolOutputs(
    streamTools,
    buildToolOutputArtifactWriter(options)
  );

  if (ContextManager.isEnabled()) {
    contextManager = new ContextManager(
      agent.config.model,
      async (messagesToCompact) => compactMessages(messagesToCompact, agent.config.model)
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

  const compactAtSuspensionBoundary = async () => {
    if (!contextManager?.shouldCompactAtBoundary()) return;
    try {
      await compactActiveContext({ persist: false, reason: 'approval' });
    } catch (error) {
      logger.warn(`Approval-boundary context compaction failed; suspending with full active context.`);
      logger.debug(`Approval-boundary compaction error: ${(error as Error).message}`);
      // This failure is non-fatal (the run suspends with full context) so it
      // never reaches the run-level catch — surface it in the session log here.
      if (options.sessionManager && options.sessionID && options.agentId && options.messageID) {
        const apiDetail = extractApiErrorDetail(error);
        await recordErrorMarker(options.sessionManager, options.sessionID, options.agentId, options.messageID, {
          source: 'compaction',
          message: error instanceof Error ? error.message : String(error),
          ...(apiDetail?.detail !== undefined && { detail: apiDetail.detail }),
          ...(apiDetail?.statusCode !== undefined && { statusCode: apiDetail.statusCode }),
        });
      }
    }
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

  // Function to create stream with current messages
  const createStream = async () => {
    // Check if we need to compact before creating stream
    contextManager?.setMessages(messages);
    if (contextManager?.shouldCompact()) {
      messages = await compactActiveContext();
    }

    // Extract provider options based on model provider
    const provider = agent.config.model.split(':')[0];
    const isCustomProvider = !['anthropic', 'openai', 'openrouter', 'demo', 'bedrock'].includes(provider);

    // Claude extended thinking budget (opt-in). When set, max_tokens must exceed
    // the budget, so reserve headroom above it for the visible answer and clamp
    // to the model's output limit when known.
    const anthropicThinkingBudget = provider === 'anthropic'
      ? agent.config.anthropic?.thinking?.budgetTokens
      : undefined;
    const anthropicMaxOutputTokens = anthropicThinkingBudget
      ? Math.max(
          anthropicThinkingBudget + 1,
          Math.min(
            getModelFromRegistry(agent.config.model)?.limit?.output ?? Number.MAX_SAFE_INTEGER,
            anthropicThinkingBudget + ANTHROPIC_THINKING_ANSWER_RESERVE
          )
        )
      : undefined;

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
      maxRetries: MAX_RETRIES,
      toolChoice: 'auto' as const,
      stopWhen: contextManager
        ? [stepCountIs(remainingSteps), stopForCompaction]
        : stepCountIs(remainingSteps),
      ...(options.abortSignal && { abortSignal: options.abortSignal }),
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
      // Custom/local providers need explicit maxOutputTokens (local reasoning
      // models generate unlimited thinking tokens without it)
      ...(isCustomProvider && { maxOutputTokens: 16384 }),
      // Extended thinking requires max_tokens > budget; reserve answer headroom.
      ...(anthropicMaxOutputTokens && { maxOutputTokens: anthropicMaxOutputTokens }),
    };

    // Only add tools if there are any
    if (Object.keys(modelFacingTools).length > 0) {
      streamConfig.tools = modelFacingTools;
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
  let lastToolCall: { id: string; name?: string } | null = null;
  let llmGenerationStartTime: number | undefined;
  let llmFirstTokenTime: number | undefined;
  let currentModelStepStartedAt: number | undefined;
  const currentLlmModel = agent.config.model;
  let stepCount = 0; // Track step count to detect when we're approaching limit

  const buildContextSnapshot = () => {
    if (!contextManager) return undefined;
    const updatedAt = currentModelStepStartedAt ?? Date.now();
    const usage = { ...contextManager.getStats(), updatedAt };
    return {
      version: 1 as const,
      updatedAt,
      ...(options.messageID && { messageID: options.messageID }),
      messages: contextManager.getMessages(),
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
  while (runAnotherSegment) {
  runAnotherSegment = false;
  let segmentFinishReason: string | undefined;

  let stream;
  try {
    // Track when we start the LLM generation
    llmGenerationStartTime = Date.now();
    currentModelStepStartedAt = llmGenerationStartTime;
    yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };

    stream = await createStreamWithCompactionRetry();
  } catch (error: any) {
    // Handle initial stream creation errors
    const errorMessage = error?.message || String(error);

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

  try {
    for await (const chunk of stream.fullStream) {
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

          yield {
            type: 'tool-call',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolInput: (chunk as any).input || (chunk as any).args,
            toolStartTime: startTime,
            ...(options.subAgentNames?.has(chunk.toolName!) && { isSubAgent: true })
          };
          break;
        }

        case 'tool-result': {
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;

          // Parse once: parseToolResult is pure, and running it twice previously
          // emitted the soft-error warning twice for the same call.
          const toolResultStr = parseToolResult(chunk);
          warnOnSoftToolError(chunk, toolResultStr);

          // Track tool results in context
          if (contextManager) {
            // Use simple format for tool message
            const toolResultMessage: any = {
              role: 'tool',
              content: [{
                type: 'tool-result',
                toolCallId,
                toolName: chunk.toolName,
                output: toolResultStr
              }]
            };
            contextManager.addMessage(toolResultMessage);
          }

          yield {
            type: 'tool-result',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolResult: toolResultStr,
            toolResultRaw: (chunk as any).result || (chunk as any).output,
            ...(startTime && { toolStartTime: startTime }),
            ...(duration !== undefined && { toolDuration: duration })
          };

          // Clean up
          if (startTime) {
            toolStartTimes.delete(toolCallId);
          }

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

          if (isSuspendSignal(chunkError)) {
            await compactAtSuspensionBoundary();
            const contextSnapshot = buildContextSnapshot();
            yield {
              type: 'suspended',
              ...(chunk.toolName && { toolName: chunk.toolName }),
              ...(toolCallId && { toolCallId }),
              ...(toolCallId && { suspend: { toolCallId } }),
              toolResultRaw: chunkError.payload,
              ...(contextSnapshot && {
                contextUsage: contextSnapshot.usage,
                contextSnapshot,
              })
            };
            return;
          }

          // Pass tool errors as structured results to let AI decide on retry
          const errorMessage = chunkError?.message || chunkError || 'Unknown error';
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
            ...(duration !== undefined && { toolDuration: duration })
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
            // Track time to first token
            if (!llmFirstTokenTime && llmGenerationStartTime) {
              llmFirstTokenTime = Date.now();
              yield { type: 'llm-first-token', llmFirstTokenTime };
            }
            accumulatedText += textContent;
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

          // Log finish reason for debugging and warnings
          const finishReason = chunk.finishReason;
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
          yield { type: 'error', error: chunk.error };
          break;

        case 'abort':
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
        case 'start-step':
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
        case 'text-start':
        case 'text-end':
          // AI SDK streaming events for text generation boundaries (not tool-related)
          // These indicate when the LLM starts/stops generating text content
          // Safe to ignore as they don't require processing
          break;

        default:
          logger.debug(`[STREAM] Unknown chunk type received: ${chunk.type}`);
          break;
      }
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
          messages = await compactActiveContext({ reason: 'limit' }) as any[];
          // Only restart if compaction actually reduced the context. If it
          // no-ops (nothing left to fold), restarting would spin forever; let
          // the run end and the next createStream's hard-limit retry cope.
          runAnotherSegment = contextManager.getStats().compactions > compactionsBefore;
        }
      } catch (reconcileError) {
        logger.debug(`Segment compaction check failed: ${(reconcileError as Error).message}`);
      }
    }

  } catch (error: any) {
    if (isSuspendSignal(error)) {
      await compactAtSuspensionBoundary();
      const contextSnapshot = buildContextSnapshot();
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
    const errorMessage = error?.message || String(error);
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
  }
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
 * Emit a single operational warning when a *successful* tool result actually
 * reads like a soft failure (a tool that reports an error in its return value
 * instead of throwing). Patterns are anchored to the result's first non-empty
 * line so incidental keywords buried in long output (scraped pages, bash/JS
 * scripts) don't trip a false "failed" warning. Call this exactly once per
 * tool-result chunk: parseToolResult is pure and may run more than once.
 */
export function warnOnSoftToolError(chunk: any, resultStr: string): void {
  if (!resultStr || typeof resultStr !== 'string') return;
  // Skill content often documents errors (e.g. "not found" troubleshooting), so
  // it would always trip the heuristic; skip it.
  if (chunk.toolName === 'tools__skill_load' || chunk.toolName === 'tools__skill_read') return;

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
  if (!errorPatterns.some((pattern) => pattern.test(firstLine))) return;

  // Best-effort context for the warning: the command/file/action the error names.
  let operation = 'operation';
  const commandMatch = firstLine.match(/['"`]([^'"`]+)['"`]/);
  const fileMatch = firstLine.match(/(?:file|path|directory)\s+['"`]?([^\s'"`]+)/i);
  const actionMatch = firstLine.match(/(?:failed to|cannot|unable to)\s+(\w+)/i);
  if (commandMatch) operation = commandMatch[1];
  else if (fileMatch) operation = fileMatch[1];
  else if (actionMatch) operation = actionMatch[1];

  logger.warnWithTool(chunk.toolName || 'unknown', operation, resultStr, chunk.toolCallId);
}
