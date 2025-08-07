import { experimental_createMCPClient, type Tool } from 'ai';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as dotenv from 'dotenv';
import { logger } from './utils/logger';

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>; // Optional environment variables
  allowedEnvVars?: string[]; // List of allowed environment variable names
}

export interface MCPServersConfig {
  [name: string]: MCPServerConfig;
}

export interface MCPConnection {
  name: string;
  client: Awaited<ReturnType<typeof experimental_createMCPClient>>;
}

/**
 * Connect to MCP servers using AI SDK experimental_createMCPClient
 * @param servers Optional server configurations
 * @param debug Enable debug logging
 * @returns Array of MCP client connections
 */
export async function connectMCP(servers?: MCPServersConfig, debug: boolean = false): Promise<MCPConnection[]> {
  if (!servers) return [];
  
  // Load environment variables from .env file silently
  dotenv.config({ quiet: true } as any);
  
  // Create promises for all server connections in parallel
  const connectionPromises = Object.entries(servers).map(async ([name, config]) => {
    try {
      logger.debug(`[MCP] Configuring server: ${name} - ${JSON.stringify(config)}`);
      
      // Prepare environment variables - start with default environment only
      const env = getDefaultEnvironment();
      
      // Only include explicitly allowed environment variables
      if (config.allowedEnvVars && config.allowedEnvVars.length > 0) {
        logger.debug(`[MCP] Server ${name} allowed env vars: ${config.allowedEnvVars.join(', ')}`);
        for (const varName of config.allowedEnvVars) {
          if (process.env[varName] !== undefined) {
            env[varName] = process.env[varName];
            logger.debug(`[MCP] Adding env var ${varName} to ${name}`);
          } else {
            logger.debug(`[MCP] Env var ${varName} not found in process.env for ${name}`);
          }
        }
      }
      // If no allowedEnvVars specified, no process.env variables are passed
      
      // Override with any server-specific environment variables
      if (config.env) {
        Object.assign(env, config.env);
      }
      
      // Create MCP client using AI SDK's built-in method (like opencode does)
      const client = await experimental_createMCPClient({
        name,
        transport: new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: env,
          stderr: debug ? 'inherit' : 'ignore'
        }),
      });
      
      logger.info(`Connected to MCP server: ${name}`);
      
      return {
        name,
        client
      };
    } catch (error) {
      logger.error(`Failed to connect to MCP server ${name}`, error as Error);
      throw new Error(`Failed to connect to MCP server: ${name}`);
    }
  });
  
  // Execute all connections in parallel and wait for all to complete
  // Using Promise.allSettled to handle partial failures gracefully
  const results = await Promise.allSettled(connectionPromises);
  
  const connections: MCPConnection[] = [];
  const failedServers: string[] = [];
  
  for (const result of results) {
    if (result.status === 'fulfilled') {
      connections.push(result.value);
    } else {
      // Extract server name from error message
      const errorMessage = result.reason?.message || '';
      const serverMatch = errorMessage.match(/Failed to connect to MCP server: (.+)/);
      const serverName = serverMatch ? serverMatch[1] : 'unknown';
      failedServers.push(serverName);
    }
  }
  
  // If some servers failed, log a warning but continue with successful connections
  if (failedServers.length > 0) {
    logger.warn(`Some MCP servers failed to connect: ${failedServers.join(', ')}`);
  }
  
  // If all servers failed, throw an error
  if (connections.length === 0 && Object.keys(servers).length > 0) {
    throw new Error('All MCP servers failed to connect');
  }
  
  return connections;
}

/**
 * Get available tools from MCP connections using AI SDK approach
 * @param connections Array of MCP connections
 * @param debug Enable debug logging
 * @returns Tools in AI SDK format
 */
export async function getMCPTools(connections: MCPConnection[]): Promise<Record<string, Tool>> {
  // Process all connections in parallel to fetch their tools
  const toolPromises = connections.map(async (connection) => {
    try {
      // Use AI SDK's built-in tools() method - this handles all the complexity
      const clientTools = await connection.client.tools();
      
      const connectionTools: Record<string, Tool> = {};
      
      // Add tools with prefixed names to avoid conflicts and wrap execution (like opencode)
      for (const [toolName, tool] of Object.entries(clientTools)) {
        const prefixedName = `${connection.name}_${toolName}`;
        
        // Wrap the tool execution like opencode does
        const originalExecute = tool.execute;
        if (!originalExecute) {
          continue;
        }
        
        // Create wrapped tool with proper result handling
        const wrappedTool = {
          ...tool,
          execute: async (args: any, opts: any) => {
            try {
              const result = await originalExecute(args, opts);
              
              // Handle MCP result format (like opencode does)
              if (result && result.content && Array.isArray(result.content)) {
                const output = result.content
                  .filter((x: any) => x.type === "text")
                  .map((x: any) => x.text)
                  .join("\n\n");
                
                return {
                  output,
                };
              }
              
              // Fallback for non-standard result formats
              const output = typeof result === 'string' ? result : JSON.stringify(result);
              return {
                output,
              };
            } catch (error) {
              return {
                output: `Error executing ${prefixedName}: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          },
          toModelOutput: (result: any) => {
            return {
              type: "text" as const,
              value: result.output,
            };
          }
        };
        
        connectionTools[prefixedName] = wrappedTool;
      }
      
      return connectionTools;
    } catch (error) {
      logger.error(`Failed to get tools from ${connection.name}`, error as Error);
      // Return empty object for this connection if it fails
      return {};
    }
  });
  
  // Wait for all tools to be fetched in parallel
  const toolsArrays = await Promise.all(toolPromises);
  
  // Merge all tools into a single object
  const tools: Record<string, Tool> = {};
  for (const connectionTools of toolsArrays) {
    Object.assign(tools, connectionTools);
  }
  
  return tools;
}