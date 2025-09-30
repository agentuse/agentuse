import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadToolModule, loadSpecificExport } from './loader.js';
import { zodToJsonSchema } from './schema.js';
import type { ToolDefinition, ToolContext, CreateServerOptions } from './types.js';

/**
 * Create and start an MCP stdio server from a tool file
 *
 * @param options - Configuration options
 */
export async function createToolServer(options: CreateServerOptions): Promise<void> {
  const { toolPath, exportName, env = {} } = options;

  // Apply environment variables
  Object.assign(process.env, env);

  // Load the tool module
  let toolModule;
  try {
    if (exportName) {
      // Load specific export as single tool
      const tool = await loadSpecificExport(toolPath, exportName);
      toolModule = tool;
    } else {
      // Load all exports
      toolModule = await loadToolModule(toolPath);
    }
  } catch (error) {
    console.error(`Failed to load tool module: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'simple-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Store tools for execution
  const tools = new Map<string, ToolDefinition>();

  // Register tools
  if ('execute' in toolModule && 'parameters' in toolModule) {
    // Single tool (default export or specific export)
    const tool = toolModule as ToolDefinition;
    const toolName = tool.name || exportName || 'tool';
    tools.set(toolName, tool);
  } else {
    // Multiple tools (named exports)
    for (const [name, tool] of Object.entries(toolModule as Record<string, ToolDefinition>)) {
      tools.set(name, tool);
    }
  }

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const toolList: any[] = [];

    for (const [name, tool] of tools) {
      toolList.push({
        name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.parameters)
      });
    }

    return { tools: toolList };
  });

  // Handle tool execution request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = tools.get(name);
    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool "${name}" not found`
      );
    }

    try {
      // Validate parameters with Zod
      const validatedParams = tool.parameters.parse(args || {});

      // Create abort controller for cancellation support
      const abortController = new AbortController();

      // Create context object for the tool
      const context: ToolContext = {
        sessionId: process.env.SIMPLE_MCP_SESSION_ID || process.env.AGENTUSE_SESSION_ID || 'default',
        callId: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        agent: process.env.SIMPLE_MCP_AGENT || process.env.AGENTUSE_AGENT_NAME || 'simple-mcp',
        abort: abortController.signal,
        workingDirectory: process.cwd(),
        projectRoot: process.env.SIMPLE_MCP_PROJECT_ROOT || process.env.AGENTUSE_PROJECT_ROOT || process.cwd(),
        metadata: (info) => {
          // Send metadata through stderr as JSON
          process.stderr.write(JSON.stringify({ type: 'metadata', ...info }) + '\n');
        }
      };

      // Execute the tool
      const result = await tool.execute(validatedParams, context);

      // Format and return result
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
        );
      }

      // Handle other errors
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Helper function to generate command for spawning this server
 * Used by tool runners to create subprocess configurations
 *
 * @param options - Server options
 * @returns Command configuration for spawning
 */
export function createMCPCommand(options: CreateServerOptions) {
  const { toolPath, exportName, env = {} } = options;

  // Determine if we need tsx (for .ts files)
  const isTypeScript = toolPath.endsWith('.ts');

  const args: string[] = [];

  if (isTypeScript) {
    // Use tsx for TypeScript files
    args.push('tsx');
  }

  // Add this module's server script (will be CLI in practice)
  args.push('simple-mcp', 'serve', toolPath);

  if (exportName) {
    args.push('--export', exportName);
  }

  return {
    command: isTypeScript ? 'npx' : 'node',
    args,
    env
  };
}