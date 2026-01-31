import matter from 'gray-matter';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { logger } from './utils/logger';
import { ToolsConfigSchema } from './tools/index.js';
import { ScheduleConfigSchema } from './scheduler/index.js';
import { StoreConfigSchema } from './store/index.js';
import { LearningConfigSchema } from './learning/index.js';

/**
 * Error thrown when agent configuration is invalid
 * Used for telemetry to track common config issues without exposing sensitive data
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public field: string,  // e.g., "model", "mcpServers.foo" (for telemetry)
    public issue: string   // Zod error code: "invalid_type", "unrecognized_keys", etc. (for telemetry)
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Schema for MCP server configuration
const MCPServerSchema = z.union([
  // Stdio configuration (has command)
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    requiredEnvVars: z.array(z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    toolTimeout: z.number().positive().optional()
  }),
  // HTTP configuration (has url)
  z.object({
    url: z.string().url().refine(
      (url) => url.startsWith('http://') || url.startsWith('https://'),
      { message: 'URL must use http:// or https:// protocol' }
    ),
    sessionId: z.string().optional(),
    auth: z.object({
      type: z.enum(['bearer']).optional(),
      token: z.string().optional()
    }).optional(),
    headers: z.record(z.string()).optional(),
    requiredEnvVars: z.array(z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    toolTimeout: z.number().positive().optional()
  })
]);

// Schema for agent configuration as per spec
// Supports both mcp_servers (deprecated) and mcpServers (preferred)
const AgentSchema = z.object({
  model: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  notes: z.string().optional(),
  timeout: z.number().positive().optional(),
  maxSteps: z.number().positive().int().optional(),
  openai: z.object({
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    textVerbosity: z.enum(['low', 'medium', 'high']).optional()
  }).strict().optional(),
  mcp_servers: z.record(MCPServerSchema).optional(),  // Deprecated: use mcpServers
  mcpServers: z.record(MCPServerSchema).optional(),   // Preferred: camelCase
  subagents: z.array(z.object({
    path: z.string(),
    name: z.string().optional(),
    maxSteps: z.number().optional()
  })).optional(),
  tools: ToolsConfigSchema.optional(),
  schedule: ScheduleConfigSchema.optional(),
  // Store configuration: true for isolated store, string for shared store
  store: StoreConfigSchema.optional(),
  // Agent type: currently only 'manager' is supported
  type: z.enum(['manager']).optional(),
  // Learning configuration: extract and apply learnings from execution
  learning: LearningConfigSchema.optional()
}).transform((data) => {
  // Handle backward compatibility: support both mcp_servers and mcpServers
  if (data.mcp_servers && data.mcpServers) {
    throw new Error('Cannot specify both "mcp_servers" and "mcpServers". Use "mcpServers" (camelCase) only.');
  }

  // Normalize to mcpServers and warn about deprecation
  if (data.mcp_servers && !data.mcpServers) {
    logger.warn('The "mcp_servers" field is deprecated. Please use "mcpServers" (camelCase) instead.');
    return {
      ...data,
      mcpServers: data.mcp_servers,
      mcp_servers: undefined  // Remove deprecated field
    };
  }

  // Experimental feature warnings
  if (data.type === 'manager') {
    logger.warn('[Experimental] Manager agents (type: manager) are experimental and may change in future versions.');
  }
  if (data.store) {
    logger.warn('[Experimental] Store feature is experimental and may change in future versions.');
  }

  return data;
});

export type AgentConfig = z.infer<typeof AgentSchema>;

export interface ParsedAgent {
  name: string;
  config: AgentConfig;
  instructions: string;
  description?: string;
}

/**
 * Parse agent from markdown content with YAML frontmatter
 * @param content The markdown content with YAML frontmatter
 * @param name The name of the agent
 * @returns Parsed agent configuration and instructions
 */
export function parseAgentContent(content: string, name: string): ParsedAgent {
  try {
    // Parse YAML frontmatter
    const { data, content: instructions } = matter(content);
    
    // Validate configuration with Zod
    const config = AgentSchema.parse(data);

    // Return parsed agent
    return {
      name,
      config,
      instructions: instructions.trim(),
      ...(config.description && { description: config.description })
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstError = error.errors[0];
      const message = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      // Sanitize field path: only include top-level field name to avoid exposing user-defined keys
      // e.g., "mcpServers.my-secret-server.command" -> "mcpServers"
      const topLevelField = String(firstError.path[0] ?? 'root');
      throw new ConfigError(
        `Invalid agent configuration: ${message}`,
        topLevelField,
        firstError.code
      );
    }
    throw error;
  }
}

/**
 * Parse agent from markdown file with YAML frontmatter
 * @param filePath Path to the agent markdown file
 * @returns Parsed agent configuration and instructions
 */
export async function parseAgent(filePath: string): Promise<ParsedAgent> {
  try {
    // Validate file extension
    if (!filePath.endsWith('.agentuse')) {
      throw new Error(`Invalid file extension. Agent files must use .agentuse extension (got: ${filePath})`);
    }
    
    // Resolve to absolute path
    const absolutePath = resolve(filePath);
    
    // Read file content
    const content = await readFile(absolutePath, 'utf-8');
    
    // Extract agent name from filename (without .agentuse extension)
    const name = basename(filePath).replace(/\.agentuse$/, '');
    
    // Parse using the content parser
    return parseAgentContent(content, name);
  } catch (error) {
    if ((error as unknown as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}