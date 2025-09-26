import { streamText, stepCountIs, type ToolSet, type LanguageModelUsage } from 'ai';
import type { ParsedAgent } from './parser';
import type { MCPConnection } from './mcp';
import { getMCPTools } from './mcp';
import { createSubAgentTools } from './subagent';
import { createModel, AuthenticationError } from './models';
import { AnthropicAuth } from './auth/anthropic';
import { logger } from './utils/logger';
import { ContextManager } from './context-manager';
import { compactMessages } from './compactor';
import { dirname } from 'path';
import type { ToolCallTrace } from './plugin/types';

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
  type: 'text' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'error' | 'llm-start' | 'llm-first-token';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  toolResultRaw?: unknown;
  error?: unknown;
  finishReason?: string;
  usage?: LanguageModelUsage;
  toolStartTime?: number;  // Track when tool started
  toolDuration?: number;    // Duration in ms
  isSubAgent?: boolean;     // Track if this tool is a subagent
  llmModel?: string;        // Model name for LLM traces
  llmStartTime?: number;    // When LLM call started
  llmFirstTokenTime?: number; // Time to first token
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
  toolCallTraces?: ToolCallTrace[];
}> {
  let finalText = '';
  let usage: LanguageModelUsage | null = null;
  const toolCalls: Array<{ tool: string; args: unknown }> = [];
  let subAgentTokens = 0;
  const toolCallTraces: ToolCallTrace[] = [];
  const pendingToolCalls = new Map<string, { name: string; startTime: number }>();
  let currentLlmCall: { model: string; startTime: number; firstTokenTime?: number } | null = null;
  let llmSegmentCount = 0;
  
  for await (const chunk of generator) {
    switch (chunk.type) {
      case 'text':
        finalText += chunk.text!;
        logger.response(chunk.text!);
        break;
        
      case 'llm-start':
        // Track the start of an LLM generation
        if (chunk.llmModel && chunk.llmStartTime) {
          currentLlmCall = {
            model: chunk.llmModel,
            startTime: chunk.llmStartTime
          };
          llmSegmentCount++;
        }
        break;
        
      case 'llm-first-token':
        // Track time to first token
        if (currentLlmCall && chunk.llmFirstTokenTime) {
          currentLlmCall.firstTokenTime = chunk.llmFirstTokenTime;
        }
        break;
        
      case 'tool-call':
        logger.tool(chunk.toolName!, chunk.toolInput, undefined, chunk.isSubAgent);
        if (options?.collectToolCalls) {
          toolCalls.push({ tool: chunk.toolName!, args: chunk.toolInput });
        }
        // Store the start time for this tool call
        if (chunk.toolName && chunk.toolStartTime) {
          const key = `${chunk.toolName}_${chunk.toolStartTime}`;
          pendingToolCalls.set(key, { name: chunk.toolName, startTime: chunk.toolStartTime });
        }
        break;
        
      case 'tool-result':
        logger.tool(chunk.toolName!, undefined, chunk.toolResult);
        
        // Find and complete the tool call trace
        if (chunk.toolName && chunk.toolStartTime && chunk.toolDuration !== undefined) {
          const key = `${chunk.toolName}_${chunk.toolStartTime}`;
          const pending = pendingToolCalls.get(key);
          if (pending) {
            let isSubAgent = false;
            let tokens: number | undefined;
            
            // Extract sub-agent token usage and detect if it's a sub-agent
            if (chunk.toolResultRaw && typeof chunk.toolResultRaw === 'object') {
              const rawResult = chunk.toolResultRaw as Record<string, unknown>;
              if (rawResult.metadata && typeof rawResult.metadata === 'object') {
                const metadata = rawResult.metadata as Record<string, unknown>;
                if (typeof metadata.tokensUsed === 'number') {
                  subAgentTokens += metadata.tokensUsed;
                  tokens = metadata.tokensUsed;
                }
                // Check if this is a sub-agent by presence of agent field
                if (metadata.agent) {
                  isSubAgent = true;
                }
              }
            }
            
            toolCallTraces.push({
              name: pending.name,
              type: isSubAgent ? 'subagent' : 'tool',
              startTime: pending.startTime,
              duration: chunk.toolDuration,
              ...(tokens && { tokens })
            });
            
            pendingToolCalls.delete(key);
          }
        }
        break;
        
      case 'tool-error':
        // Tool errors are now passed as tool-result in executeAgentCore
        // This case shouldn't occur but keep for safety
        const prefix = options?.logPrefix || '';
        const errorStr = typeof chunk.error === 'string' 
          ? chunk.error 
          : ((chunk.error as any)?.message || 'Unknown error');
        logger.warnWithTool(chunk.toolName || 'unknown', 'call', errorStr);
        if (prefix) logger.warn(prefix.trim()); // Show any prefix separately
        break;
        
      case 'finish':
        // Only update usage on final finish (not intermediate segments)
        if (chunk.usage) {
          usage = chunk.usage;
        }
        
        // Complete the LLM call trace for this segment
        if (currentLlmCall && currentLlmCall.startTime) {
          const duration = Date.now() - currentLlmCall.startTime;
          const segmentName = llmSegmentCount > 1 ? 
            `${currentLlmCall.model}_segment_${llmSegmentCount}` : 
            currentLlmCall.model;
          
          const llmTrace: ToolCallTrace = {
            name: segmentName,
            type: 'llm',
            startTime: currentLlmCall.startTime,
            duration,
            // Only add tokens for final segment with usage data
            ...(chunk.usage && chunk.usage.totalTokens && {
              tokens: chunk.usage.totalTokens
            })
          };
          toolCallTraces.push(llmTrace);
          currentLlmCall = null;
        }
        
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
    ...(subAgentTokens > 0 && { subAgentTokens }),
    ...(toolCallTraces.length > 0 && { toolCallTraces })
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
    if (provider === 'openai' && agent.config.openai) {
      providerOptions = { openai: agent.config.openai };
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
    logger.error('Failed to create stream:', error);
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
            logger.warn(`⚠️  Output length limit reached. The response was truncated.`);
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
      }
    }
  } catch (error: any) {
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
): Promise<{ text: string; usage?: LanguageModelUsage; toolCallCount: number; toolCallTraces?: ToolCallTrace[] }> {
  try {
    // Check if we're using OAuth (for system prompt modification)
    const isUsingOAuth = agent.config.model.includes('anthropic') && await AnthropicAuth.access();
    
    // Convert MCP tools to AI SDK format
    const mcpTools = await getMCPTools(mcpClients);
    
    // Load sub-agent tools if configured
    // If we have an agent file path, use its directory as the base path for sub-agents
    const basePath = agentFilePath ? dirname(agentFilePath) : undefined;
    if (agentFilePath) {
      logger.debug(`[SubAgent] Agent file path: ${agentFilePath}`);
      logger.debug(`[SubAgent] Base path for sub-agents: ${basePath}`);
    }
    // Pass the parent's model to subagents so they inherit any model override
    const subAgentTools = await createSubAgentTools(agent.config.subagents, basePath, agent.config.model);

    // Track subagent names for logging
    const subAgentNames = new Set(Object.keys(subAgentTools));

    // Merge all tools
    const tools = { ...mcpTools, ...subAgentTools };
    
    const maxSteps = parseInt(process.env.MAX_STEPS || String(DEFAULT_MAX_STEPS));
    
    logger.info(`Running agent with model: ${agent.config.model}`);
    if (Object.keys(tools).length > 0) {
      logger.info(`Available tools: ${Object.keys(tools).join(', ')}`);
    }
    
    // Log step limit if it's non-default or in verbose mode
    if (maxSteps !== DEFAULT_MAX_STEPS || verbose) {
      logger.info(`Max steps: ${maxSteps} (override via MAX_STEPS env var)`);
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
      maxSteps,
      subAgentNames,  // Pass subagent names for logging
      ...(abortSignal && { abortSignal })
    };
    
    const result = await processAgentStream(
      executeAgentCore(agent, tools, coreOptions),
      { collectToolCalls: true }
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
    
    // Return metrics for plugin system
    return {
      text: result.text,
      ...(result.usage && { usage: result.usage }),
      toolCallCount: result.toolCalls?.length || 0,
      ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces })
    };
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