import { z } from 'zod';

/**
 * Context object passed to tool execute functions
 */
export interface ToolContext {
  /** Unique session identifier */
  sessionId: string;

  /** Unique call identifier for this tool invocation */
  callId: string;

  /** Name of the agent/application invoking the tool */
  agent: string;

  /** AbortSignal for cancellation support */
  abort: AbortSignal;

  /** Current working directory */
  workingDirectory: string;

  /** Project root directory */
  projectRoot: string;

  /** Report metadata back to the MCP client */
  metadata(info: {
    title?: string;
    progress?: number;
    metadata?: Record<string, unknown>;
  }): void;
}

/**
 * Tool definition format expected in user files
 */
export interface ToolDefinition {
  /** Optional tool name (defaults to export name or 'tool') */
  name?: string;

  /** Description of what the tool does */
  description: string;

  /** Zod schema for validating tool parameters */
  parameters: z.ZodType<any, any, any>;

  /** Execute function that implements the tool logic */
  execute: (params: any, context?: ToolContext) => any | Promise<any>;
}

/**
 * Module export formats supported for tool files
 */
export type ToolModuleExport =
  | ToolDefinition  // Single tool as default export
  | Record<string, ToolDefinition>;  // Multiple tools as named exports

/**
 * Options for creating an MCP server from a tool file
 */
export interface CreateServerOptions {
  /** Path to the tool file (.js or .ts) */
  toolPath: string;

  /** Optional: specific export name to load (for named exports) */
  exportName?: string;

  /** Optional: environment variables to pass to the server */
  env?: Record<string, string>;
}

/**
 * Command configuration for spawning an MCP server subprocess
 */
export interface MCPCommand {
  /** Command to execute (e.g., 'node', 'npx') */
  command: string;

  /** Arguments to pass to the command */
  args: string[];

  /** Optional environment variables */
  env?: Record<string, string>;
}