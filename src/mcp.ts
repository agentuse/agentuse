import { createMCPClient } from '@ai-sdk/mcp';
import type { Tool } from 'ai';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from './utils/logger';
import { parseJsonEnvVar } from './utils/env';
import { resolveToolTimeout } from './utils/config';
import { z } from 'zod';
import type { AgentConfig } from './parser';
import { resolve, isAbsolute } from 'path';

// Use the actual type from the parser to avoid mismatches
// Note: Using mcpServers (the normalized field after transform)
export type MCPServerConfig = NonNullable<AgentConfig['mcpServers']>[string];
export type MCPServersConfig = AgentConfig['mcpServers'];

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;
type MCPResource = Awaited<ReturnType<MCPClient['listResources']>>['resources'][number];

/**
 * Fallback bound on the MCP handshake. Without it a wedged `npx` or a server
 * that blocks on a stderr prompt hangs the whole run: connect happens before
 * the run's abort timer is armed, so nothing else would ever cut it loose.
 */
const DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS = 30;

export interface MCPConnection {
  name: string;
  client: MCPClient;
  disallowedTools?: string[]; // List of disallowed tool names/patterns for this connection
  preloadedTools?: Record<string, Tool>; // Cached tools for HTTP connections (loaded immediately)
  config?: MCPServerConfig; // Original config for accessing toolTimeout and other settings
}

/**
 * Convert a raw MCP tool result into AI SDK model output without discarding
 * non-text blocks. Unknown block types fail explicitly so protocol drift cannot
 * silently erase data.
 */
export function mcpResultToModelOutput({ output }: { output: unknown }): any {
  if (typeof output === 'string') return { type: 'text', value: output };
  if (!output || typeof output !== 'object') return { type: 'json', value: output ?? null };

  const result = output as {
    content?: unknown;
    structuredContent?: unknown;
    toolResult?: unknown;
  };
  if (!Array.isArray(result.content)) {
    return { type: 'json', value: result.toolResult ?? output };
  }

  const value: any[] = [];
  for (const rawPart of result.content) {
    if (!rawPart || typeof rawPart !== 'object') {
      throw new Error('Unsupported MCP content block: expected an object');
    }
    const part = rawPart as Record<string, unknown>;
    switch (part.type) {
      case 'text':
        if (typeof part.text !== 'string') throw new Error('Invalid MCP text content: missing text');
        value.push({ type: 'text', text: part.text });
        break;
      case 'image':
        if (typeof part.data !== 'string' || typeof part.mimeType !== 'string') {
          throw new Error('Invalid MCP image content: missing data or mimeType');
        }
        value.push({ type: 'image-data', data: part.data, mediaType: part.mimeType });
        break;
      case 'audio':
      case 'file':
        if (typeof part.data !== 'string' || typeof part.mimeType !== 'string') {
          throw new Error(`Invalid MCP ${String(part.type)} content: missing data or mimeType`);
        }
        value.push({
          type: 'file-data',
          data: part.data,
          mediaType: part.mimeType,
          ...(typeof part.name === 'string' && { filename: part.name }),
        });
        break;
      case 'resource': {
        const resource = part.resource;
        if (!resource || typeof resource !== 'object') {
          throw new Error('Invalid MCP resource content: missing resource');
        }
        const resourceRecord = resource as Record<string, unknown>;
        if (typeof resourceRecord.text === 'string') {
          // Keep URI/name/mime metadata alongside the text, not just the body.
          value.push({ type: 'text', text: JSON.stringify(part) });
        } else if (typeof resourceRecord.blob === 'string') {
          value.push({
            type: 'text',
            text: JSON.stringify({
              type: 'resource',
              resource: Object.fromEntries(
                Object.entries(resourceRecord).filter(([key]) => key !== 'blob')
              ),
            }),
          });
          value.push({
            type: 'file-data',
            data: resourceRecord.blob,
            mediaType: typeof resourceRecord.mimeType === 'string'
              ? resourceRecord.mimeType
              : 'application/octet-stream',
            ...(typeof resourceRecord.name === 'string' && { filename: resourceRecord.name }),
          });
        } else {
          throw new Error('Invalid MCP resource content: expected text or blob');
        }
        break;
      }
      case 'resource_link':
        value.push({ type: 'text', text: JSON.stringify(part) });
        break;
      default:
        throw new Error(`Unsupported MCP content type "${String(part.type ?? 'unknown')}"`);
    }
  }

  if (result.structuredContent !== undefined) {
    value.push({
      type: 'text',
      text: `[MCP structured content]\n${JSON.stringify(result.structuredContent)}`,
    });
  }
  return { type: 'content', value };
}

/**
 * Resolve ${env:VAR_NAME} placeholders in a string
 * @param value The string that may contain ${env:VAR_NAME} placeholders
 * @returns The string with placeholders replaced by environment variable values
 */
function resolveEnvVariables(value: string): string {
  return value.replace(/\$\{env:(\w+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      logger.warn(`Environment variable '${varName}' referenced in config is not set`);
      return match; // Return original if not found
    }
    return envValue;
  });
}

/**
 * Create transport based on configuration (stdio or HTTP)
 */
function createTransport(
  name: string,
  config: MCPServerConfig,
  debug: boolean = false,
  basePath?: string,
  cwd?: string
): any {
  // HTTP transport with SSE streaming
  if ('url' in config) {
    const options: any = {};
    
    if (config.sessionId) {
      options.sessionId = config.sessionId;
    }
    
    if (config.auth?.token) {
      const resolvedToken = resolveEnvVariables(config.auth.token);
      options.authProvider = {
        getToken: async () => resolvedToken
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
      stderr: debug ? 'inherit' : 'ignore',
      // Long-running serve processes host many projects without changing the
      // daemon's process.cwd(). Bind each stdio server to the run's logical cwd
      // so relative args, env files, and project-local executables resolve in
      // the same place as filesystem and bash tools.
      ...(cwd && { cwd })
    });
  }
  
  throw new Error('MCP server must have either url or command');
}

/**
 * Run the MCP handshake under a deadline. On timeout the transport is closed
 * directly rather than through the client: when the spawn itself is what
 * wedged, no client exists yet, and the subprocess would otherwise outlive
 * the run.
 */
export async function connectWithTimeout(
  name: string,
  transport: any,
  timeoutSeconds: number,
  options: {
    preloadTools?: boolean;
    createClient?: (options: { name: string; transport: any }) => Promise<MCPClient>;
  } = {}
): Promise<{ client: MCPClient; preloadedTools?: Record<string, Tool> }> {
  let client: MCPClient | undefined;
  const createClient = options.createClient ?? createMCPClient;
  const connectPromise = (async () => {
    client = await createClient({ name, transport });
    const preloadedTools = options.preloadTools
      ? await client.tools() as Record<string, Tool>
      : undefined;
    return {
      client,
      ...(preloadedTools && { preloadedTools }),
    };
  })();

  if (timeoutSeconds <= 0) {
    return connectPromise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Timed out after ${timeoutSeconds}s while connecting and discovering tools`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutSeconds * 1000);
  });

  try {
    return await Promise.race([connectPromise, timeoutPromise]);
  } catch (error) {
    if (client) {
      // Cleanup must not turn the deadline into another unbounded wait when a
      // broken client also hangs during close.
      void client.close().catch(() => { /* ignore */ });
    } else {
      void Promise.resolve(transport.close()).catch(() => { /* ignore */ });
    }
    // The abandoned handshake/readiness probe may still settle; close it if it
    // wins the race late, and absorb its rejection so it is not unhandled.
    connectPromise.then(
      (connected) => connected.client.close().catch(() => { /* ignore */ }),
      () => { /* connect failed; transport already closed */ }
    );
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Connect to MCP servers using AI SDK createMCPClient
 * @param servers Optional server configurations
 * @param debug Enable debug logging
 * @param basePath Agent-file directory used to resolve executable paths
 * @param cwd Logical run working directory inherited by stdio MCP subprocesses
 * @returns Array of MCP client connections
 */
export async function connectMCP(
  servers?: MCPServersConfig,
  debug: boolean = false,
  basePath?: string,
  cwd?: string
): Promise<MCPConnection[]> {
  if (!servers) {
    logger.debug('[MCP] No MCP servers configured');
    return [];
  }
  
  logger.info(`[MCP] Connecting to ${Object.keys(servers).length} MCP server(s): ${Object.keys(servers).join(', ')}`);
  
  // Note: Environment variables are already loaded in index.ts before this is called
  // The envFile parameter is kept for backwards compatibility but is no longer used here
  
  // Create promises for all server connections in parallel
  const connectionPromises = Object.entries(servers).map(async ([name, config]) => {
    // Track partially-created clients so a mid-connect failure doesn't orphan
    // a live stdio subprocess.
    let client: MCPClient | undefined;
    try {
      logger.debug(`[MCP] Configuring server: ${name} - ${JSON.stringify(config)}`);

      // Create transport based on config type
      const transport = createTransport(name, config, debug, basePath, cwd);

      // Create MCP client using AI SDK's built-in method
      const connected = await connectWithTimeout(
        name,
        transport,
        config.connectTimeout ?? DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS,
        { preloadTools: 'url' in config }
      );
      client = connected.client;

      // For HTTP transports, immediately fetch tools to ensure connection is ready
      // This follows the official AI SDK pattern for MCP clients
      let preloadedTools = connected.preloadedTools;
      if ('url' in config) {
        logger.debug(`[MCP] HTTP connection verified and ${Object.keys(preloadedTools ?? {}).length} tools loaded for: ${name}`);
      }

      // Debug, not info: connection chatter repeats per server per run and drowns
      // out real output in the session log view.
      logger.debug(`Connected to MCP server: ${name}`);

      return {
        name,
        client,
        config,  // Store config for accessing toolTimeout and other settings
        ...(preloadedTools && { preloadedTools }),
        ...(config.disallowedTools && { disallowedTools: config.disallowedTools })
      };
    } catch (error) {
      // Close whatever was already established so a failed connect doesn't
      // leave a live subprocess/transport behind.
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }

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
      const wrapped = new Error(errorMessage) as Error & { serverName?: string };
      wrapped.serverName = name;
      throw wrapped;
    }
  });
  
  // Execute all connections in parallel and wait for all to complete
  // Using Promise.allSettled to handle partial failures gracefully
  const results = await Promise.allSettled(connectionPromises);
  
  const connections: MCPConnection[] = [];
  const failedServers: string[] = [];
  let fatalError: unknown;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      connections.push(result.value);
    } else {
      // Check if this is a fatal error (missing required env vars)
      if (result.reason?.fatal && fatalError === undefined) {
        fatalError = result.reason;
      }

      failedServers.push(result.reason?.serverName ?? 'unknown');
    }
  }

  // On a fatal error the caller never receives the connections, so close the
  // ones that did succeed before re-throwing to exit the CLI.
  if (fatalError !== undefined) {
    for (const conn of connections) {
      try { await conn.client.close(); } catch { /* ignore */ }
    }
    throw fatalError;
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
async function getMCPResources(connection: MCPConnection): Promise<MCPResource[]> {
  // Servers declare resource support during initialize; asking anyway just
  // buys a guaranteed "method not found" round trip per server per run.
  if (!connection.client.initializeResult?.capabilities?.resources) {
    logger.debug(`Server ${connection.name} does not advertise resources`);
    return [];
  }

  try {
    const response = await connection.client.listResources();

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
function createResourceTools(connection: MCPConnection, resources: MCPResource[]): Record<string, Tool> {
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
      try {
        const response = await connection.client.readResource({ uri });

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
      // If tools were preloaded during connection (HTTP), use them
      // Otherwise, fetch them now (stdio)
      // Cast to Record<string, Tool> since McpToolSet is structurally compatible
      const clientTools = connection.preloadedTools || await connection.client.tools() as Record<string, Tool>;

      // Log what tools were retrieved
      const toolNames = Object.keys(clientTools);
      const source = connection.preloadedTools ? '(preloaded)' : '(fetched)';
      // Debug, not info: per-server tool inventories are setup chatter that
      // buries assistant/tool output in the session log view.
      logger.debug(`[MCP] Retrieved ${toolNames.length} tools from ${connection.name} ${source}${toolNames.length > 0 ? ': ' + toolNames.join(', ') : ''}`);

      // Add tools with prefixed names to avoid conflicts and wrap execution (like opencode)
      const disallowedTools: string[] = [];
      for (const [toolName, tool] of Object.entries(clientTools)) {
        // Check if this tool is disallowed
        if (isToolDisallowed(toolName, connection.disallowedTools)) {
          disallowedTools.push(toolName);
          continue;
        }
        
        const prefixedName = `mcp__${connection.name}__${toolName}`;
        
        // Wrap the tool execution like opencode does
        const originalExecute = tool.execute;
        if (!originalExecute) {
          continue;
        }
        
        // Get timeout configuration for this server
        const timeoutSeconds = resolveToolTimeout(connection.config?.toolTimeout);

        // Create wrapped tool with proper result handling and timeout.
        const wrappedTool = {
          ...tool,
          toModelOutput: mcpResultToModelOutput,
          execute: async (args: any, opts: any) => {
              let result: any;

              // Apply timeout if configured (0 means no timeout)
              if (timeoutSeconds > 0) {
                let timeoutId: ReturnType<typeof setTimeout> | undefined;
                const timeoutPromise = new Promise((_, reject) => {
                  timeoutId = setTimeout(() => {
                    const error = new Error(`Tool timed out after ${timeoutSeconds}s`);
                    error.name = 'TimeoutError';
                    reject(error);
                  }, timeoutSeconds * 1000);
                });

                try {
                  result = await Promise.race([
                    originalExecute(args, opts),
                    timeoutPromise
                  ]);
                } finally {
                  // Otherwise the pending timer keeps the event loop alive
                  // for up to timeoutSeconds after the tool finishes.
                  clearTimeout(timeoutId);
                }
              } else {
                // No timeout - execute normally
                result = await originalExecute(args, opts);
              }

              // Handle MCP result format (like opencode does)
              if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content)) {
                // Validate/convert now as well as at model projection time so an
                // unsupported protocol block is a visible tool error.
                mcpResultToModelOutput({ output: result });
                const textOutput = result.content
                  .filter((x: any) => x.type === "text")
                  .map((x: any) => x.text)
                  .join("\n\n");

                // Check for isError flag - MCP servers return this when tool execution fails
                if (result.isError === true) {
                  throw new Error(textOutput || JSON.stringify(result.content) || 'Tool execution failed');
                }

                // Additional check: Parse the content to detect API error responses
                // Some MCP servers don't set isError but return error JSON
                // Look for common error patterns like {"status": 400, "object": "error", ...}
                try {
                  const parsed = JSON.parse(textOutput);
                  if (parsed && typeof parsed === 'object') {
                    // Check for HTTP error status codes (4xx, 5xx)
                    const hasErrorStatus = typeof parsed.status === 'number' && parsed.status >= 400;
                    const hasErrorObject = parsed.object === 'error' || parsed.error;
                    const hasErrorCode = typeof parsed.code === 'string' && parsed.code.includes('error');

                    // Require an explicit error marker alongside the status:
                    // a bare {status: 404, ...} may just be a tool reporting
                    // the result of someone else's HTTP request.
                    if (hasErrorObject && (hasErrorStatus || hasErrorCode)) {
                      const errorMsg = parsed.message || parsed.error?.message || textOutput;
                      throw new Error(errorMsg);
                    }
                  }
                } catch (parseError) {
                  // If it's a SyntaxError from JSON.parse, ignore it (content is not JSON)
                  // Otherwise, re-throw (it's our intentional error from the error detection above)
                  if (!(parseError instanceof SyntaxError)) {
                    throw parseError;
                  }
                }

                // Keep the raw result so toModelOutput can carry images,
                // structured content, resources, and files to the provider.
                return result;
              }

              // Fallback for non-standard result formats - return string directly
              // AI SDK v6 handles automatic conversion to provider format
              return typeof result === 'string' ? result : JSON.stringify(result);
          }
        };
        
        connectionTools[prefixedName] = wrappedTool;
      }
      if (disallowedTools.length > 0) {
        const toolsList = disallowedTools.map(name => `'${name}'`).join(', ');
        logger.info(`[MCP] Tools disallowed for server ${connection.name}: ${toolsList}`);
      }
    } catch (error) {
      logger.warn(`[MCP] Failed to get tools from ${connection.name}: ${error instanceof Error ? error.message : String(error)}`);
      logger.debug(`[MCP] Full error for ${connection.name}: ${error instanceof Error ? error.stack : String(error)}`);
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

  // Log final tool count
  const toolCount = Object.keys(tools).length;
  if (toolCount > 0) {
    logger.debug(`[MCP] Total tools loaded: ${toolCount}`);
    logger.debug(`[MCP] Tool names: ${Object.keys(tools).join(', ')}`);
  } else {
    logger.debug(`[MCP] No tools were loaded from any MCP server`);
  }

  return tools;
}
