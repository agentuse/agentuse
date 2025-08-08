import matter from 'gray-matter';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { resolve, basename } from 'path';

// Schema for agent configuration as per spec
const AgentSchema = z.object({
  model: z.string(),
  mcp_servers: z.record(z.object({
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional()
  })).optional(),
  subagents: z.array(z.object({
    path: z.string(),
    name: z.string().optional(),
    maxSteps: z.number().optional()
  })).optional()
});

export type AgentConfig = z.infer<typeof AgentSchema>;

export interface ParsedAgent {
  name: string;
  config: AgentConfig;
  instructions: string;
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
      instructions: instructions.trim()
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid agent configuration: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
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
    // Resolve to absolute path
    const absolutePath = resolve(filePath);
    
    // Read file content
    const content = await readFile(absolutePath, 'utf-8');
    
    // Extract agent name from filename (without .md or .agentmd extension)
    const name = basename(filePath).replace(/\.(agentmd|md)$/, '');
    
    // Parse using the content parser
    return parseAgentContent(content, name);
  } catch (error) {
    if ((error as unknown as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}