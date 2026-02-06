import { generateText } from 'ai';
import { createModel } from './models';
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

    // Use the agent's model to create summary
    const model = await createModel(modelString);

    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: COMPACTION_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: `Please summarize this agent context:\n\n${contextToSummarize}`
        }
      ],
      maxRetries: 2,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
      temperature: 0.3 // Lower temperature for more consistent summaries
    });

    // Return as a system message with the summary
    return {
      role: 'system',
      content: `[Context Summary]\n${text}\n[End Summary]`
    };
  } catch (error) {
    logger.error('Failed to compact messages', error as Error);
    
    // Fallback: create a simple summary
    const toolCalls = messages.filter(m => 
      m.role === 'assistant' && 
      typeof m.content !== 'string' &&
      Array.isArray(m.content) &&
      m.content.some((c: any) => 'toolName' in c)
    ).length;

    const fallbackSummary = `Previous context: ${messages.length} messages exchanged, ${toolCalls} tool calls made. Key information may have been lost due to compaction error.`;
    
    return {
      role: 'system',
      content: `[Context Summary - Fallback]\n${fallbackSummary}\n[End Summary]`
    };
  }
}