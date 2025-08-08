import { streamText, stepCountIs } from 'ai';
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
  const basePrompt = `You are an autonomous AI agent. When given a task:
- Break it down into clear steps
- Execute each step thoroughly
- Keep responses concise and focused on outcomes
- Iterate until the task is fully complete`;

  const subAgentAddition = isSubAgent ? '\n- Provide a clear summary when complete' : '';
  
  return `${basePrompt}${subAgentAddition}

Today's date: ${todayDate}`;
}

export interface AgentChunk {
  type: 'text' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: any;
  toolResult?: string;
  toolResultRaw?: any;
  error?: any;
  finishReason?: string;
  usage?: any;
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
  usage?: any;
  toolCalls?: Array<{ tool: string; args: any }>;
  subAgentTokens?: number;
}> {
  let finalText = '';
  let usage: any = null;
  const toolCalls: Array<{ tool: string; args: any }> = [];
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
          if (chunk.toolResultRaw.metadata?.tokensUsed) {
            subAgentTokens += chunk.toolResultRaw.metadata.tokensUsed;
          }
        }
        break;
        
      case 'tool-error':
        const prefix = options?.logPrefix || '';
        logger.warn(`${prefix}Tool call failed: ${chunk.toolName} - ${chunk.error}`);
        break;
        
      case 'finish':
        usage = chunk.usage;
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
    usage,
    ...(options?.collectToolCalls && { toolCalls }),
    ...(subAgentTokens > 0 && { subAgentTokens })
  };
}

/**
 * Core agent execution as an async generator
 */
export async function* executeAgentCore(
  agent: ParsedAgent,
  tools: Record<string, any>,
  options: {
    userMessage: string;
    systemMessages: Array<{role: string, content: string}>;
    maxSteps: number;
    abortSignal?: AbortSignal;
  }
): AsyncGenerator<AgentChunk> {
  const model = await createModel(agent.config.model);
  
  const streamConfig: any = {
    model,
    messages: [
      ...options.systemMessages,
      { role: 'user', content: options.userMessage }
    ],
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxRetries: MAX_RETRIES,
    toolChoice: 'auto',
    stopWhen: stepCountIs(options.maxSteps),
  };
  
  if (options.abortSignal) {
    streamConfig.abortSignal = options.abortSignal;
  }
  
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
        yield {
          type: 'tool-error',
          toolName: chunk.toolName,
          error: (chunk as any).error?.message || (chunk as any).error || 'Unknown error'
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
    const subAgentTools = await createSubAgentTools(agent.config.subagents as any, basePath);
    
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
    const coreOptions: any = {
      userMessage: agent.instructions,
      systemMessages,
      maxSteps: parseInt(process.env.MAX_STEPS || String(DEFAULT_MAX_STEPS))
    };
    
    if (abortSignal) {
      coreOptions.abortSignal = abortSignal;
    }
    
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
  } catch (error: any) {
    // Check if it's an abort error from timeout
    if (error.name === 'AbortError' || (abortSignal && abortSignal.aborted)) {
      // Timeout already handled by caller
      throw error;
    }
    logger.error('Agent execution failed', error);
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