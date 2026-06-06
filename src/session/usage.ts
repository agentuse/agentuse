import type { LanguageModelUsage } from 'ai';
import type { Message } from './types';

type AssistantTokens = Message['assistant']['tokens'];

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
