import type { ParsedAgent } from '../parser';
import type { MCPConnection } from '../mcp';
import type { SessionManager } from '../session';
import { logger } from '../utils/logger';
import { executeAgentCore } from './execution';
import { prepareAgentExecution } from './preparation';
import { processAgentStream } from './stream';
import type { PreparedAgentExecution, RunAgentResult } from './types';

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
  projectContext?: { projectRoot: string; cwd: string },
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
  preparedExecution?: PreparedAgentExecution
): Promise<RunAgentResult> {
  try {
    // Log initialization time if verbose
    if (verbose && startTime) {
      const initTime = Date.now() - startTime;
      logger.info(`Initialization completed in ${initTime}ms`);
    }

    // Use shared preparation logic (allow caller to precompute to avoid duplicate work)
    // If preparedExecution is provided, use it directly (CLI path).
    // If not provided, compute it fresh (API/test path).
    const preparation = preparedExecution ?? await prepareAgentExecution({
      agent,
      mcpClients,
      agentFilePath,
      cliMaxSteps,
      sessionManager,
      projectContext,
      userPrompt,
      abortSignal,
      verbose
    });

    const {
      tools,
      systemMessages,
      userMessage,
      maxSteps,
      subAgentNames,
      sessionID,
      assistantMsgID,
      doomLoopDetector
    } = preparation;

    // Execute using the core generator
    const coreOptions = {
      userMessage,
      systemMessages,
      maxSteps,
      subAgentNames,
      ...(abortSignal && { abortSignal })
    };

    const result = await processAgentStream(
      executeAgentCore(agent, tools, coreOptions),
      sessionManager && sessionID && assistantMsgID ? {
        collectToolCalls: true,
        sessionManager,
        sessionID,
        messageID: assistantMsgID,
        agentName: agent.name,
        doomLoopDetector
      } : {
        collectToolCalls: true,
        doomLoopDetector
      }
    );

    logger.debug(`Agent finish reasons: ${result.finishReasons?.join(', ') ?? 'none'}`);
    logger.debug(`Agent produced text output: ${result.hasTextOutput}`);

    // Display execution summary
    const mainTokens = result.usage?.totalTokens || 0;
    const subTokens = result.subAgentTokens || 0;
    const totalTokens = mainTokens + subTokens;
    const durationMs = startTime ? Date.now() - startTime : 0;
    const toolCallCount = result.toolCalls?.length || 0;

    logger.separator();
    logger.summary({
      success: true,
      durationMs,
      ...(totalTokens > 0 && { tokensUsed: totalTokens }),
      ...(toolCallCount > 0 && { toolCallCount }),
    });

    // Update session message with final token usage
    if (sessionManager && sessionID && assistantMsgID && result.usage) {
      try {
        await sessionManager.updateMessage(sessionID, agent.name, assistantMsgID, {
          time: { completed: Date.now() },
          assistant: {
            tokens: {
              input: result.usage.inputTokens || 0,
              output: result.usage.outputTokens || 0
            }
          }
        });
      } catch (error) {
        logger.debug(`Failed to update message with token usage: ${(error as Error).message}`);
      }
    }

    // Return metrics for plugin system
    return {
      text: result.text,
      ...(result.usage && { usage: result.usage }),
      toolCallCount: result.toolCalls?.length || 0,
      ...(result.toolCallTraces && { toolCallTraces: result.toolCallTraces }),
      ...(result.finishReason && { finishReason: result.finishReason }),
      ...(result.finishReasons && { finishReasons: result.finishReasons }),
      hasTextOutput: result.hasTextOutput
    };
  } catch (error: unknown) {
    // Check if it's an abort error from timeout
    if ((error instanceof Error && error.name === 'AbortError') || (abortSignal && abortSignal.aborted)) {
      // Timeout already handled by caller
      throw error;
    }
    logger.error('Agent execution failed', error as Error);
    throw error;
  } finally {
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
