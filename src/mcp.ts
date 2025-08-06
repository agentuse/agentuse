import { experimental_createMCPClient, type Tool } from 'ai';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as dotenv from 'dotenv';

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
  
  const connections: MCPConnection[] = [];
  
  for (const [name, config] of Object.entries(servers)) {
    try {
      if (debug) {
        console.log(`[MCP] Configuring server: ${name}`, config);
      }
      
      // Prepare environment variables - start with default environment only
      const env = getDefaultEnvironment();
      
      // Only include explicitly allowed environment variables
      if (config.allowedEnvVars && config.allowedEnvVars.length > 0) {
        if (debug) {
          console.log(`[MCP] Server ${name} allowed env vars:`, config.allowedEnvVars);
        }
        for (const varName of config.allowedEnvVars) {
          if (process.env[varName] !== undefined) {
            env[varName] = process.env[varName];
            if (debug) {
              console.log(`[MCP] Adding env var ${varName} to ${name}`);
            }
          } else if (debug) {
            console.log(`[MCP] Warning: Env var ${varName} not found in process.env for ${name}`);
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
      
      connections.push({
        name,
        client
      });
      
      console.log(`Connected to MCP server: ${name}`);
    } catch (error) {
      console.error(`Failed to connect to MCP server ${name}:`, error);
      throw new Error(`Failed to connect to MCP server: ${name}`);
    }
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
  const tools: Record<string, Tool> = {};
  
  for (const connection of connections) {
    try {
      // Use AI SDK's built-in tools() method - this handles all the complexity
      const clientTools = await connection.client.tools();
      
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
        
        tools[prefixedName] = wrappedTool;
      }
    } catch (error) {
      console.error(`Failed to get tools from ${connection.name}:`, error);
      // Continue with other connections even if one fails
    }
  }
  
  return tools;
}