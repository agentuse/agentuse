import { streamText, stepCountIs, type ToolSet } from 'ai';
import type { ParsedAgent } from '../parser';
import { createModel, AuthenticationError } from '../models';
import { CodexAuth } from '../auth/codex';
import { logger } from '../utils/logger';
import { ContextManager } from '../context-manager';
import { compactMessages } from '../compactor';
import type { AgentChunk } from './types';

// Constants
const MAX_RETRIES = 3;

/**
 * Core agent execution as an async generator
 */
export async function* executeAgentCore(
  agent: ParsedAgent,
  tools: ToolSet,
  options: {
    userMessage: string;
    systemMessages: Array<{role: string, content: string}>;
    maxSteps: number;
    abortSignal?: AbortSignal;
    subAgentNames?: Set<string>;  // Track which tools are subagents
  }
): AsyncGenerator<AgentChunk> {
  let model;
  try {
    model = await createModel(agent.config.model);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      // Re-throw with better message for the CLI to catch
      throw error;
    }
    throw error;
  }

  // Initialize context manager if enabled
  let contextManager: ContextManager | null = null;
  const initialMessages: any[] = [
    ...options.systemMessages,
    { role: 'user', content: options.userMessage }
  ];
  let messages = initialMessages;

  if (ContextManager.isEnabled()) {
    contextManager = new ContextManager(
      agent.config.model,
      async (messagesToCompact) => compactMessages(messagesToCompact, agent.config.model)
    );
    await contextManager.initialize();

    // Track initial messages
    for (const msg of messages) {
      contextManager.addMessage(msg);
    }
  }

  // Function to create stream with current messages
  const createStream = async () => {
    // Check if we need to compact before creating stream
    if (contextManager?.shouldCompact()) {
      messages = await contextManager.compact();
    }

    // Extract provider options based on model provider
    const provider = agent.config.model.split(':')[0];

    // Only include provider options if they exist and match the model provider
    let providerOptions: any = undefined;
    if (provider === 'openai') {
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
            ...agent.config.openai
          }
        };
      } else if (agent.config.openai) {
        // Regular OpenAI API key - only pass custom config if provided
        providerOptions = { openai: agent.config.openai };
      }
    }
    // Future: Add other providers here
    // if (provider === 'anthropic' && agent.config.anthropic) {
    //   providerOptions = { anthropic: agent.config.anthropic };
    // }

    const streamConfig: any = {
      model,
      messages,
      maxRetries: MAX_RETRIES,
      toolChoice: 'auto' as const,
      stopWhen: stepCountIs(options.maxSteps),
      ...(options.abortSignal && { abortSignal: options.abortSignal }),
      ...(providerOptions && { providerOptions })
    };

    // Only add tools if there are any
    if (Object.keys(tools).length > 0) {
      streamConfig.tools = tools;
    }

    return streamText(streamConfig);
  };

  // Declare timing variables before use
  let accumulatedText = '';
  const toolStartTimes = new Map<string, number>();
  let llmGenerationStartTime: number | undefined;
  let llmFirstTokenTime: number | undefined;
  const currentLlmModel = agent.config.model;
  let stepCount = 0; // Track step count to detect when we're approaching limit

  let stream;
  try {
    // Track when we start the LLM generation
    llmGenerationStartTime = Date.now();
    yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };

    stream = await createStream();
  } catch (error: any) {
    // Handle initial stream creation errors
    const errorMessage = error?.message || String(error);
    const errorLower = errorMessage.toLowerCase();

    // Check for token limit errors
    if (
      errorLower.includes('context_length_exceeded') ||
      errorLower.includes('context length') ||
      errorLower.includes('maximum context') ||
      errorLower.includes('token limit') ||
      errorLower.includes('context window') ||
      errorLower.includes('too many tokens')
    ) {
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

          // Track tool results in context
          if (contextManager) {
            // Use simple format for tool message
            const toolResultMessage: any = {
              role: 'tool',
              content: [{
                type: 'tool-result',
                toolCallId,
                toolName: chunk.toolName,
                output: parseToolResult(chunk)
              }]
            };
            contextManager.addMessage(toolResultMessage);
          }

          yield {
            type: 'tool-result',
            toolName: chunk.toolName,
            toolCallId,  // Add toolCallId to the chunk
            toolResult: parseToolResult(chunk),
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
          llmFirstTokenTime = undefined;
          yield { type: 'llm-start', llmModel: currentLlmModel, llmStartTime: llmGenerationStartTime };
          break;
        }

        case 'tool-error': {
          const toolCallId = (chunk as any).toolCallId || 'unknown';
          const startTime = toolStartTimes.get(toolCallId);
          const duration = startTime ? Date.now() - startTime : undefined;

          // Pass tool errors as structured results to let AI decide on retry
          const errorMessage = (chunk as any).error?.message || (chunk as any).error || 'Unknown error';
          yield {
            type: 'tool-result',  // Treat as result so AI sees it
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

        case 'finish':
          // Track the assistant's message
          if (contextManager && accumulatedText) {
            const assistantMessage: any = {
              role: 'assistant',
              content: accumulatedText
            };
            contextManager.addMessage(assistantMessage);
            accumulatedText = '';
          }

          // Update usage if available
          const usage = (chunk as any).totalUsage || (chunk as any).usage;
          if (contextManager && usage) {
            contextManager.updateUsage(usage);
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
              usage,
              toolStartTime: llmGenerationStartTime,
              toolDuration: llmDuration
            };
            llmGenerationStartTime = undefined;
            llmFirstTokenTime = undefined;
          } else {
            yield {
              type: 'finish',
              finishReason: chunk.finishReason,
              usage
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
        case 'finish-step':
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

  } catch (error: any) {
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

  const resultStr = typeof output === 'string' ? output : JSON.stringify(output);

  // Detect if the result looks like an error message
  // Skip error detection for skill tools since skill content often contains
  // documentation about errors (e.g., "not found" troubleshooting guides)
  const isSkillTool = chunk.toolName === 'tools__skill_load' || chunk.toolName === 'tools__skill_read';

  if (resultStr && typeof resultStr === 'string' && !isSkillTool) {
    const errorPatterns = [
      /^Error:/i,
      /^Error executing/i,
      /^Failed to/i,
      /authentication.*failed/i,
      /unauthorized/i,
      /permission denied/i,
      /not found/i,
      /invalid.*token/i,
      /invalid.*api.*key/i
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(resultStr)) {
        // Extract operation from error message or use generic "operation"
        let operation = 'operation';

        // Try to extract operation context from error message
        const commandMatch = resultStr.match(/['"`]([^'"`]+)['"`]/);
        const fileMatch = resultStr.match(/(?:file|path|directory)\s+['"`]?([^\s'"`]+)/i);
        const actionMatch = resultStr.match(/(?:failed to|cannot|unable to)\s+(\w+)/i);

        if (commandMatch) {
          operation = commandMatch[1];
        } else if (fileMatch) {
          operation = fileMatch[1];
        } else if (actionMatch) {
          operation = actionMatch[1];
        }

        logger.warnWithTool(chunk.toolName || 'unknown', operation, resultStr);
        break;
      }
    }
  }

  return resultStr;
}
