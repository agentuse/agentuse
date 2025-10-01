import type { Tool } from 'ai';
import { z } from 'zod';
import { parseAgent } from './parser';
import { connectMCP, getMCPTools, type MCPServersConfig } from './mcp';
import { logger } from './utils/logger';
import { executeAgentCore, processAgentStream, buildAutonomousAgentPrompt } from './runner';
import { resolve, dirname } from 'path';

// Constants
const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

/**
 * Get the maximum sub-agent nesting depth from environment or use default
 */
function getMaxSubAgentDepth(): number {
  return parseInt(process.env.MAX_SUBAGENT_DEPTH || String(DEFAULT_MAX_SUBAGENT_DEPTH));
}

/**
 * Create a tool that runs another agent as a sub-agent
 * @param agentPath Path to the agent file (.agentuse)
 * @param maxSteps Maximum steps the sub-agent can take
 * @param basePath Optional base path for resolving relative paths
 * @param modelOverride Optional model override from parent agent
 * @param depth Current nesting depth (0 = main agent)
 * @param callStack Array of agent paths in the call stack for cycle detection
 * @returns Tool that executes the sub-agent
 */
export async function createSubAgentTool(
  agentPath: string,
  maxSteps: number = 50,
  basePath?: string,
  modelOverride?: string,
  depth: number = 0,
  callStack: string[] = []
): Promise<Tool> {
  // Resolve the path relative to the base path if provided
  const resolvedPath = basePath ? resolve(basePath, agentPath) : agentPath;

  // Guard: Check for cycles
  if (callStack.includes(resolvedPath)) {
    const cycleChain = [...callStack, resolvedPath].join(' → ');
    logger.error(`[SubAgent] Cycle detected: ${cycleChain}`);
    throw new Error(`Circular sub-agent dependency detected: ${cycleChain}`);
  }

  // Parse the agent file
  const agent = await parseAgent(resolvedPath);

  // Apply model override if provided
  if (modelOverride) {
    agent.config.model = modelOverride;
  }

  return {
    description: agent.description || `Run ${agent.name} agent: ${agent.instructions.split('\n')[0].slice(0, 100)}...`,
    inputSchema: z.object({
      task: z.string().optional().describe('Optional additional task or question for the sub-agent'),
      context: z.record(z.any()).optional().describe('Additional context to pass to the sub-agent')
    }),
    execute: async ({ task, context }) => {
      const startTime = Date.now();
      try {
        logger.info(`[SubAgent:depth=${depth + 1}] Starting ${agent.name}${task ? ` with task: ${task.slice(0, 100)}...` : ''}`);

        // Connect to any MCP servers the sub-agent needs
        // Use the sub-agent's directory as base path for resolving relative paths
        const subAgentBasePath = dirname(resolvedPath);
        const mcpConnections = agent.config.mcp_servers
          ? await connectMCP(agent.config.mcp_servers as MCPServersConfig, false, subAgentBasePath)
          : [];

        const mcpTools = await getMCPTools(mcpConnections);

        // Load nested sub-agents if within depth limit
        const maxDepth = getMaxSubAgentDepth();
        let nestedSubAgentTools: Record<string, Tool> = {};

        if (depth + 1 < maxDepth) {
          // Within limit, load nested sub-agents
          if (agent.config.subagents && agent.config.subagents.length > 0) {
            nestedSubAgentTools = await createSubAgentTools(
              agent.config.subagents,
              subAgentBasePath,
              agent.config.model,
              depth + 1,
              [...callStack, resolvedPath]
            );
          }
        } else if (agent.config.subagents && agent.config.subagents.length > 0) {
          // At depth limit, warn that nested sub-agents are being skipped
          logger.warn(`[SubAgent:depth=${depth + 1}] Max depth ${maxDepth} reached, skipping ${agent.config.subagents.length} nested sub-agent(s) for ${agent.name}`);
        }

        // Merge MCP tools and nested sub-agent tools
        const tools = { ...mcpTools, ...nestedSubAgentTools };
        
        try {
          // Build system messages (same as main agent)
          const systemMessages: Array<{role: string, content: string}> = [];
          
          if (agent.config.model.includes('anthropic')) {
            systemMessages.push({
              role: 'system',
              content: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
            });
          }
          
          const todayDate = new Date().toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          });
          
          systemMessages.push({
            role: 'system', 
            content: buildAutonomousAgentPrompt(todayDate, true)
          });
          
          // Build user message: agent instructions + optional parent task
          let userMessage = agent.instructions;
          
          // Only append task if it's meaningful (not empty or generic)
          if (task && task.trim() && !task.match(/^(run|execute|perform|do)$/i)) {
            userMessage = context 
              ? `${agent.instructions}\n\nAdditional task: ${task}\n\nContext: ${JSON.stringify(context)}`
              : `${agent.instructions}\n\nAdditional task: ${task}`;
          } else if (context) {
            userMessage = `${agent.instructions}\n\nContext: ${JSON.stringify(context)}`;
          }
          
          // Process the agent stream
          const result = await processAgentStream(
            executeAgentCore(agent, tools, {
              userMessage,
              systemMessages,
              maxSteps,
              subAgentNames: new Set(Object.keys(nestedSubAgentTools))  // Track nested sub-agent names for logging
            }),
            {
              collectToolCalls: true,
              logPrefix: '[SubAgent] '
            }
          );
          
          const duration = Date.now() - startTime;
          logger.info(`[SubAgent:depth=${depth + 1}] ${agent.name} completed in ${(duration / 1000).toFixed(2)}s`);

          // Log token usage
          if (result.usage?.totalTokens) {
            logger.info(`[SubAgent:depth=${depth + 1}] ${agent.name} tokens used: ${result.usage.totalTokens}`);
          }
          
          return {
            output: result.text || 'Sub-agent completed without text response',
            metadata: {
              agent: agent.name,
              toolCalls: result.toolCalls && result.toolCalls.length > 0 ? result.toolCalls : undefined,
              tokensUsed: result.usage?.totalTokens,
              duration  // Add duration in ms to metadata
            }
          };
        } finally {
          // Clean up MCP connections
          for (const conn of mcpConnections) {
            try {
              await conn.client.close();
            } catch (error) {
              // Ignore errors when closing
            }
          }
        }
        
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[SubAgent] ${agent.name} failed: ${errorMsg}`);
        return {
          output: `Sub-agent ${agent.name} failed: ${errorMsg}`
        };
      }
    }
  };
}

/**
 * Create tools for multiple sub-agents
 * @param subAgents Array of sub-agent configurations
 * @param basePath Optional base path for resolving relative agent paths
 * @param modelOverride Optional model override from parent agent
 * @param depth Current nesting depth (0 = main agent)
 * @param callStack Array of agent paths in the call stack for cycle detection
 * @returns Map of sub-agent tools
 */
export async function createSubAgentTools(
  subAgents?: Array<{ path: string; name?: string | undefined; maxSteps?: number | undefined }>,
  basePath?: string,
  modelOverride?: string,
  depth: number = 0,
  callStack: string[] = []
): Promise<Record<string, Tool>> {
  if (!subAgents || subAgents.length === 0) {
    return {};
  }

  const tools: Record<string, Tool> = {};

  for (const config of subAgents) {
    try {
      const tool = await createSubAgentTool(config.path, config.maxSteps, basePath, modelOverride, depth, callStack);
      // Use custom name if provided, otherwise extract from filename
      let name = config.name;
      if (!name) {
        // Extract agent name from path (e.g., "./code-reviewer.agentuse" -> "code_reviewer")
        const filename = config.path.split('/').pop()?.replace(/\.agentuse$/, '') || 'agent';
        // Replace all non-alphanumeric characters (except underscore and hyphen) with underscore
        name = filename.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_');
      }
      
      // Ensure the name is valid for API requirements (only alphanumeric, underscore, hyphen)
      name = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      
      // Support both regular name and @-prefixed name
      tools[name] = tool;
      logger.info(`[SubAgent] Registered sub-agent: ${name} (use as tool: ${name})`);
      
      // Note: @ symbol is not allowed in tool names by the API
      // So we won't register @-prefixed versions anymore
      // Users can still reference them with @ in instructions, but the actual tool name won't have @
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load sub-agent from ${config.path}: ${errorMsg}`);
      
      // Provide helpful error messages for common issues
      if (errorMsg.includes('File not found')) {
        const resolvedPath = basePath ? resolve(basePath, config.path) : config.path;
        logger.error(`  Attempted to load from: ${resolvedPath}`);
        logger.error(`  Make sure the file exists and the path is correct`);
        
        // Check for special characters that might cause issues
        if (config.path.includes(':')) {
          logger.error(`  Note: The path contains ':' which may cause file system issues`);
          logger.error(`  Consider renaming the file to use '-' or '_' instead`);
        }
      }
    }
  }
  
  return tools;
}