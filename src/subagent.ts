import type { Tool } from 'ai';
import { z } from 'zod';
import { parseAgent } from './parser';
import { connectMCP, type MCPServersConfig } from './mcp';
import { logger, runWithLogSink } from './utils/logger';
import { executeAgentCore, processAgentStream } from './runner';
import { createSessionLogSink, type SessionLogSink } from './runner/session-helper';
import { DoomLoopDetector } from './tools/index.js';
import { resolve, dirname } from 'path';
import { computeAgentId } from './utils/agent-id';
import { SessionManager } from './session/manager';
import { loadAgentTools } from './runner/tools-loader';
import { buildSystemMessages } from './runner/system-messages';
import { createSessionAndMessage } from './runner/session-helper';
import { isApprovalEnabled, appendApprovalInstructions, approvalToolDefaults } from './runner/approval';
import { createAwaitHumanTool } from './tools/await-human';
import { createToolsSnapshot } from './runner/tool-snapshot';
import { SuspendSignal, isSuspendSignal } from './runner/suspend';
import { extractApiErrorDetail } from './runner/api-error';
import { usageToAssistantTokens } from './session/usage';

// Constants
const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

/**
 * Thrown at load/validation time when a delegated sub-agent enables the approval
 * gate (`approval: true`/object) but the durable session substrate needed to
 * suspend and resume it is absent (no parent session, manager, or project context).
 *
 * A delegated leaf gate works by suspending the child, parking the parent's
 * `subagent__*` step pending, and bubbling up to suspend the root so a human can
 * resolve it and the cascade resumes the chain. That requires the child to have a
 * real session to suspend into. When the substrate is missing — e.g. a sub-agent
 * tool built outside a real run — there is nowhere to suspend, so we fail loud
 * (re-thrown, not swallowed, by `createSubAgentTools`) instead of registering a
 * phantom pending approval that can never be resumed.
 */
export class SubAgentApprovalUnsupportedError extends Error {
  constructor(public agentName: string, public agentPath: string) {
    super(
      `Approval gate in delegated sub-agent "${agentName}" (${agentPath}) cannot be honored: ` +
      `no durable session substrate to suspend into (missing parent session / manager / project context). ` +
      `Run this agent under a session-backed run (e.g. \`agentuse run\` or \`agentuse serve\`), or remove "approval" from the sub-agent.`
    );
    this.name = 'SubAgentApprovalUnsupportedError';
  }
}

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
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string },
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

  // Approval gates in a delegated sub-agent require the durable session substrate
  // (parent session + manager + project context) so the child can suspend and be
  // resumed via the cascade. When present, a leaf's await_human bubbles up to the
  // root (see the suspended branch in execute below). When absent — e.g. a sub-agent
  // tool built outside a real run — there is nowhere to suspend into, so fail loud
  // at load time. Cover both `approval:` and an explicit `tools: { await_human: true }`.
  const wantsApprovalGate = isApprovalEnabled(agent.config) || agent.config.tools?.await_human === true;
  const hasApprovalSubstrate = !!(sessionManager && parentSessionID && parentAgentId && projectContext);
  if (wantsApprovalGate && !hasApprovalSubstrate) {
    throw new SubAgentApprovalUnsupportedError(agent.name, resolvedPath);
  }

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

      // Compute agentId relative to the agent's stateRoot (file-path-based,
      // stable across cwds) for session/store naming.
      const agentId = computeAgentId(resolvedPath, projectContext?.stateRoot, agent.name);

      // Declare session variables outside try block so they're accessible in catch
      let subagentSessionID: string | undefined;
      let subagentMsgID: string | undefined;
      let subagentSessionManager: SessionManager | undefined;
      let subagentLogSink: SessionLogSink | undefined;
      const toolOutputArtifacts = {
        createStream: (toolName: string, metadata?: Record<string, unknown>) => {
          if (!subagentSessionManager || !subagentSessionID || !subagentMsgID) {
            return Promise.resolve(undefined);
          }
          return subagentSessionManager.createToolOutputArtifactStream(
            subagentSessionID,
            agentId,
            subagentMsgID,
            toolName,
            metadata
          );
        },
      };

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
          toolOutputArtifacts,
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
            stateRoot: projectContext?.stateRoot,
          });
          const systemMessages = systemMessagesResult.messages;

          // Parity with the top-level run: when this leaf carries its own approval
          // gate, inject the same approval-gate instructions so it calls await_human
          // identically whether run directly or delegated. No-ops when approval is
          // not enabled. Persisted as the task below so a resumed child sees the same
          // prompt.
          const leafInstructions = appendApprovalInstructions(agent.instructions, agent.config);

          // Build user message: agent instructions + optional parent task
          let userMessage = leafInstructions;
          let cacheableUserMessage: string | undefined;

          // Only append task if it's meaningful (not empty or generic)
          if (task && task.trim() && !task.match(/^(run|execute|perform|do)$/i)) {
            userMessage = context
              ? `${leafInstructions}\n\nAdditional task: ${task}\n\nContext: ${JSON.stringify(context)}`
              : `${leafInstructions}\n\nAdditional task: ${task}`;
            cacheableUserMessage = leafInstructions;
          } else if (context) {
            userMessage = `${leafInstructions}\n\nContext: ${JSON.stringify(context)}`;
            cacheableUserMessage = leafInstructions;
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
                task: leafInstructions,
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

          // Bind the leaf's approval gate to the child session. loadAgentTools built
          // await_human before the session existed (sessionId undefined → no approval
          // URL/resume token), so rebuild it now that subagentSessionID is known. This
          // is what makes a delegated leaf gate addressable and resumable at the root.
          if (subagentSessionID && (isApprovalEnabled(agent.config) || agent.config.tools?.await_human === true)) {
            tools.await_human = createAwaitHumanTool(subagentSessionID, {
              ...approvalToolDefaults(agent.config),
              ...(projectContext?.projectRoot && { projectRoot: projectContext.projectRoot }),
            });
          }

          // Persist a tools snapshot so the child is resumable after a gate, mirroring
          // the top-level path (preparation.ts). Without it, resuming the child throws
          // "Missing tools snapshot".
          if (subagentSessionManager && subagentSessionID) {
            try {
              await subagentSessionManager.writeToolsSnapshot(subagentSessionID, agentId, createToolsSnapshot(tools));
            } catch (error) {
              logger.debug(`[SubAgent] Failed to write tools snapshot: ${(error as Error).message}`);
            }
          }

          // Create doom loop detector for sub-agent
          const doomLoopDetector = new DoomLoopDetector({ threshold: 3, action: 'error' });

          // Mirror this sub-agent's operational logs into ITS OWN session view.
          // Scoped via AsyncLocalStorage so they don't leak into the parent or a
          // sibling sub-agent running concurrently. Flushed in the finally below.
          subagentLogSink = subagentSessionManager && subagentSessionID && subagentMsgID
            ? createSessionLogSink(subagentSessionManager, subagentSessionID, agentId, subagentMsgID)
            : undefined;

          // Process the agent stream AND emit the completion logs inside the
          // sub-agent's sink scope. The tool runs inside the PARENT's stream
          // (whose sink is the active one at emit time), so logging outside this
          // scope would misattribute these lines to the parent's session.
          const runSubagentScoped = async () => {
            const streamResult = await processAgentStream(
              executeAgentCore(agent, tools, {
                userMessage,
                ...(cacheableUserMessage !== undefined && { cacheableUserMessage }),
                systemMessages,
                maxSteps,
                ...(abortSignal && { abortSignal }),  // Pass parent's abort signal
                subAgentNames: new Set(Object.keys(nestedSubAgentTools)),  // Track nested sub-agent names for logging
                ...(subagentSessionManager && { sessionManager: subagentSessionManager }),
                ...(subagentSessionID && { sessionID: subagentSessionID }),
                agentId,
                ...(subagentMsgID && { messageID: subagentMsgID })
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
            const elapsed = Date.now() - startTime;
            logger.info(`[SubAgent:depth=${depth}] ${agent.name} completed in ${(elapsed / 1000).toFixed(2)}s`);
            if (streamResult.usage?.totalTokens) {
              logger.info(`[SubAgent:depth=${depth}] ${agent.name} tokens used: ${streamResult.usage.totalTokens}`);
            }
            return { streamResult, elapsed };
          };
          const { streamResult: result, elapsed: duration } = subagentLogSink
            ? await runWithLogSink(subagentLogSink.capture, runSubagentScoped)
            : await runSubagentScoped();

          // The leaf hit its approval gate. Its own stream already wrote the pending
          // await_human part (with resume token + approval URL), so we must NOT mark the
          // child completed. Mark it suspended and bubble the gate up: throw a
          // SuspendSignal of kind 'subagent_wait' so the PARENT parks its subagent__*
          // tool part pending (pointing at this child) and the parent/root session
          // suspends durably. A human resolves it at the root and the cascade resumes.
          if (result.suspended) {
            if (!subagentSessionID || !subagentSessionManager) {
              throw new Error(`Sub-agent ${agent.name} suspended without a durable session; cannot bubble the approval gate.`);
            }
            if (subagentMsgID && result.usage) {
              try {
                await subagentSessionManager.updateMessage(subagentSessionID, agentId, subagentMsgID, {
                  assistant: {
                    tokens: usageToAssistantTokens(result.usage),
                    ...(result.contextUsage && { context: result.contextUsage })
                  }
                });
              } catch (error) {
                logger.debug(`[SubAgent] Failed to persist suspended usage: ${(error as Error).message}`);
              }
            }
            await subagentSessionManager.setSessionSuspended(subagentSessionID, agentId);
            // Bubble a pointer to this child only. The human-facing URL/token are
            // resolved at the root by getApprovalInfo descending childSessionID — we
            // deliberately do NOT propagate the child's own approval URL up.
            throw new SuspendSignal({
              kind: 'subagent_wait',
              childSessionID: subagentSessionID,
              childAgentName: agent.name,
            });
          }

          // Update session message with final token usage and mark session completed
          if (subagentSessionManager && subagentSessionID && subagentMsgID && result.usage) {
            try {
              await subagentSessionManager.updateMessage(subagentSessionID, agentId, subagentMsgID, {
                time: { completed: Date.now() },
                assistant: {
                  tokens: usageToAssistantTokens(result.usage),
                  ...(result.contextUsage && { context: result.contextUsage })
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
          // Drain any buffered operational logs into the sub-agent's session.
          if (subagentLogSink) await subagentLogSink.flush();

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
        // A bubbled approval gate (subagent_wait) must propagate so the parent parks
        // its subagent__* part pending and suspends. Swallowing it into an error text
        // result would orphan the child gate. The child session is already marked
        // suspended above, so just re-throw before any error bookkeeping.
        if (isSuspendSignal(error)) {
          throw error;
        }

        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[SubAgent] ${agent.name} failed: ${errorMsg}`);

        // Mark session as error if we have session info
        if (subagentSessionManager && subagentSessionID) {
          try {
            await subagentSessionManager.setSessionError(subagentSessionID, agentId, {
              code: 'EXECUTION_ERROR',
              // Spread first so the explicit top-level message (which carries any
              // retry-wrapper context) wins over the unwrapped provider message.
              ...extractApiErrorDetail(error),
              message: errorMsg,
            });
          } catch {
            // Ignore session update errors
          }
        }

        // An abort is the parent's cancellation/timeout, not a recoverable
        // sub-agent failure. Swallowing it into a text result would let the
        // parent keep running past its own timeout, so re-throw to propagate.
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
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
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string },
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
      // Approval-in-subagent is a hard configuration error: surface it and abort
      // the run instead of silently dropping the sub-agent tool (which would leave
      // the manager flailing with a missing tool).
      if (error instanceof SubAgentApprovalUnsupportedError) {
        throw error;
      }

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
