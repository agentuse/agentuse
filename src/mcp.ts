import { experimental_createMCPClient, type Tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { 
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  type Resource 
} from '@modelcontextprotocol/sdk/types.js';
import * as dotenv from 'dotenv';
import { logger } from './utils/logger';
import { z } from 'zod';

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
  rawClient?: Client; // Raw MCP SDK client for resource access
}

/**
 * Connect to MCP servers using AI SDK experimental_createMCPClient
 * @param servers Optional server configurations
 * @param debug Enable debug logging
 * @returns Array of MCP client connections
 */
export async function connectMCP(servers?: MCPServersConfig, debug: boolean = false): Promise<MCPConnection[]> {
  if (!servers) {
    logger.debug('[MCP] No MCP servers configured');
    return [];
  }
  
  logger.info(`[MCP] Connecting to ${Object.keys(servers).length} MCP server(s): ${Object.keys(servers).join(', ')}`);
  
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
      
      // Create transport for both clients
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: env,
        stderr: debug ? 'inherit' : 'ignore'
      });
      
      // Create MCP client using AI SDK's built-in method (like opencode does)
      const client = await experimental_createMCPClient({
        name,
        transport: transport,
      });
      
      // Also create a raw MCP SDK client for resource access
      // We need a separate transport instance for the raw client
      const rawTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: env,
        stderr: debug ? 'inherit' : 'ignore'
      });
      
      const rawClient = new Client({
        name: `${name}-raw`,
        version: '1.0.0',
      }, {
        capabilities: {}
      });
      
      await rawClient.connect(rawTransport);
      
      logger.info(`Connected to MCP server: ${name}`);
      
      return {
        name,
        client,
        rawClient
      };
    } catch (error) {
      logger.error(`Failed to connect to MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`);
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
 * Get available resources from an MCP connection
 * @param connection MCP connection with raw client
 * @returns Array of resources
 */
async function getMCPResources(connection: MCPConnection): Promise<Resource[]> {
  if (!connection.rawClient) {
    return [];
  }
  
  try {
    const response = await connection.rawClient.request(
      { method: 'resources/list' },
      ListResourcesResultSchema
    );
    
    return response.resources || [];
  } catch (error) {
    logger.debug(`Server ${connection.name} does not support resources: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Create synthetic tools for resource access
 * @param connection MCP connection
 * @param resources Available resources
 * @returns Tools for resource operations
 */
function createResourceTools(connection: MCPConnection, resources: Resource[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  
  if (resources.length === 0) {
    return tools;
  }
  
  // Create a list resources tool
  const listToolName = `${connection.name}_list_resources`;
  tools[listToolName] = {
    description: `List all available resources from ${connection.name}`,
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const resourceList = resources.map(r => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType
        }));
        
        const output = JSON.stringify(resourceList, null, 2);
        return {
          output
        };
      } catch (error) {
        return {
          output: `Error listing resources: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  };
  
  // Create a read resource tool
  const readToolName = `${connection.name}_read_resource`;
  tools[readToolName] = {
    description: `Read a specific resource from ${connection.name}`,
    inputSchema: z.object({
      uri: z.string().describe('The URI of the resource to read')
    }),
    execute: async ({ uri }: { uri: string }) => {
      if (!connection.rawClient) {
        return {
          output: 'Raw client not available for resource reading'
        };
      }
      
      try {
        const response = await connection.rawClient.request(
          { 
            method: 'resources/read',
            params: { uri }
          },
          ReadResourceResultSchema
        );
        
        // Handle different content types
        const contents = response.contents || [];
        const outputs: string[] = [];
        
        for (const content of contents) {
          if (typeof content.text === 'string') {
            outputs.push(content.text);
          } else if (content.blob) {
            outputs.push(`[Binary data: ${content.mimeType || 'unknown type'}]`);
          }
        }
        
        return {
          output: outputs.join('\n\n')
        };
      } catch (error) {
        return {
          output: `Error reading resource ${uri}: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
  };
  
  return tools;
}

/**
 * Get available tools from MCP connections using AI SDK approach
 * @param connections Array of MCP connections
 * @param debug Enable debug logging
 * @returns Tools in AI SDK format
 */
export async function getMCPTools(connections: MCPConnection[]): Promise<Record<string, Tool>> {
  // Process all connections in parallel to fetch their tools and resources
  const toolPromises = connections.map(async (connection) => {
    const connectionTools: Record<string, Tool> = {};
    
    // First, try to get regular tools
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
        
        connectionTools[prefixedName] = wrappedTool;
      }
    } catch (error) {
      logger.debug(`Server ${connection.name} does not support tools: ${error instanceof Error ? error.message : String(error)}`);
      // Don't return yet - try to get resources
    }
    
    // Now try to get resources and create synthetic tools for them
    try {
      const resources = await getMCPResources(connection);
      if (resources.length > 0) {
        logger.info(`[MCP] Found ${resources.length} resources in ${connection.name}`);
        const resourceTools = createResourceTools(connection, resources);
        Object.assign(connectionTools, resourceTools);
        logger.info(`[MCP] Created ${Object.keys(resourceTools).length} resource tools for ${connection.name}: ${Object.keys(resourceTools).join(', ')}`);
      } else {
        logger.debug(`[MCP] No resources found in ${connection.name}`);
      }
    } catch (error) {
      logger.debug(`[MCP] Failed to get resources from ${connection.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    return connectionTools;
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