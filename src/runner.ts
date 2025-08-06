import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ParsedAgent } from './parser';
import type { MCPConnection } from './mcp';
import { getMCPTools } from './mcp';

/**
 * Parse model string to extract provider, model name, and optional env suffix
 * Examples:
 * - "openai:gpt-4-turbo" -> default env vars
 * - "openai:gpt-4-turbo:dev" -> use _DEV suffix
 * - "openai:gpt-4-turbo:OPENAI_API_KEY_PERSONAL" -> use specific env var
 */
function parseModelConfig(modelString: string) {
  const parts = modelString.split(':');
  
  if (parts.length === 2) {
    // Standard format: provider:model
    return {
      provider: parts[0],
      modelName: parts[1],
      envConfig: null
    };
  } else if (parts.length === 3) {
    // Extended format: provider:model:env
    const envPart = parts[2];
    
    // Check if it's a full env var name or just a suffix
    if (envPart.includes('_KEY')) {
      // Full env var name like OPENAI_API_KEY_PERSONAL
      return {
        provider: parts[0],
        modelName: parts[1],
        envVar: envPart
      };
    } else {
      // Short suffix like "dev" or "prod"
      return {
        provider: parts[0],
        modelName: parts[1],
        envSuffix: envPart.toUpperCase()
      };
    }
  } else {
    // Default to OpenAI if no provider specified
    return {
      provider: 'openai',
      modelName: modelString,
      envConfig: null
    };
  }
}

/**
 * Run an agent with AI and MCP tools
 * @param agent Parsed agent configuration
 * @param mcpClients Connected MCP clients
 */
export async function runAgent(agent: ParsedAgent, mcpClients: MCPConnection[]): Promise<void> {
  try {
    // Parse model configuration
    const config = parseModelConfig(agent.config.model);
    
    // Get model instance based on provider
    let model: any;
    
    if (config.provider === 'anthropic') {
      let apiKey: string | undefined;
      
      if (config.envVar) {
        // Use specific environment variable
        apiKey = process.env[config.envVar];
        if (!apiKey) {
          throw new Error(`Missing ${config.envVar} environment variable`);
        }
        console.log(`Using ${config.envVar} for authentication`);
      } else if (config.envSuffix) {
        // Use API key with suffix
        const suffix = `_${config.envSuffix}`;
        apiKey = process.env[`ANTHROPIC_API_KEY${suffix}`];
        
        if (!apiKey) {
          throw new Error(`Missing ANTHROPIC_API_KEY${suffix} environment variable`);
        }
        console.log(`Using ANTHROPIC_API_KEY${suffix} for authentication`);
      } else {
        // Use default environment variables
        apiKey = process.env.ANTHROPIC_API_KEY;
        
        if (!apiKey) {
          throw new Error('Missing ANTHROPIC_API_KEY environment variable');
        }
      }
      
      const anthropic = createAnthropic({ apiKey });
      model = anthropic.chat(config.modelName);
      
    } else if (config.provider === 'openai') {
      let apiKey: string | undefined;
      
      if (config.envVar) {
        // Use specific environment variable
        apiKey = process.env[config.envVar];
        if (!apiKey) {
          throw new Error(`Missing ${config.envVar} environment variable`);
        }
        console.log(`Using ${config.envVar} for authentication`);
      } else if (config.envSuffix) {
        // Use environment variable with suffix
        const suffix = `_${config.envSuffix}`;
        apiKey = process.env[`OPENAI_API_KEY${suffix}`];
        if (!apiKey) {
          throw new Error(`Missing OPENAI_API_KEY${suffix} environment variable`);
        }
        console.log(`Using OPENAI_API_KEY${suffix} for authentication`);
      } else {
        // Use default environment variable
        apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error('Missing OPENAI_API_KEY environment variable');
        }
      }
      
      const openai = createOpenAI({ apiKey });
      model = openai.chat(config.modelName);
      
    } else {
      throw new Error(`Unsupported provider: ${config.provider}`);
    }
    
    // Convert MCP tools to AI SDK format
    const tools = await getMCPTools(mcpClients);
    
    console.log(`Running agent with model: ${agent.config.model}`);
    if (Object.keys(tools).length > 0) {
      console.log(`Available tools: ${Object.keys(tools).join(', ')}`);
    }
    
    // Execute agent with streaming output
    const result = await generateText({
      model,
      system: agent.instructions,
      messages: [
        { role: 'user', content: 'Please follow the instructions provided in the system prompt.' }
      ],
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      onStepFinish: (step) => {
        // Stream output to console
        if (step.text) {
          console.log(step.text);
        }
        if (step.toolCalls) {
          for (const toolCall of step.toolCalls) {
            console.log(`Tool: ${toolCall.toolName}`);
            console.log(`Args: ${JSON.stringify(toolCall.args)}`);
          }
        }
        if (step.toolResults) {
          for (const result of step.toolResults) {
            console.log(`Result: ${JSON.stringify(result.result)}`);
          }
        }
      }
    });
    
    // Final output
    if (result.text && !result.text.trim()) {
      console.log('\nFinal response:');
      console.log(result.text);
    }
    
    // Show usage stats
    if (result.usage) {
      console.log('\n---');
      console.log(`Tokens used: ${result.usage.totalTokens}`);
    }
  } catch (error) {
    console.error('Agent execution failed:', error);
    throw error;
  }
}