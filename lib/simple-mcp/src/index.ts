/**
 * simple-mcp: The simplest way to turn JavaScript/TypeScript functions into MCP stdio servers
 *
 * @example
 * ```typescript
 * // For tool runners (like AgentUse):
 * import { createMCPCommand } from 'simple-mcp';
 *
 * const { command, args, env } = createMCPCommand({
 *   toolPath: './tools/date.ts'
 * });
 *
 * // Spawn the server
 * spawn(command, args, { env });
 * ```
 *
 * @example
 * ```typescript
 * // For direct server usage:
 * import { createToolServer } from 'simple-mcp';
 *
 * await createToolServer({
 *   toolPath: './tools/date.ts',
 *   exportName: 'getCurrentTime' // optional
 * });
 * ```
 */

// Main API
export { createToolServer, createMCPCommand } from './server.js';
export { loadToolModule, loadSpecificExport } from './loader.js';
export { zodToJsonSchema } from './schema.js';

// Types
export type {
  ToolDefinition,
  ToolModuleExport,
  ToolContext,
  CreateServerOptions,
  MCPCommand
} from './types.js';