import type { Tool } from 'ai';
import { z } from 'zod';
import { parseAgent } from './parser';
import { connectMCP, type MCPServersConfig } from './mcp';
import { logger } from './utils/logger';
import { executeAgentCore, processAgentStream } from './runner';
import { DoomLoopDetector } from './tools/index.js';
import { resolve, dirname } from 'path';
import { computeAgentId } from './utils/agent-id';
import { SessionManager } from './session/manager';
import { loadAgentTools } from './runner/tools-loader';
import { buildSystemMessages } from './runner/system-messages';
import { createSessionAndMessage } from './runner/session-helper';

// Constants
const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

/**
 * Get the maximum sub-agent nesting depth from environment or use default
 * Exported for testing purposes
 */
export function getMaxSubAgentDepth(): number {
  const envValue = process.env.MAX_SUBAGENT_DEPTH;
  if (envValue) {
    const parsed = parseInt(envValue);
    if (isNaN(parsed) || parsed <= 0) {
      logger.warn(`Invalid MAX_SUBAGENT_DEPTH value: "${envValue}". Using default: ${DEFAULT_MAX_SUBAGENT_DEPTH}`);
      return DEFAULT_MAX_SUBAGENT_DEPTH;
    }
    return parsed;
  }
  return DEFAULT_MAX_SUBAGENT_DEPTH;
}

/**
 * Create a tool that runs another agent as a sub-agent
 * @param agentPath Path to the agent file (.agentuse)
 * @param maxSteps Maximum steps the sub-agent can take
 * @param basePath Optional base path for resolving relative paths
 * @param modelOverride Optional model override from parent agent
 * @param depth Current nesting depth (0 = main agent)
 * @param callStack Array of agent paths in the call stack for cycle detection
 * @param sessionManager Optional session manager for logging
 * @param parentSessionID Optional parent session ID
 * @param parentAgentId Optional parent agent ID (file-path-based identifier)
 * @param projectContext Optional project context (root, cwd)
 * @returns Tool that executes the sub-agent
 */
export async function createSubAgentTool(
  agentPath: string,
  maxSteps: number = 50,
  basePath?: string,
  modelOverride?: string,
  depth: number = 0,
  callStack: string[] = [],
  sessionManager?: SessionManager,
  parentSessionID?: string,
  parentAgentId?: string,
  projectContext?: { projectRoot: string; cwd: string },
  abortSignal?: AbortSignal
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

      // Compute agentId (file-path-based identifier) for session operations
      const agentId = computeAgentId(resolvedPath, projectContext?.projectRoot, agent.name);

      // Declare session variables outside try block so they're accessible in catch
      let subagentSessionID: string | undefined;
      let subagentMsgID: string | undefined;
      let subagentSessionManager: SessionManager | undefined;

      try {
        logger.info(`[SubAgent:depth=${depth}] Starting ${agent.name}${task ? ` with task: ${task.slice(0, 100)}...` : ''}`);

        // Connect to any MCP servers the sub-agent needs
        // Use the sub-agent's directory as base path for resolving relative paths
        const subAgentBasePath = dirname(resolvedPath);
        const mcpConnections = agent.config.mcpServers
          ? await connectMCP(agent.config.mcpServers as MCPServersConfig, false, subAgentBasePath)
          : [];

        // Load all agent tools (MCP, configured, skill, store) using shared logic
        const loadedTools = await loadAgentTools({
          agent,
          projectContext,
          agentDir: subAgentBasePath,
          agentFilePath: resolvedPath,
          mcpConnections,
          logPrefix: '[SubAgent] ',
        });

        // Load nested sub-agents if within depth limit (will be populated after session creation)
        const maxDepth = getMaxSubAgentDepth();
        let nestedSubAgentTools: Record<string, Tool> = {};

        // Check depth limit but don't create nested tools yet
        if (depth + 1 >= maxDepth && agent.config.subagents && agent.config.subagents.length > 0) {
          // At depth limit, warn that nested sub-agents are being skipped
          logger.warn(`[SubAgent:depth=${depth}] Max depth ${maxDepth} reached, skipping ${agent.config.subagents.length} nested sub-agent(s) for ${agent.name}`);
        }

        // Initially all loaded tools (nested subagents will be added after session creation)
        let tools = { ...loadedTools.all };

        try {
          // Build system messages using shared logic
          const systemMessagesResult = await buildSystemMessages({
            agent,
            isSubAgent: true,
            agentFilePath: resolvedPath,
            projectRoot: projectContext?.projectRoot,
          });
          const systemMessages = systemMessagesResult.messages;

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

          // Create session for this subagent if SessionManager is provided
          if (sessionManager && parentSessionID && parentAgentId && projectContext) {
            try {
              // Create NEW SessionManager instance for this subagent
              // This eliminates shared state issues with parent agent
              subagentSessionManager = new SessionManager();

              // Set parent path on the NEW instance using parent's full path
              const parentFullPath = sessionManager.getFullPath();
              if (parentFullPath) {
                subagentSessionManager.setParentPath(parentFullPath);
              }

              const taskPrompt = task && task.trim() && !task.match(/^(run|execute|perform|do)$/i)
                ? task
                : undefined;

              const sessionResult = await createSessionAndMessage({
                sessionManager: subagentSessionManager,
                agent,
                agentFilePath: resolvedPath,
                systemMessages: systemMessages.map(m => m.content),
                task: agent.instructions,
                userPrompt: taskPrompt,
                projectContext,
                version: process.env.npm_package_version || 'unknown',
                config: {
                  ...(agent.config.timeout !== undefined && { timeout: agent.config.timeout }),
                  ...(agent.config.maxSteps !== undefined && { maxSteps: agent.config.maxSteps }),
                  ...(agent.config.mcpServers && { mcpServers: Object.keys(agent.config.mcpServers) }),
                  ...(agent.config.subagents && { subagents: agent.config.subagents.map(s => ({
                    path: s.path,
                    ...(s.name && { name: s.name })
                  })) }),
                },
                isSubAgent: true,
                parentSessionID,
              });

              subagentSessionID = sessionResult.sessionID;
              subagentMsgID = sessionResult.messageID;

              logger.debug(`[SubAgent] Created session ${subagentSessionID} for ${agent.name}`);
            } catch (error) {
              logger.warn(`[SubAgent] Failed to create session: ${(error as Error).message}`);
            }
          }

          // Now create nested sub-agent tools after this subagent's session exists
          // Pass the NEW subagent SessionManager instance to nested tools
          if (depth + 1 < maxDepth && agent.config.subagents && agent.config.subagents.length > 0) {
            nestedSubAgentTools = await createSubAgentTools(
              agent.config.subagents,
              subAgentBasePath,
              agent.config.model,
              depth + 1,
              [...callStack, resolvedPath],
              subagentSessionManager,  // Pass NEW instance (not parent's)
              subagentSessionID,
              agentId,
              projectContext,
              abortSignal  // Pass parent's abort signal to nested subagents
            );

            // Merge nested subagent tools into tools
            tools = { ...loadedTools.all, ...nestedSubAgentTools };
          }

          // Create doom loop detector for sub-agent
          const doomLoopDetector = new DoomLoopDetector({ threshold: 3, action: 'error' });

          // Process the agent stream using the NEW SessionManager instance
          const result = await processAgentStream(
            executeAgentCore(agent, tools, {
              userMessage,
              systemMessages,
              maxSteps,
              ...(abortSignal && { abortSignal }),  // Pass parent's abort signal
              subAgentNames: new Set(Object.keys(nestedSubAgentTools))  // Track nested sub-agent names for logging
            }),
            subagentSessionID && subagentMsgID && subagentSessionManager ? {
              sessionManager: subagentSessionManager,  // Use NEW instance
              sessionID: subagentSessionID,
              agentId,
              messageID: subagentMsgID,
              collectToolCalls: true,
              logPrefix: '[SubAgent] ',
              doomLoopDetector
            } : {
              collectToolCalls: true,
              logPrefix: '[SubAgent] ',
              doomLoopDetector
            }
          );

          const duration = Date.now() - startTime;
          logger.info(`[SubAgent:depth=${depth}] ${agent.name} completed in ${(duration / 1000).toFixed(2)}s`);

          // Log token usage
          if (result.usage?.totalTokens) {
            logger.info(`[SubAgent:depth=${depth}] ${agent.name} tokens used: ${result.usage.totalTokens}`);
          }

          // Update session message with final token usage and mark session completed
          if (subagentSessionManager && subagentSessionID && subagentMsgID && result.usage) {
            try {
              await subagentSessionManager.updateMessage(subagentSessionID, agentId, subagentMsgID, {
                time: { completed: Date.now() },
                assistant: {
                  tokens: {
                    input: result.usage.inputTokens || 0,
                    output: result.usage.outputTokens || 0
                  }
                }
              });
              await subagentSessionManager.setSessionCompleted(subagentSessionID, agentId);
            } catch (error) {
              logger.debug(`[SubAgent] Failed to update message with token usage: ${(error as Error).message}`);
            }
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
          // Clean up store lock
          if (loadedTools.store) {
            await loadedTools.store.releaseLock();
          }

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

        // Mark session as error if we have session info
        if (subagentSessionManager && subagentSessionID) {
          try {
            await subagentSessionManager.setSessionError(subagentSessionID, agentId, {
              code: 'EXECUTION_ERROR',
              message: errorMsg
            });
          } catch {
            // Ignore session update errors
          }
        }

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
  callStack: string[] = [],
  sessionManager?: SessionManager,
  parentSessionID?: string,
  parentAgentId?: string,
  projectContext?: { projectRoot: string; cwd: string },
  abortSignal?: AbortSignal
): Promise<Record<string, Tool>> {
  if (!subAgents || subAgents.length === 0) {
    return {};
  }

  const tools: Record<string, Tool> = {};

  for (const config of subAgents) {
    try {
      const tool = await createSubAgentTool(
        config.path,
        config.maxSteps,
        basePath,
        modelOverride,
        depth,
        callStack,
        sessionManager,
        parentSessionID,
        parentAgentId,
        projectContext,
        abortSignal
      );
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

      // Add subagent__ prefix
      const prefixedName = `subagent__${name}`;
      tools[prefixedName] = tool;
      logger.info(`[SubAgent] Registered sub-agent: ${prefixedName}`);

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
