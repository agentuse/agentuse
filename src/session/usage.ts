import type { LanguageModelUsage } from 'ai';
import type { ActiveContextUsage, ContextSnapshot, Message } from './types';

type AssistantTokens = Message['assistant']['tokens'];
const DEFAULT_CHARS_PER_TOKEN = 4;

function tokenCount(value: number | undefined): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * Convert AI SDK usage into the token shape persisted in session storage.
 *
 * The AI SDK normalizes provider-specific cache accounting:
 * - Anthropic: cache_read_input_tokens / cache_creation_input_tokens
 * - OpenAI: input_tokens_details.cached_tokens / prompt_tokens_details.cached_tokens
 */
export function usageToAssistantTokens(usage: LanguageModelUsage): AssistantTokens {
  return {
    input: tokenCount(usage.inputTokens),
    output: tokenCount(usage.outputTokens),
    reasoning: tokenCount(usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens),
    cache: {
      read: tokenCount(usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens),
      write: tokenCount(usage.inputTokenDetails?.cacheWriteTokens),
    },
  };
}

export function addLanguageModelUsage(
  left: LanguageModelUsage | undefined,
  right: LanguageModelUsage
): LanguageModelUsage {
  const leftInputDetails = left?.inputTokenDetails;
  const rightInputDetails = right.inputTokenDetails;
  const leftOutputDetails = left?.outputTokenDetails;
  const rightOutputDetails = right.outputTokenDetails;
  return {
    inputTokens: tokenCount(left?.inputTokens) + tokenCount(right.inputTokens),
    outputTokens: tokenCount(left?.outputTokens) + tokenCount(right.outputTokens),
    totalTokens: tokenCount(left?.totalTokens) + tokenCount(right.totalTokens),
    ...(left?.reasoningTokens !== undefined || right.reasoningTokens !== undefined
      ? { reasoningTokens: tokenCount(left?.reasoningTokens) + tokenCount(right.reasoningTokens) }
      : {}),
    ...(left?.cachedInputTokens !== undefined || right.cachedInputTokens !== undefined
      ? { cachedInputTokens: tokenCount(left?.cachedInputTokens) + tokenCount(right.cachedInputTokens) }
      : {}),
    inputTokenDetails: {
      noCacheTokens: tokenCount(leftInputDetails?.noCacheTokens) + tokenCount(rightInputDetails?.noCacheTokens),
      cacheReadTokens: tokenCount(leftInputDetails?.cacheReadTokens) + tokenCount(rightInputDetails?.cacheReadTokens),
      cacheWriteTokens: tokenCount(leftInputDetails?.cacheWriteTokens) + tokenCount(rightInputDetails?.cacheWriteTokens),
    },
    outputTokenDetails: {
      textTokens: tokenCount(leftOutputDetails?.textTokens) + tokenCount(rightOutputDetails?.textTokens),
      reasoningTokens: tokenCount(leftOutputDetails?.reasoningTokens) + tokenCount(rightOutputDetails?.reasoningTokens),
    },
  };
}

function modelMessageToString(message: unknown): string {
  if (!message || typeof message !== 'object') return String(message ?? '');
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text ?? '');
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(' ');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? '');
  }
}

function estimateModelMessageTokens(message: unknown): number {
  return Math.ceil(modelMessageToString(message).length / DEFAULT_CHARS_PER_TOKEN);
}

export function contextUsageFromSnapshot(snapshot: ContextSnapshot | null | undefined): ActiveContextUsage | undefined {
  if (!snapshot?.usage) return undefined;
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return snapshot.usage;

  const activeTokens = snapshot.messages.reduce<number>((sum, message) => sum + estimateModelMessageTokens(message), 0);
  const contextLimit = snapshot.usage.contextLimit;
  return {
    ...snapshot.usage,
    activeTokens,
    usagePercentage: typeof contextLimit === 'number' && contextLimit > 0
      ? (activeTokens / contextLimit) * 100
      : snapshot.usage.usagePercentage,
  };
}
