import type { ParsedAgent } from '../parser';
import type { MCPConnection } from '../mcp';
import type { SessionInfo, SessionManager, SessionTrigger } from '../session';
import type { AgentCompleteEvent, PluginManager } from '../plugin';
import { AuthenticationError } from '../models';
import { logger } from '../utils/logger';
import { extractLearnings } from '../learning/index.js';
import { usageToAssistantTokens } from '../session/usage';
import {
  sendRunChannelMessages,
  startRunChannels,
  suspendRunChannels,
  type RunChannelHandle
} from '../channels/run';
import { executeAgentCore } from './execution';
import { prepareAgentExecution } from './preparation';
import { processAgentStream } from './stream';
import type { PreparedAgentExecution, RunAgentResult } from './types';

type PersistedSlackRunChannelHandle = {
  channel: string;
  ts: string;
  channelId?: string;
  events: Array<'approval' | 'completion' | 'failure'>;
};

function normalizeRunChannelHandle(handle: RunChannelHandle): PersistedSlackRunChannelHandle {
  return {
    channel: handle.channel,
    ts: handle.ts,
    ...(handle.channelId !== undefined && { channelId: handle.channelId }),
    events: handle.events
  };
}

function sessionRunChannelHandles(session: SessionInfo | undefined): RunChannelHandle[] {
  return (session?.channels?.slack ?? []).map(handle => ({
    channel: handle.channel,
    ts: handle.ts,
    ...(handle.channelId !== undefined && { channelId: handle.channelId }),
    events: handle.events
  }));
}

function mergeSlackRunChannelHandles(
  existing: PersistedSlackRunChannelHandle[] = [],
  next: RunChannelHandle[]
): PersistedSlackRunChannelHandle[] {
  const merged = new Map<string, PersistedSlackRunChannelHandle>();
  for (const handle of existing) {
    merged.set(`${handle.channel}:${handle.ts}`, handle);
  }
  for (const handle of next) {
    const persisted = normalizeRunChannelHandle(handle);
    merged.set(`${persisted.channel}:${persisted.ts}`, persisted);
  }
  return Array.from(merged.values());
}

async function persistRunChannelHandles(options: {
  sessionManager?: SessionManager;
  sessionId?: string;
  agentId?: string;
  handles: RunChannelHandle[];
}): Promise<void> {
  const { sessionManager, sessionId, agentId, handles } = options;
  if (!sessionManager || !sessionId || !agentId || handles.length === 0) return;

  try {
    const found = await sessionManager.findSession(sessionId);
    const existingChannels = found?.session.channels ?? {};
    await sessionManager.updateSession(sessionId, agentId, {
      channels: {
        ...existingChannels,
        slack: mergeSlackRunChannelHandles(existingChannels.slack, handles)
      }
    });
  } catch (error) {
    logger.debug(`Failed to persist run channel handles: ${(error as Error).message}`);
  }
}

export async function persistAssistantRunState(options: {
  sessionManager?: SessionManager;
  sessionId?: string;
  agentId?: string;
  messageId?: string;
  result: Pick<RunAgentResult, 'usage' | 'contextUsage'>;
  completedAt?: number;
}): Promise<void> {
  const { sessionManager, sessionId, agentId, messageId, result, completedAt } = options;
  if (!sessionManager || !sessionId || !agentId || !messageId) return;

  await sessionManager.updateMessage(sessionId, agentId, messageId, {
    ...(completedAt !== undefined && { time: { completed: completedAt } }),
    ...(result.usage && {
      assistant: {
        tokens: usageToAssistantTokens(result.usage),
        ...(result.contextUsage && { context: result.contextUsage })
      }
    }),
    ...(!result.usage && result.contextUsage && {
      assistant: {
        context: result.contextUsage
      }
    })
  });
}

/**
 * Run an agent with AI and MCP tools
 * @param agent Parsed agent configuration
 * @param mcpClients Connected MCP clients
 * @param debug Enable debug logging
 * @param abortSignal Optional abort signal for cancellation
 * @param startTime Optional start time for timing
 * @param verbose Enable verbose logging
 * @param agentFilePath Optional path to the agent file for resolving sub-agent paths
 * @param cliMaxSteps Optional CLI override for max steps
 */
export async function runAgent(
  agent: ParsedAgent,
  mcpClients: MCPConnection[],
  _debug: boolean = false,
  abortSignal?: AbortSignal,
  startTime?: number,
  verbose: boolean = false,
  agentFilePath?: string,
  cliMaxSteps?: number,
  sessionManager?: SessionManager,
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string },
  userPrompt?: string,
  /**
   * Optional pre-computed execution context to avoid duplicate preparation work.
   *
   * **When to provide this:**
   * - CLI flows that need to display metadata (tool count, session ID) before running
   * - Contexts where agent setup needs inspection before execution
   *
   * **When to omit this:**
   * - Direct API usage where metadata inspection isn't needed
   * - Test contexts where simpler call signatures are preferred
   * - Any scenario where duplicate preparation overhead is acceptable
   *
   * **Performance benefit:**
   * Preparation involves MCP tool discovery, plugin loading, and session setup.
   * Pre-computing allows the caller to inspect this context (e.g., for UI display)
   * and then reuse it for execution, avoiding duplicate expensive operations.
   */
  preparedExecution?: PreparedAgentExecution,
  /** Suppress console output (for serve mode) */
  quiet: boolean = false,
  pluginManager?: PluginManager | null,
  captureConsole: boolean = true,
  existingSessionId?: string,
  initialRunChannelHandles?: RunChannelHandle[],
  sessionLogUserPrompt?: string,
  trigger?: SessionTrigger
): Promise<RunAgentResult> {
  // Track session info for error logging (set during preparation)
  let sessionID: string | undefined;
  let agentId: string | undefined;
  let preparation: PreparedAgentExecution | undefined;
  let captureActive = false;
  let runChannelHandles: RunChannelHandle[] = initialRunChannelHandles ?? [];

  try {
    if (captureConsole) {
      logger.startCapture();
      captureActive = true;
    }

    // Log initialization time if verbose
    if (verbose && startTime) {
      const initTime = Date.now() - startTime;
      logger.info(`Initialization completed in ${initTime}ms`);
    }

    // Use shared preparation logic (allow caller to precompute to avoid duplicate work)
    // If preparedExecution is provided, use it directly (CLI path).
    // If not provided, compute it fresh (API/test path).
    preparation = preparedExecution ?? await prepareAgentExecution({
      agent,
      mcpClients,
      agentFilePath,
      cliMaxSteps,
      sessionManager,
      projectContext,
      userPrompt,
      abortSignal,
      verbose,
      existingSessionId,
      ...(trigger && { trigger })
    });

    const {
      tools,
      systemMessages,
      userMessage,
      cacheableUserMessage,
      messages,
      maxSteps,
      subAgentNames,
      sessionID: prepSessionID,
      assistantMsgID,
      agentId: prepAgentId,
      doomLoopDetector
    } = preparation;

    // Set outer scope variables for error logging
    sessionID = prepSessionID;
    agentId = prepAgentId;

    if (
      existingSessionId &&
      sessionLogUserPrompt?.trim() &&
      sessionManager &&
      prepSessionID &&
      assistantMsgID &&
      prepAgentId
    ) {
      const now = Date.now();
      await sessionManager.addPart(prepSessionID, prepAgentId, assistantMsgID, {
        type: 'text',
        role: 'user',
        synthetic: true,
        text: sessionLogUserPrompt.trim(),
        time: { start: now, end: now }
      } as any);
    }

    if (runChannelHandles.length === 0 && sessionManager && prepSessionID) {
      try {
        const found = await sessionManager.findSession(prepSessionID);
        runChannelHandles = sessionRunChannelHandles(found?.session);
      } catch (error) {
        logger.debug(`Failed to load run channel handles: ${(error as Error).message}`);
      }
    }

    if (runChannelHandles.length === 0) {
      runChannelHandles = await startRunChannels({
        agent,
        ...(prepSessionID && { sessionId: prepSessionID }),
        ...(agentFilePath !== undefined && { agentFilePath }),
        ...(startTime !== undefined && { startTime })
      });
    }
    await persistRunChannelHandles({
      ...(sessionManager !== undefined && { sessionManager }),
      ...(prepSessionID !== undefined && { sessionId: prepSessionID }),
      ...(prepAgentId !== undefined && { agentId: prepAgentId }),
      handles: runChannelHandles
    });

    // Execute using the core generator
    const coreOptions = {
      userMessage,
      ...(cacheableUserMessage !== undefined && { cacheableUserMessage }),
      systemMessages,
      ...(messages && { messages }),
      maxSteps,
      subAgentNames,
      ...(abortSignal && { abortSignal }),
      ...(sessionManager && { sessionManager }),
      ...(prepSessionID && { sessionID: prepSessionID }),
      ...(prepAgentId && { agentId: prepAgentId }),
      ...(assistantMsgID && { messageID: assistantMsgID })
    };

    const result = await processAgentStream(
      executeAgentCore(agent, tools, coreOptions),
      sessionManager && prepSessionID && assistantMsgID && prepAgentId ? {
        collectToolCalls: true,
        sessionManager,
        sessionID: prepSessionID,
        messageID: assistantMsgID,
        agentId: prepAgentId,
        agentName: agent.name,
        doomLoopDetector,
        slackRunChannelHandles: runChannelHandles,
        quiet
      } : {
        collectToolCalls: true,
        doomLoopDetector,
        quiet
      }
    );

    logger.debug(`Agent finish reasons: ${result.finishReasons?.join(', ') ?? 'none'}`);
    logger.debug(`Agent produced text output: ${result.hasTextOutput}`);

    if (result.suspended) {
      // Release the store lock before the status flip so the session never
      // appears suspended/done while still holding it. cleanup releases again
      // (idempotent) in the finally.
      if (preparation) await preparation.releaseStoreLock();
      if (sessionManager && prepSessionID && prepAgentId) {
        if (assistantMsgID) {
          try {
            await persistAssistantRunState({
              sessionManager,
              sessionId: prepSessionID,
              agentId: prepAgentId,
              messageId: assistantMsgID,
              result
            });
          } catch (error) {
            logger.debug(`Failed to persist suspended session usage: ${(error as Error).message}`);
          }
        }
        await sessionManager.setSessionSuspended(prepSessionID, prepAgentId);
      }
      if (captureActive) {
        logger.stopCapture();
        captureActive = false;
      }

      const suspendedResult: RunAgentResult = {
        status: 'suspended',
        text: result.text,
        ...(result.usage && { usage: result.usage }),
        ...(result.usageKind && { usageKind: result.usageKind }),
        toolCallCount: result.toolCalls?.length || 0,
        ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces }),
        finishReason: 'suspended',
        finishReasons: [...(result.finishReasons ?? []), 'suspended'],
        hasTextOutput: result.hasTextOutput,
        ...(prepSessionID && { sessionId: prepSessionID }),
        ...(result.approvalUrl && { approvalUrl: result.approvalUrl }),
        ...(result.contextUsage && { contextUsage: result.contextUsage })
      };
      await suspendRunChannels({
        agent,
        result: suspendedResult,
        ...(prepSessionID && { sessionId: prepSessionID }),
        ...(agentFilePath !== undefined && { agentFilePath }),
        ...(startTime !== undefined && { startTime })
      }, runChannelHandles);

      return suspendedResult;
    }

    // Display execution summary
    const mainTokens = result.usage?.totalTokens || 0;
    const subTokens = result.subAgentTokens || 0;
    const totalTokens = mainTokens + subTokens;
    const durationMs = startTime ? Date.now() - startTime : 0;
    const toolCallCount = result.toolCalls?.length || 0;

    if (!quiet) {
      logger.separator();
      logger.summary({
        success: true,
        durationMs,
        ...(totalTokens > 0 && { tokensUsed: totalTokens }),
        ...(toolCallCount > 0 && { toolCallCount }),
      });
    }

    // Release the store lock before flipping status to completed so the next
    // run's lock acquire can't overlap this run's release. cleanup releases
    // again (idempotent) in the finally.
    if (preparation) await preparation.releaseStoreLock();

    // Mark the session completed even when a provider omits final usage data.
    // Short continuation replies can otherwise leave the approval page polling
    // a finished-looking run as still live.
    if (sessionManager && prepSessionID && assistantMsgID && prepAgentId) {
      try {
        await persistAssistantRunState({
          sessionManager,
          sessionId: prepSessionID,
          agentId: prepAgentId,
          messageId: assistantMsgID,
          result,
          completedAt: Date.now()
        });
        await sessionManager.setSessionCompleted(prepSessionID, prepAgentId);
      } catch (error) {
        logger.debug(`Failed to mark session completed: ${(error as Error).message}`);
      }
    }

    const runResult: RunAgentResult = {
      status: 'completed',
      text: result.text,
      ...(result.usage && { usage: result.usage }),
      ...(result.usageKind && { usageKind: result.usageKind }),
      toolCallCount: result.toolCalls?.length || 0,
      ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces }),
      ...(result.finishReason && { finishReason: result.finishReason }),
      ...(result.finishReasons && { finishReasons: result.finishReasons }),
      hasTextOutput: result.hasTextOutput,
      ...(prepSessionID && { sessionId: prepSessionID }),
      ...(result.contextUsage && { contextUsage: result.contextUsage })
    };

    const consoleOutput = captureActive ? logger.stopCapture() : '';
    captureActive = false;
    await sendRunChannelMessages({
      event: 'completion',
      agent,
      result: runResult,
      ...(prepSessionID && { sessionId: prepSessionID }),
      ...(agentFilePath !== undefined && { agentFilePath }),
      ...(startTime !== undefined && { startTime })
    }, undefined, runChannelHandles);
    await runPostLifecycle({
      agent,
      result: runResult,
      consoleOutput,
      ...(agentFilePath !== undefined && { agentFilePath }),
      ...(startTime !== undefined && { startTime }),
      ...(pluginManager !== undefined && { pluginManager })
    });

    // Return metrics for plugin system
    return runResult;
  } catch (error: unknown) {
    // Log error to session if available (for visibility in `agentuse sessions`)
    if (sessionManager && sessionID && agentId) {
      try {
        const errorCode = error instanceof AuthenticationError ? 'AUTH_ERROR' :
          (error instanceof Error && error.name === 'AbortError') ? 'TIMEOUT' :
          'EXECUTION_ERROR';
        const errorMessage = error instanceof Error ? error.message : String(error);
        await sessionManager.setSessionError(sessionID, agentId, {
          code: errorCode,
          message: errorMessage
        });
      } catch {
        // Ignore error logging failures
      }
    }

    // Check if it's an abort error from timeout
    if ((error instanceof Error && error.name === 'AbortError') || (abortSignal && abortSignal.aborted)) {
      // Timeout already handled by caller
      throw error;
    }
    if (captureActive) {
      logger.stopCapture();
      captureActive = false;
    }
    await sendRunChannelMessages({
      event: 'failure',
      agent,
      error,
      ...(sessionID && { sessionId: sessionID }),
      ...(agentFilePath !== undefined && { agentFilePath }),
      ...(startTime !== undefined && { startTime })
    }, undefined, runChannelHandles);
    logger.error('Agent execution failed', error as Error);
    throw error;
  } finally {
    // Clean up preparation resources (store locks, etc.)
    if (captureActive) {
      logger.stopCapture();
      captureActive = false;
    }

    if (preparation) {
      await preparation.cleanup();
    }

    // Clean up MCP clients (like opencode does)
    for (const connection of mcpClients) {
      try {
        await connection.client.close();
        if (connection.rawClient) {
          await connection.rawClient.close();
        }
        logger.debug(`Closed MCP client: ${connection.name}`);
      } catch (error) {
        // Ignore errors when closing MCP clients
      }
    }
  }
}

export async function runPostLifecycle(options: {
  pluginManager?: PluginManager | null | undefined;
  agent: ParsedAgent;
  agentFilePath?: string;
  result: RunAgentResult;
  startTime?: number;
  consoleOutput: string;
}) {
  const { pluginManager, agent, agentFilePath, result, startTime, consoleOutput } = options;
  const duration = startTime ? (Date.now() - startTime) / 1000 : 0;
  const event: AgentCompleteEvent = {
    agent: {
      name: agent.name,
      model: agent.config.model,
      ...(agent.description && { description: agent.description }),
      ...(agentFilePath && { filePath: agentFilePath })
    },
    result: {
      text: result.text || '',
      duration,
      ...(result.usage?.totalTokens !== undefined && { tokens: result.usage.totalTokens }),
      toolCalls: result.toolCallCount || 0,
      ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces }),
      ...(result.finishReason && { finishReason: result.finishReason }),
      ...(result.finishReasons && { finishReasons: result.finishReasons }),
      hasTextOutput: result.hasTextOutput
    },
    isSubAgent: false,
    consoleOutput
  };

  if (pluginManager) {
    try {
      await pluginManager.emitAgentComplete(event);
    } catch (pluginError) {
      logger.warn(`Plugin event error: ${(pluginError as Error).message}`);
    }
  }

  if (agent.config.learning?.capture && agentFilePath) {
    try {
      await extractLearnings({
        event,
        agentInstructions: agent.instructions,
        agentModel: agent.config.model,
        agentFilePath,
        config: agent.config.learning,
      });
    } catch (learningError) {
      logger.debug(`[Learning] Extraction failed: ${(learningError as Error).message}`);
    }
  }
}
