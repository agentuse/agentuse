import { streamText, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ParsedAgent } from './parser';
import type { MCPConnection } from './mcp';
import { getMCPTools } from './mcp';
import { AnthropicAuth } from './auth/anthropic';

// Constants
const MAX_RETRIES = 3;
const RESULT_PREVIEW_LENGTH = 200;

interface ModelConfig {
  provider: string;
  modelName: string;
  envVar?: string;
  envSuffix?: string;
}

/**
 * Parse model string to extract provider, model name, and optional env suffix
 * Format: "provider:model[:env]"
 * Examples:
 * - "openai:gpt-4-turbo" -> default env vars
 * - "openai:gpt-4-turbo:dev" -> use _DEV suffix
 * - "openai:gpt-4-turbo:OPENAI_API_KEY_PERSONAL" -> use specific env var
 */
function parseModelConfig(modelString: string): ModelConfig {
  const parts = modelString.split(':');
  const [provider, modelName, envPart] = parts.length >= 2 
    ? parts 
    : ['openai', modelString, undefined];
  
  if (!envPart) {
    return { provider, modelName };
  }
  
  // Determine if envPart is a full env var or just a suffix
  const isFullEnvVar = envPart.includes('_KEY');
  return {
    provider,
    modelName,
    ...(isFullEnvVar 
      ? { envVar: envPart }
      : { envSuffix: envPart.toUpperCase() })
  };
}

/**
 * Create AI model instance based on configuration
 */
async function createModel(modelString: string) {
  const config = parseModelConfig(modelString);
  
  if (config.provider === 'anthropic') {
    // Check for OAuth token first (handles refresh automatically)
    const oauthToken = await AnthropicAuth.access();
    if (oauthToken) {
      console.log('Using Anthropic OAuth token for authentication');
      // For OAuth, we need to use a custom fetch to set Bearer token
      const anthropic = createAnthropic({ 
        apiKey: '', // Empty API key for OAuth
        fetch: async (input: any, init: any) => {
          const access = await AnthropicAuth.access();
          const headers = {
            ...init.headers,
            'authorization': `Bearer ${access}`,
            'anthropic-beta': 'oauth-2025-04-20',
          };
          // Remove x-api-key header since we're using Bearer auth
          delete headers['x-api-key'];
          return fetch(input, {
            ...init,
            headers,
          });
        },
      } as any);
      return anthropic.chat(config.modelName);
    }
    
    // Fall back to API key authentication
    let apiKey: string | undefined;
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new Error(`Missing ${config.envVar} environment variable`);
      }
      console.log(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`ANTHROPIC_API_KEY${suffix}`];
      if (!apiKey) {
        throw new Error(`Missing ANTHROPIC_API_KEY${suffix} environment variable`);
      }
      console.log(`Using ANTHROPIC_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('Missing ANTHROPIC_API_KEY environment variable and no OAuth token found');
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for Anthropic');
    }
    const anthropic = createAnthropic({ apiKey });
    return anthropic.chat(config.modelName);
    
  } else if (config.provider === 'openai') {
    let apiKey: string | undefined;
    
    if (config.envVar) {
      apiKey = process.env[config.envVar];
      if (!apiKey) {
        throw new Error(`Missing ${config.envVar} environment variable`);
      }
      console.log(`Using ${config.envVar} for authentication`);
    } else if (config.envSuffix) {
      const suffix = `_${config.envSuffix}`;
      apiKey = process.env[`OPENAI_API_KEY${suffix}`];
      if (!apiKey) {
        throw new Error(`Missing OPENAI_API_KEY${suffix} environment variable`);
      }
      console.log(`Using OPENAI_API_KEY${suffix} for authentication`);
    } else {
      apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('Missing OPENAI_API_KEY environment variable');
      }
    }
    
    if (!apiKey) {
      throw new Error('Failed to obtain API key for OpenAI');
    }
    const openai = createOpenAI({ apiKey });
    return openai.chat(config.modelName);
    
  } else {
    throw new Error(`Unsupported provider: ${config.provider}`);
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
 * Run an agent with AI and MCP tools
 * @param agent Parsed agent configuration
 * @param mcpClients Connected MCP clients
 * @param debug Enable debug logging
 * @param abortSignal Optional abort signal for cancellation
 */
export async function runAgent(agent: ParsedAgent, mcpClients: MCPConnection[], debug: boolean = false, abortSignal?: AbortSignal): Promise<void> {
  try {
    // Check if we're using OAuth (for system prompt modification)
    const isUsingOAuth = agent.config.model.includes('anthropic') && await AnthropicAuth.access();
    
    // Create model instance
    const model = await createModel(agent.config.model);
    
    // Convert MCP tools to AI SDK format
    const tools = await getMCPTools(mcpClients);
    
    console.log(`Running agent with model: ${agent.config.model}`);
    if (Object.keys(tools).length > 0) {
      console.log(`Available tools: ${Object.keys(tools).join(', ')}`);
    }
    
    
    // Execute agent with streaming output and recursive tool handling
    let stepCount = 0;
    let finalText = '';
    let finishReason = '';
    let usage: any = null;

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
      
      if (debug) {
        console.log("Using Anthropic system prompt: You are Claude Code...");
        if (isUsingOAuth) {
          console.log("Authentication: OAuth token");
        }
      }
    }
    
    // Add main system prompt as second message
    const mainSystemPrompt = `You are an autonomous AI agent. When given a task:
  - Break it down into clear steps
  - Execute each step thoroughly
  - Iterate until the task is fully complete

Today's date: ${todayDate}`;
    
    systemMessages.push({
      role: 'system', 
      content: mainSystemPrompt
    });

    const streamConfig: any = {
      model,
      // No separate 'system' parameter - system messages are in the messages array
      messages: [
        ...systemMessages,
        { role: 'user', content: agent.instructions }
      ],
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxRetries: MAX_RETRIES,
      toolChoice: 'auto',
      stopWhen: stepCountIs(1000),
    };
    
    if (abortSignal) {
      streamConfig.abortSignal = abortSignal;
    }
    
    const stream = streamText(streamConfig);

    // Process the stream to capture all events
    for await (const chunk of stream.fullStream) {
      
      switch (chunk.type) {
        case 'start':
          stepCount++;
          break;
          
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
          // Handle tool input streaming
          break;
          
        case 'tool-call':
          if (debug) {
            console.log(`\n🔧 [Step ${stepCount}] Tool: ${chunk.toolName}`);
            const input = (chunk as any).input || (chunk as any).args;
            if (input !== undefined && input !== null) {
              console.log(`   Args: ${JSON.stringify(input, null, 2)}`);
            }
          }
          break;
          
        case 'tool-result':
          if (debug) {
            const resultStr = parseToolResult(chunk);
            if (resultStr && resultStr.length > RESULT_PREVIEW_LENGTH) {
              console.log(`   ✓ Result: ${resultStr.substring(0, RESULT_PREVIEW_LENGTH)}...`);
            } else {
              console.log(`   ✓ Result: ${resultStr || 'No result'}`);
            }
          }
          break;
          
        // Handle various text streaming events
        case 'text-start':
          break;
          
        case 'text-delta':
          // Try different possible property names for the text content
          const textContent = (chunk as any).text || (chunk as any).textDelta || (chunk as any).delta || (chunk as any).content;
          
          if (textContent && typeof textContent === 'string') {
            finalText += textContent;
            process.stdout.write(textContent);
          }
          break;
          
        // Handle completion
        case 'finish':
          finishReason = chunk.finishReason;
          usage = (chunk as any).totalUsage || (chunk as any).usage;
          if (finalText && finalText.trim()) {
            console.log(); // New line after streaming text
          }
          break;
          
        case 'error':
          throw chunk.error;
          
        default:
          // Unhandled stream events are ignored
          break;
      }
    }

    // Create a result object similar to generateText
    const result = {
      text: finalText.trim() || null,
      finishReason,
      usage,
      toolCalls: [], // We handled these in the stream
      toolResults: [], // We handled these in the stream
      response: { messages: [] } // Simplified for compatibility
    };
    
    // Final output handling - no need for diagnostic logs since streaming shows everything
    if (!result.text || !result.text.trim()) {
      console.log('\n⚠️  No final response generated by the model');
      if (stepCount > 0) {
        console.log(`Model completed ${stepCount} steps but did not generate a final summary.`);
      }
    }
    
    
    // Show usage stats
    if (result.usage) {
      console.log('\n---');
      console.log(`Tokens used: ${result.usage.totalTokens}`);
    }
  } catch (error: any) {
    // Check if it's an abort error from timeout
    if (error.name === 'AbortError' || (abortSignal && abortSignal.aborted)) {
      // Timeout already handled by caller
      throw error;
    }
    console.error('Agent execution failed:', error);
    throw error;
  } finally {
    // Clean up MCP clients (like opencode does)
    for (const connection of mcpClients) {
      try {
        await connection.client.close();
        if (debug) {
          console.log(`[DEBUG] Closed MCP client: ${connection.name}`);
        }
      } catch (error) {
        // Ignore errors when closing MCP clients
      }
    }
  }
}