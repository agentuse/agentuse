import { streamText, stepCountIs, type ToolSet, type LanguageModelUsage } from 'ai';
import type { ParsedAgent } from './parser';
import type { MCPConnection } from './mcp';
import { getMCPTools } from './mcp';
import { createSubAgentTools } from './subagent';
import { createModel } from './models';
import { AnthropicAuth } from './auth/anthropic';
import { logger } from './utils/logger';

// Constants
const MAX_RETRIES = 3;
const DEFAULT_MAX_STEPS = 1000;

/**
 * Build autonomous agent system prompt
 */
export function buildAutonomousAgentPrompt(todayDate: string, isSubAgent: boolean = false): string {
  const basePrompt = `You are an autonomous AI agent outputting to CLI/terminal. When given a task:
- Break it down into clear steps
- Execute each step thoroughly
- Be extremely concise - use minimal words, focus only on essential information
- Skip explanations unless specifically requested
- Show results, not process
- Don't announce tool usage - just use them
- Format output for terminal readability: use bullets (•), arrows (→), moderate emojis, and 2-space indentation for hierarchy
- Keep lines short for terminal display
- Iterate until the task is fully complete`;

  const subAgentAddition = isSubAgent ? '\n- Provide only essential summary when complete' : '';
  
  return `${basePrompt}${subAgentAddition}

Today's date: ${todayDate}`;
}

export interface AgentChunk {
  type: 'text' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  toolResultRaw?: unknown;
  error?: unknown;
  finishReason?: string;
  usage?: LanguageModelUsage;
}

/**
 * Process agent stream chunks and handle output/logging
 */
export async function processAgentStream(
  generator: AsyncGenerator<AgentChunk>,
  options?: {
    collectToolCalls?: boolean;
    logPrefix?: string;
  }
): Promise<{
  text: string;
  usage?: LanguageModelUsage;
  toolCalls?: Array<{ tool: string; args: unknown }>;
  subAgentTokens?: number;
}> {
  let finalText = '';
  let usage: LanguageModelUsage | null = null;
  const toolCalls: Array<{ tool: string; args: unknown }> = [];
  let subAgentTokens = 0;
  
  for await (const chunk of generator) {
    switch (chunk.type) {
      case 'text':
        finalText += chunk.text!;
        logger.response(chunk.text!);
        break;
        
      case 'tool-call':
        logger.tool(chunk.toolName!, chunk.toolInput);
        if (options?.collectToolCalls) {
          toolCalls.push({ tool: chunk.toolName!, args: chunk.toolInput });
        }
        break;
        
      case 'tool-result':
        logger.tool(chunk.toolName!, undefined, chunk.toolResult);
        // Extract sub-agent token usage from metadata if present
        if (chunk.toolResultRaw && typeof chunk.toolResultRaw === 'object') {
          const rawResult = chunk.toolResultRaw as Record<string, unknown>;
          if (rawResult.metadata && typeof rawResult.metadata === 'object') {
            const metadata = rawResult.metadata as Record<string, unknown>;
            if (typeof metadata.tokensUsed === 'number') {
              subAgentTokens += metadata.tokensUsed;
            }
          }
        }
        break;
        
      case 'tool-error':
        // Tool errors are now passed as tool-result in executeAgentCore
        // This case shouldn't occur but keep for safety
        const prefix = options?.logPrefix || '';
        logger.warn(`${prefix}Tool call failed: ${chunk.toolName} - ${chunk.error}`);
        break;
        
      case 'finish':
        usage = chunk.usage || null;
        if (finalText.trim()) {
          logger.responseComplete();
        }
        break;
        
      case 'error':
        throw chunk.error;
    }
  }
  
  return {
    text: finalText,
    ...(usage && { usage }),
    ...(options?.collectToolCalls && { toolCalls }),
    ...(subAgentTokens > 0 && { subAgentTokens })
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
    systemMessages: Array<{role: string, content: string}>;
    maxSteps: number;
    abortSignal?: AbortSignal;
  }
): AsyncGenerator<AgentChunk> {
  const model = await createModel(agent.config.model);
  
  const streamConfig = {
    model,
    messages: [
      ...options.systemMessages,
      { role: 'user' as const, content: options.userMessage }
    ],
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxRetries: MAX_RETRIES,
    toolChoice: 'auto' as const,
    stopWhen: stepCountIs(options.maxSteps),
    ...(options.abortSignal && { abortSignal: options.abortSignal })
  };
  
  const stream = streamText(streamConfig);
  
  for await (const chunk of stream.fullStream) {
    switch (chunk.type) {
      case 'tool-call':
        yield {
          type: 'tool-call',
          toolName: chunk.toolName,
          toolInput: (chunk as any).input || (chunk as any).args
        };
        break;
        
      case 'tool-result':
        yield {
          type: 'tool-result',
          toolName: chunk.toolName,
          toolResult: parseToolResult(chunk),
          toolResultRaw: (chunk as any).result || (chunk as any).output  // Keep raw result for metadata
        };
        break;
        
      case 'tool-error':
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
          toolResultRaw: { error: errorMessage }
        };
        break;
        
      case 'text-delta':
        const textContent = (chunk as any).text || (chunk as any).textDelta || (chunk as any).delta || (chunk as any).content;
        if (textContent && typeof textContent === 'string') {
          yield { type: 'text', text: textContent };
        }
        break;
        
      case 'finish':
        yield {
          type: 'finish',
          finishReason: chunk.finishReason,
          usage: (chunk as any).totalUsage || (chunk as any).usage
        };
        break;
        
      case 'error':
        yield { type: 'error', error: chunk.error };
        break;
    }
  }
}

/**
 * Classify error type for intelligent retry decisions
 */
function classifyError(error: string): string {
  const errorLower = error.toLowerCase();
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
  if (resultStr && typeof resultStr === 'string') {
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
        logger.warn(`Tool result appears to be an error: ${chunk.toolName}`);
        break;
      }
    }
  }
  
  return resultStr;
}

/**
 * Run an agent with AI and MCP tools
 * @param agent Parsed agent configuration
 * @param mcpClients Connected MCP clients
 * @param debug Enable debug logging
 * @param abortSignal Optional abort signal for cancellation
 * @param startTime Optional start time for timing
 * @param verbose Enable verbose logging
 * @param agentFilePath Optional path to the agent file for resolving sub-agent paths
 */
export async function runAgent(
  agent: ParsedAgent, 
  mcpClients: MCPConnection[], 
  _debug: boolean = false, 
  abortSignal?: AbortSignal, 
  startTime?: number, 
  verbose: boolean = false,
  agentFilePath?: string
): Promise<void> {
  try {
    // Check if we're using OAuth (for system prompt modification)
    const isUsingOAuth = agent.config.model.includes('anthropic') && await AnthropicAuth.access();
    
    // Convert MCP tools to AI SDK format
    const mcpTools = await getMCPTools(mcpClients);
    
    // Load sub-agent tools if configured
    // If we have an agent file path, use its directory as the base path for sub-agents
    const basePath = agentFilePath ? require('path').dirname(agentFilePath) : undefined;
    const subAgentTools = await createSubAgentTools(agent.config.subagents, basePath);
    
    // Merge all tools
    const tools = { ...mcpTools, ...subAgentTools };
    
    logger.info(`Running agent with model: ${agent.config.model}`);
    if (Object.keys(tools).length > 0) {
      logger.info(`Available tools: ${Object.keys(tools).join(', ')}`);
    }
    
    // Log initialization time if verbose
    if (verbose && startTime) {
      const initTime = Date.now() - startTime;
      logger.info(`Initialization completed in ${initTime}ms`);
    }
    
    // Add today's date and autonomous agent instructions to system prompt
    const todayDate = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    // Build system messages array (like OpenCode does)
    const systemMessages: Array<{role: string, content: string}> = [];
    
    // For Anthropic, add the Claude Code prompt as FIRST system message (exact text from OpenCode)
    if (agent.config.model.includes('anthropic')) {
      systemMessages.push({
        role: 'system',
        content: 'You are Claude Code, Anthropic\'s official CLI for Claude.'  // Exact text, no changes
      });
      
      logger.debug("Using Anthropic system prompt: You are Claude Code...");
      if (isUsingOAuth) {
        logger.debug("Authentication: OAuth token");
      }
    }
    
    // Add main system prompt as second message
    systemMessages.push({
      role: 'system', 
      content: buildAutonomousAgentPrompt(todayDate, false)
    });

    // Execute using the core generator
    const coreOptions = {
      userMessage: agent.instructions,
      systemMessages,
      maxSteps: parseInt(process.env.MAX_STEPS || String(DEFAULT_MAX_STEPS)),
      ...(abortSignal && { abortSignal })
    };
    
    const result = await processAgentStream(
      executeAgentCore(agent, tools, coreOptions)
    );
    
    if (!result.text.trim()) {
      logger.warn('No final response generated by the model');
    }
    
    // Display token usage
    if (result.usage || result.subAgentTokens) {
      const mainTokens = result.usage?.totalTokens || 0;
      const subTokens = result.subAgentTokens || 0;
      const totalTokens = mainTokens + subTokens;
      
      if (subTokens > 0) {
        logger.info(`Tokens used: ${totalTokens} (main: ${mainTokens}, sub-agents: ${subTokens})`);
      } else if (mainTokens > 0) {
        logger.info(`Tokens used: ${mainTokens}`);
      }
    }
  } catch (error: unknown) {
    // Check if it's an abort error from timeout
    if ((error instanceof Error && error.name === 'AbortError') || (abortSignal && abortSignal.aborted)) {
      // Timeout already handled by caller
      throw error;
    }
    logger.error('Agent execution failed', error as Error);
    throw error;
  } finally {
    // Clean up MCP clients (like opencode does)
    for (const connection of mcpClients) {
      try {
        await connection.client.close();
        if (connection.rawClient) {
          await connection.rawClient.close();
        }
        logger.debug(`Closed MCP client: ${connection.name}`);
      } catch (error) {
        // Ignore errors when closing MCP clients
      }
    }
  }
}