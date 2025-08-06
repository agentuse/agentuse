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
  })).optional()
});

export type AgentConfig = z.infer<typeof AgentSchema>;

export interface ParsedAgent {
  name: string;
  config: AgentConfig;
  instructions: string;
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
    
    // Parse YAML frontmatter
    const { data, content: instructions } = matter(content);
    
    // Validate configuration with Zod
    const config = AgentSchema.parse(data);
    
    // Extract agent name from filename (without .md extension)
    const name = basename(filePath, '.md');
    
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
    if ((error as any).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}