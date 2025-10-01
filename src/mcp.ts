import { experimental_createMCPClient, type Tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { 
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  type Resource 
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from './utils/logger';
import { parseJsonEnvVar } from './utils/env';
import { z } from 'zod';
import type { AgentConfig } from './parser';
import { resolve, isAbsolute } from 'path';

// Use the actual type from the parser to avoid mismatches
export type MCPServerConfig = NonNullable<AgentConfig['mcp_servers']>[string];
export type MCPServersConfig = AgentConfig['mcp_servers'];

export interface MCPConnection {
  name: string;
  client: Awaited<ReturnType<typeof experimental_createMCPClient>>;
  rawClient?: Client; // Raw MCP SDK client for resource access
  disallowedTools?: string[]; // List of disallowed tool names/patterns for this connection
}

/**
 * Create transport based on configuration (stdio or HTTP)
 */
function createTransport(name: string, config: MCPServerConfig, debug: boolean = false, basePath?: string): any {
  // HTTP transport with SSE streaming
  if ('url' in config) {
    const options: any = {};
    
    if (config.sessionId) {
      options.sessionId = config.sessionId;
    }
    
    if (config.auth?.token) {
      options.authProvider = {
        getToken: async () => config.auth!.token!
      };
    }
    
    if (config.headers) {
      options.requestInit = {
        headers: config.headers
      };
    }
    
    return new StreamableHTTPClientTransport(new URL(config.url), options);
  }
  
  // Stdio transport
  if ('command' in config) {
    // Prepare environment variables
    const env = getDefaultEnvironment();
    
    // Check required environment variables first (fail fast)
    if (config.requiredEnvVars && config.requiredEnvVars.length > 0) {
      const missingRequired: string[] = [];
      for (const varName of config.requiredEnvVars) {
        if (process.env[varName] === undefined) {
          missingRequired.push(varName);
        } else {
          const rawValue = process.env[varName];
          // Try to parse as JSON if it looks like JSON
          const parsedValue = parseJsonEnvVar(rawValue);
          
          if (parsedValue !== null && typeof parsedValue === 'object') {
            env[varName] = JSON.stringify(parsedValue);
            logger.debug(`[MCP] Adding required JSON env var ${varName} to ${name}`);
          } else {
            env[varName] = rawValue;
            logger.debug(`[MCP] Adding required env var ${varName} to ${name}`);
          }
        }
      }
      
      if (missingRequired.length > 0) {
        const error = new Error(
          `Missing required environment variables for MCP server '${name}': ${missingRequired.join(', ')}\n` +
          `Please set these in your .env file or export them in your shell.`
        );
        // Mark this as a fatal error that should exit immediately
        (error as any).fatal = true;
        throw error;
      }
    }
    
    // Only include explicitly allowed environment variables
    if (config.allowedEnvVars && config.allowedEnvVars.length > 0) {
      logger.debug(`[MCP] Server ${name} allowed env vars: ${config.allowedEnvVars.join(', ')}`);
      for (const varName of config.allowedEnvVars) {
        // Skip if already added as required
        if (config.requiredEnvVars?.includes(varName)) {
          continue;
        }
        
        if (process.env[varName] !== undefined) {
          const rawValue = process.env[varName];
          
          // Try to parse as JSON if it looks like JSON
          const parsedValue = parseJsonEnvVar(rawValue);
          
          // If parseJsonEnvVar returns an object/array, stringify it back
          // because environment variables must be strings
          if (parsedValue !== null && typeof parsedValue === 'object') {
            env[varName] = JSON.stringify(parsedValue);
            logger.debug(`[MCP] Adding JSON env var ${varName} to ${name}`);
          } else {
            // Use the original value if not JSON or parsing failed
            env[varName] = rawValue;
            logger.debug(`[MCP] Adding env var ${varName} to ${name}`);
          }
        } else {
          logger.warn(`[MCP] Optional environment variable '${varName}' not set for server '${name}'`);
        }
      }
    }
    
    // Override with any server-specific environment variables
    if ('env' in config && config.env) {
      Object.assign(env, config.env);
    }
    
    // Resolve command path relative to basePath if provided and not absolute
    let commandPath = config.command;
    if (basePath && !isAbsolute(commandPath)) {
      // Only resolve if it looks like a path (contains / or \)
      if (commandPath.includes('/') || commandPath.includes('\\')) {
        commandPath = resolve(basePath, commandPath);
        logger.debug(`[MCP] Resolved command path: ${config.command} -> ${commandPath}`);
      }
    }

    return new StdioClientTransport({
      command: commandPath,
      args: config.args || [],
      env: env,
      stderr: debug ? 'inherit' : 'ignore'
    });
  }
  
  throw new Error('MCP server must have either url or command');
}

/**
 * Connect to MCP servers using AI SDK experimental_createMCPClient
 * @param servers Optional server configurations
 * @param debug Enable debug logging
 * @returns Array of MCP client connections
 */
export async function connectMCP(servers?: MCPServersConfig, debug: boolean = false, basePath?: string): Promise<MCPConnection[]> {
  if (!servers) {
    logger.debug('[MCP] No MCP servers configured');
    return [];
  }
  
  logger.info(`[MCP] Connecting to ${Object.keys(servers).length} MCP server(s): ${Object.keys(servers).join(', ')}`);
  
  // Note: Environment variables are already loaded in index.ts before this is called
  // The envFile parameter is kept for backwards compatibility but is no longer used here
  
  // Create promises for all server connections in parallel
  const connectionPromises = Object.entries(servers).map(async ([name, config]) => {
    try {
      logger.debug(`[MCP] Configuring server: ${name} - ${JSON.stringify(config)}`);
      
      // Create transport based on config type
      const transport = createTransport(name, config, debug, basePath);
      
      // Create MCP client using AI SDK's built-in method
      const client = await experimental_createMCPClient({
        name,
        transport: transport,
      });
      
      // Also create a raw MCP SDK client for resource access
      // We need a separate transport instance for the raw client
      const rawTransport = createTransport(name, config, debug, basePath);
      
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
        rawClient,
        ...(config.disallowedTools && { disallowedTools: config.disallowedTools })
      };
    } catch (error) {
      // Check if this is a fatal error (missing required env vars)
      if ((error as any).fatal) {
        logger.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
        // Re-throw fatal errors immediately
        throw error;
      }
      
      // Smart error detection: check if allowed env vars are missing
      const missingAllowed = config.allowedEnvVars?.filter(v => !process.env[v]) || [];
      
      let errorMessage = `Failed to connect to MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`;
      
      if (missingAllowed.length > 0) {
        errorMessage += `\n\nNote: The following optional environment variables are not set: ${missingAllowed.join(', ')}`;
        errorMessage += `\nIf this server requires these variables, please set them in your .env file or export them in your shell.`;
      }
      
      logger.error(errorMessage);
      throw new Error(errorMessage);
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
      // Check if this is a fatal error (missing required env vars)
      if (result.reason?.fatal) {
        // Re-throw fatal errors immediately to exit the CLI
        throw result.reason;
      }
      
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
  const listToolName = `mcp__${connection.name}__list_resources`;
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
  const readToolName = `mcp__${connection.name}__read_resource`;
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
 * Check if a tool name matches any disallowed patterns
 * @param toolName The tool name to check
 * @param disallowedPatterns Array of disallowed patterns (supports wildcards)
 * @returns True if the tool should be disallowed
 */
function isToolDisallowed(toolName: string, disallowedPatterns?: string[]): boolean {
  if (!disallowedPatterns || disallowedPatterns.length === 0) {
    return false;
  }
  
  for (const pattern of disallowedPatterns) {
    // Support wildcard patterns
    if (pattern.includes('*')) {
      // Escape regex special chars except * (wildcard)
      const regexPattern = pattern
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(toolName)) {
        return true;
      }
    } else {
      // Exact match
      if (toolName === pattern) {
        return true;
      }
    }
  }
  
  return false;
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
        // Check if this tool is disallowed
        if (isToolDisallowed(toolName, connection.disallowedTools)) {
          logger.info(`[MCP] Tool '${toolName}' is disallowed for server ${connection.name}`);
          continue;
        }
        
        const prefixedName = `mcp__${connection.name}__${toolName}`;
        
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
              if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
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
              // Log the error first
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`[WARNING] Tool call failed: ${prefixedName} - ${errorMessage}`);
              
              // Re-throw the error so it properly triggers tool-error event
              throw error;
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