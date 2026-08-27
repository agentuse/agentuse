import type { ParsedAgent } from '../parser';
import { announceSessionFinished, announceSessionStarted } from './announce';
import type { MCPConnection } from '../mcp';
import type { SessionInfo, SessionManager, SessionTrigger } from '../session';
import type { AgentCompleteEvent, PluginManager } from '../plugin';
import { AuthenticationError } from '../models';
import { logger, runWithLogSink } from '../utils/logger';
import { toErrorMessage } from '../utils/error-message';
import { extractLearnings, LearningStore } from '../learning/index.js';
import { hasAutomaticLearningCapture } from '../learning/types.js';
import { findProjectRoot } from '../utils/project';
import { isMockMode } from './mock-tools';
import { recordCorrectionsMarker, recordLearningMarker, recordErrorMarkerForLatestMessage, createSessionLogSink, gatherApprovalContext, type SessionLogSink } from './session-helper';
import { usageToAssistantTokens, addAssistantTokens, type AssistantTokens } from '../session/usage';
import {
  sendRunChannelMessages,
  startRunChannels,
  suspendRunChannels,
  type RunChannelHandle
} from '../channels/run';
import { executeAgentCore } from './execution';
import { extractApiErrorDetail } from './api-error';
import { prepareAgentExecution } from './preparation';
import { processAgentStream } from './stream';
import { runVerifyLoop } from './verify-loop';
import { resolveVerifyPlacements } from '../verify/gate';
import type { PreparedAgentExecution, RunAgentResult } from './types';
import type { ModelMessage } from 'ai';
import { composeFinalOutput } from '../tools/report-outcome.js';

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
  /** Cumulative tokens from prior invocations (resume); folded into the write. */
  priorTokens?: AssistantTokens;
}): Promise<void> {
  const { sessionManager, sessionId, agentId, messageId, result, completedAt, priorTokens } = options;
  if (!sessionManager || !sessionId || !agentId || !messageId) return;

  await sessionManager.updateMessage(sessionId, agentId, messageId, {
    ...(completedAt !== undefined && { time: { completed: completedAt } }),
    ...(result.usage && {
      assistant: {
        tokens: addAssistantTokens(priorTokens, usageToAssistantTokens(result.usage)),
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
      priorTokens,
      agentId: prepAgentId,
      doomLoopDetector,
      effectWal,
      liveToolOutput
    } = preparation;

    // Set outer scope variables for error logging
    sessionID = prepSessionID;
    agentId = prepAgentId;

    // The session row now exists on disk as `running`. Poke the daemon so its
    // dashboards pick it up: runs it launched itself invalidate inline, but a
    // run started from a terminal has no other way to announce itself.
    void announceSessionStarted({
      agentName: agent.name,
      ...(prepSessionID && { sessionId: prepSessionID }),
    });

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
      ...(assistantMsgID && { messageID: assistantMsgID }),
      ...(effectWal && { effectWal }),
      // Lets the segment loop see whether an outcome was declared, so it can
      // spend its one nudge before the run ends without a headline.
      ...(preparation.runOutcome && { runOutcome: preparation.runOutcome })
    };

    const haveSessionScope = Boolean(sessionManager && prepSessionID && assistantMsgID && prepAgentId);

    // Before the stream, so the corrections a run started with read above its
    // first tool call rather than arriving after the work they shaped. Resume
    // reuses the persisted prompt without re-deriving injection, so
    // `learningsApplied` is 0 there and this stays silent — the marker belongs to
    // the run that actually applied them.
    if (haveSessionScope) {
      await recordCorrectionsMarker(
        sessionManager!,
        prepSessionID!,
        prepAgentId!,
        assistantMsgID!,
        preparation.learningsApplied,
        preparation.learningsStored,
        preparation.learningsCap,
      );
    }
    const streamOptions = haveSessionScope ? {
      collectToolCalls: true,
      sessionManager: sessionManager!,
      sessionID: prepSessionID!,
      messageID: assistantMsgID!,
      agentId: prepAgentId!,
      agentName: agent.name,
      ...(priorTokens && { priorTokens }),
      doomLoopDetector,
      slackRunChannelHandles: runChannelHandles,
      ...(liveToolOutput && { liveToolOutput }),
      quiet
    } : {
      collectToolCalls: true,
      doomLoopDetector,
      quiet
    };

    // Mirror this run's operational logs (info/warn/error/debug/system) into its
    // own session view for the duration of the stream. Best-effort and scoped via
    // AsyncLocalStorage so concurrent sub-agent runs route to their own sessions.
    const logSink: SessionLogSink | undefined = haveSessionScope
      ? createSessionLogSink(sessionManager!, prepSessionID!, prepAgentId!, assistantMsgID!)
      : undefined;
    const runStream = () => processAgentStream(executeAgentCore(agent, tools, coreOptions), streamOptions);
    let result: Awaited<ReturnType<typeof processAgentStream>>;
    try {
      result = await (logSink ? runWithLogSink(logSink.capture, runStream) : runStream());
    } finally {
      if (logSink) await logSink.flush();
    }

    logger.debug(`Agent finish reasons: ${result.finishReasons?.join(', ') ?? 'none'}`);
    logger.debug(`Agent produced text output: ${result.hasTextOutput}`);

    // Verify (experimental): judge the final output before it ships; on a
    // failed verdict inject the critique and redo in-session, up to maxRedos.
    // Requires the session substrate (redo continues on rehydrated history).
    // A redo that hits an approval gate falls through to the suspended branch
    // below; verification then resolves on the post-resume run.
    let verification: SessionInfo['verification'] | undefined;
    const verifyConfig = agent.config.verify;
    const verifyOutputActive = verifyConfig
      ? resolveVerifyPlacements(verifyConfig, Boolean(tools.await_human)).has('output')
      : false;
    if (
      verifyConfig &&
      verifyOutputActive &&
      !result.suspended &&
      !preparation.runOutcome?.incomplete &&
      sessionManager && prepSessionID && prepAgentId && assistantMsgID
    ) {
      // Judge context: the original task. On a resumed run userMessage is only
      // the latest continuation prompt, so prepend the agent's instructions.
      const verifyTask = existingSessionId
        ? `${agent.instructions}\n\nLatest instruction:\n${userMessage}`
        : userMessage;
      const executeRedo = (redoMessages: ModelMessage[], redoUserMessage: string) => {
        const redoStream = () => processAgentStream(
          executeAgentCore(agent, tools, { ...coreOptions, messages: redoMessages, userMessage: redoUserMessage }),
          streamOptions
        );
        return logSink ? runWithLogSink(logSink.capture, redoStream) : redoStream();
      };
      try {
        const verifyOutcome = await runVerifyLoop({
          agent,
          config: verifyConfig,
          task: verifyTask,
          initialResult: result,
          sessionManager,
          sessionID: prepSessionID,
          agentId: prepAgentId,
          messageID: assistantMsgID,
          executeRedo,
          ...(agentFilePath !== undefined && { agentFilePath }),
          ...(projectContext !== undefined && { projectContext }),
          ...(abortSignal && { abortSignal }),
          // Judge the real output: a run that delivered via report_complete
          // streamed no prose for the judge to read.
          ...(preparation.runOutcome && { runOutcome: preparation.runOutcome }),
          quiet
        });
        result = verifyOutcome.result;
        verification = verifyOutcome.verification;
      } finally {
        if (logSink) await logSink.flush();
      }
      if (verification) {
        try {
          await sessionManager.updateSession(prepSessionID, prepAgentId, { verification });
        } catch (error) {
          logger.debug(`Failed to persist verification outcome: ${(error as Error).message}`);
        }
      }
    } else if (verifyConfig && verifyOutputActive && !result.suspended) {
      logger.debug('[Verify] Skipped: session substrate unavailable or run declared incomplete');
    }

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
              result,
              ...(priorTokens && { priorTokens })
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

    // The agent may have declared the run incomplete (ran clean but did not
    // deliver — e.g. a dead login) via the report_incomplete tool. That verdict
    // flips the terminal status to error/INCOMPLETE so the run is skimmable as
    // a failure, while the run itself still finished without throwing.
    const incomplete = preparation.runOutcome?.incomplete;
    // The agent's own one-line verdict (report_complete). Suppressed when the
    // run is incomplete so no surface can pair a failure with a "here's what
    // landed" headline; classifyRunResult applies the same precedence.
    const complete = incomplete ? undefined : preparation.runOutcome?.complete;

    // Display execution summary
    const mainTokens = result.usage?.totalTokens || 0;
    const subTokens = result.subAgentTokens || 0;
    const totalTokens = mainTokens + subTokens;
    const durationMs = startTime ? Date.now() - startTime : 0;
    const toolCallCount = result.toolCalls?.length || 0;

    if (!quiet) {
      logger.separator();
      logger.summary({
        success: !incomplete,
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
          completedAt: Date.now(),
          ...(priorTokens && { priorTokens })
        });
        if (incomplete) {
          await sessionManager.setSessionError(prepSessionID, prepAgentId, {
            code: 'INCOMPLETE',
            message: incomplete.reason
          });
        } else {
          await sessionManager.setSessionCompleted(prepSessionID, prepAgentId);
        }
      } catch (error) {
        logger.debug(`Failed to mark session ${incomplete ? 'incomplete' : 'completed'}: ${(error as Error).message}`);
      }
    }

    const runResult: RunAgentResult = {
      status: incomplete ? 'failed' : 'completed',
      ...(incomplete && { incomplete }),
      ...(complete && { complete }),
      // report_complete IS the report, so its headline + details become the
      // run's output for every consumer. Streamed prose is the fallback for a
      // run that never called it.
      text: composeFinalOutput(complete, result.text),
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

    // Poke the serve daemon (if any) so subscribed devices get a Web Push.
    void announceSessionFinished({
      status: incomplete ? 'failed' : 'completed',
      agentName: agent.name,
      ...(prepSessionID && { sessionId: prepSessionID }),
    });

    const consoleOutput = captureActive ? logger.stopCapture() : '';
    captureActive = false;
    // A declared-incomplete run notifies as a failure — that is the whole point
    // of the declaration: the completion card would read as a green "done".
    await sendRunChannelMessages({
      ...(incomplete
        ? { event: 'failure' as const, error: incomplete.reason }
        : { event: 'completion' as const }),
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
      ...(projectContext !== undefined && {
        stateRoot: projectContext.stateRoot,
        projectRoot: projectContext.projectRoot,
      }),
      ...(startTime !== undefined && { startTime }),
      ...(pluginManager !== undefined && { pluginManager }),
      ...(sessionManager !== undefined && { sessionManager }),
      ...(prepSessionID !== undefined && { sessionId: prepSessionID }),
      ...(prepAgentId !== undefined && { agentId: prepAgentId }),
      ...(assistantMsgID !== undefined && { messageId: assistantMsgID }),
      learningsInjectedIds: preparation.learningsInjectedIds
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
        const errorMessage = toErrorMessage(error);
        const apiDetail = extractApiErrorDetail(error);
        await sessionManager.setSessionError(sessionID, agentId, {
          code: errorCode,
          message: errorMessage,
          ...apiDetail
        });
        // Also drop a timeline entry so the failure — and the provider response
        // body that says *why* — is visible in the session log itself, not just
        // the status pill. The persisted error detail is otherwise never shown.
        await recordErrorMarkerForLatestMessage(sessionManager, sessionID, agentId, {
          source: 'agent',
          code: errorCode,
          message: errorMessage,
          ...(apiDetail?.detail !== undefined && { detail: apiDetail.detail }),
          ...(apiDetail?.statusCode !== undefined && { statusCode: apiDetail.statusCode }),
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
    void announceSessionFinished({
      status: 'failed',
      agentName: agent.name,
      ...(sessionID && { sessionId: sessionID }),
    });
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
  /** The agent file's own project root, which decides where this agent's
   *  corrections file lives. Omitted only by callers with no project context,
   *  in which case it is derived from the agent file the same way
   *  `resolveProjectContext` would. */
  stateRoot?: string;
  /** Cwd-derived root used by helper-agent tools and sandboxes. */
  projectRoot?: string;
  result: RunAgentResult;
  startTime?: number;
  consoleOutput: string;
  /** Session refs used to persist a learning marker into the session log. */
  sessionManager?: SessionManager;
  sessionId?: string;
  agentId?: string;
  messageId?: string;
  /** Learning ids injected into this run, credited when a human approves it
   *  without leaving a comment. */
  learningsInjectedIds?: string[];
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

  const automaticCapture = hasAutomaticLearningCapture(agent.config.learning);

  if (automaticCapture && agentFilePath && isMockMode()) {
    // A mock run's tool results are fabricated by the mock model, so anything
    // learned from it is learned from fiction (and lands in the agent's REAL
    // learnings file, since only stores are isolated). Skip the pass entirely.
    // `gated` scope is skipped too: partial fabrication still poisons the well.
    logger.info('[Learning] Skipped: mock run (fabricated tool results are not real experience).');
  } else if (agent.config.learning && agentFilePath) {
    try {
      // Approval history is used only as evidence that injected guidance
      // survived review. An ordinary comment is feedback for this run, not a
      // durable learning; the explicit Learn/--remember path stores those.
      const approvalContext = (options.sessionManager && options.sessionId && options.agentId)
        ? await gatherApprovalContext(
          options.sessionManager,
          options.sessionId,
          options.agentId,
          options.messageId,
        )
        : { reviews: [], humanGates: 0 };
      const reviews = approvalContext.reviews;

      // A gate a human resolved without leaving a comment is the only positive
      // evidence the system gets that the rules in force were doing their job.
      // Credit them BEFORE capture runs, so the counter reflects this run even if
      // capture then merges or re-asserts one of them.
      //
      // Counted per GATE, not per run. The test used to be "this run drew no
      // comment anywhere", which on an agent whose reviewer steers it through a
      // revise loop is never satisfied: a run that took one correction and then
      // shipped something perfect scored nothing. Measured across a 22-agent
      // fleet, 0 of 750 rules had ever reached a single approved run, so the
      // counter that gates graduation was dead on arrival. Per gate, two clean
      // gates still count even when a third drew a correction.
      const stateRoot = options.stateRoot ?? findProjectRoot(agentFilePath);
      const cleanGates = approvalContext.humanGates - reviews.length;

      if (cleanGates > 0 && options.learningsInjectedIds?.length) {
        await LearningStore.fromAgentFile(agentFilePath, stateRoot, agent.name)
          .recordApprovedRun(options.learningsInjectedIds)
          .catch((err: unknown) => logger.debug(`[Learning] Could not credit approved run: ${(err as Error).message}`));
      }

      // Automatic observation is advanced and opt-in. The standard
      // `learning: true` path performs no post-run model call: it applies stored
      // guidance and learns only when the reviewer explicitly checks Learn.
      if (automaticCapture) {
        const outcome = await extractLearnings({
          event,
          agentInstructions: agent.instructions,
          agentModel: agent.config.model,
          agentFilePath,
          stateRoot,
          projectRoot: options.projectRoot,
          config: agent.config.learning,
          sessionId: options.sessionId,
        });
        // Surface the outcome (including a silent failure) in the session log.
        if (options.sessionManager && options.sessionId && options.agentId && options.messageId) {
          await recordLearningMarker(
            options.sessionManager,
            options.sessionId,
            options.agentId,
            options.messageId,
            outcome,
          );
        }
      }
    } catch (learningError) {
      logger.debug(`[Learning] Extraction failed: ${(learningError as Error).message}`);
    }
  }
}
