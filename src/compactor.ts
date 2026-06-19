import { completeText } from './complete-text';
import { logger } from './utils/logger';

// Use any for message type to avoid complex type issues
type ModelMessage = any;

// Constants
const MAX_SUMMARY_TOKENS = 2000;
const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Summarize the following agent context concisely, preserving:
1. Key decisions and outcomes
2. Important tool results and errors
3. Current state and progress
4. Any critical information needed for continuation

Be concise but comprehensive. Output a single summary that captures the essence of the conversation.`;

/**
 * Compact messages into a summary using the agent's model
 */
export async function compactMessages(
  messages: ModelMessage[],
  modelString: string
): Promise<ModelMessage> {
  try {
    // Prepare messages for summarization
    const contextToSummarize = messages.map(msg => {
      const role = msg.role;
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      return `${role}: ${content}`;
    }).join('\n\n');

    // Use the agent's model to create the summary. streamText (not
    // generateText) so this works on the ChatGPT Codex backend, which only
    // accepts streaming requests and requires the instructions field.
    const text = await completeText(modelString, {
      system: COMPACTION_SYSTEM_PROMPT,
      prompt: `Please summarize this agent context:\n\n${contextToSummarize}`,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
      maxRetries: 2,
    });

    // Return as a system message with the summary
    return {
      role: 'system',
      content: `[Context Summary]\n${text}\n[End Summary]`
    };
  } catch (error) {
    // A failed compaction must surface, not be papered over with a fabricated
    // summary: returning fake context silently corrupts the agent's state.
    logger.error('Failed to compact messages', error as Error);
    throw error;
  }
}