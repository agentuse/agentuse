import { ExecutionBudget } from '../runner/execution-budget';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import * as dotenv from 'dotenv';
import { parseAgent, parseAgentContent } from '../parser';
import { connectMCP } from '../mcp';
import { closeMCPConnections } from '../mcp-cleanup';
import { runAgent, prepareAgentExecution, applyResumeToolResult, restoreResumeToolResult, workerRunResponse } from '../runner';
import { PluginManager } from '../plugin';
import { applyRunModelOverride, resolveModelString, type RunModelOverride } from '../utils/model-alias';
import { logger } from '../utils/logger';
import { resolveProjectContext } from '../utils/project';
import { classifyFailure, RunAbortError } from '../runner/failure';
import { validateAgentEnvVars, formatEnvValidationError } from '../utils/env-validation';
import { SessionManager } from '../session/index.js';
import { initStorage } from '../storage/index.js';
import { invalidateListCaches } from './cache.js';
import { finishCascadeFromStorage, resumeApprovalCascade, retryFailedCascade } from './cascade.js';
import { buildContinuationPrompt } from './helpers.js';
import { acquireOwnershipLock, OwnershipLockHeldError, type OwnershipLockHandle } from '../utils/ownership-lock';
import { SCHEDULED_RUN_ACTIVE, scheduledRunLockPath } from '../utils/scheduler-lock';
import { normalizeScheduleAgentPath } from '../scheduler/state';
import type { WorkerContext } from './context.js';
import type { ExecuteRequest } from './types.js';

/**
 * Scheduled runs hold a per-agent claim in the project for as long as this
 * worker executes them. The daemon's in-memory overlap guard does not survive
 * a handoff: the old daemon releases its worker (which keeps running) and the
 * replacement arms the same schedule with no record of that run. The claim is
 * held by the process doing the work, so a live run in a released worker
 * still blocks the next firing; a dead holder is reclaimed immediately.
 */
export async function executeAgent(ctx: WorkerContext, req: ExecuteRequest) {
  if (req.type !== 'execute' || req.trigger !== 'scheduled' || !req.agentPath) {
    return executeAgentRequest(ctx, req);
  }
  const lockPath = scheduledRunLockPath(req.projectRoot, normalizeScheduleAgentPath(req.agentPath));
  let claim: OwnershipLockHandle;
  try {
    claim = await acquireOwnershipLock(lockPath, { maxWaitMs: 0, label: 'scheduled-run' });
  } catch (error) {
    if (!(error instanceof OwnershipLockHeldError)) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SCHEDULED_RUN_LOCK_FAILED', message: `Could not claim scheduled run: ${(error as Error).message}` },
      };
    }
    return {
      id: req.id,
      success: false,
      error: {
        code: SCHEDULED_RUN_ACTIVE,
        message: `previous run is still active${error.ownerPid ? ` in PID ${error.ownerPid}` : ''}`,
      },
    };
  }
  try {
    return await executeAgentRequest(ctx, req);
  } finally {
    await claim.release();
  }
}

async function executeAgentRequest(ctx: WorkerContext, req: ExecuteRequest) {
  const startTime = Date.now();
  let mcp: Awaited<ReturnType<typeof connectMCP>> = [];
  let sessionManager: InstanceType<typeof SessionManager> | undefined;
  let resumeRollback: Awaited<ReturnType<typeof applyResumeToolResult>>['rollback'] | undefined;
  let prebuiltResumeMessages: Awaited<ReturnType<typeof applyResumeToolResult>>['resumedMessages'] | undefined;
  let continuationSession: { sessionId: string; agentId: string } | undefined;
  let activeSessionId: string | undefined;
  let executionBudget: ExecutionBudget | undefined;

  const abortController = new AbortController();
  // Register the abort handle under the known session id up front, before the
  // run's async setup (env load, storage init, MCP connect, prepareAgentExecution).
  // Otherwise a stop request arriving during that window finds no controller,
  // is silently dropped, and the run finishes and overwrites the stopped
  // status with success. Fresh runs have no pre-known sessionId and cannot be
  // raced before their id exists, so they only register once it is known.
  // Detached runs DO pre-assign their id (req.newSessionId), so register
  // under it too, otherwise an early stop request would be silently dropped.
  const knownSessionId = req.sessionId ?? req.newSessionId;
  if (knownSessionId) {
    ctx.activeExecutionControllers.set(knownSessionId, abortController);
  }

  const restoreResumeAndReturn = async <T>(response: T): Promise<T> => {
    if (sessionManager && resumeRollback) {
      await restoreResumeToolResult({ sessionManager, rollback: resumeRollback }).catch((restoreErr) => {
        logger.warn(`Failed to restore pending approval after resume error: ${(restoreErr as Error).message}`);
      });
      resumeRollback = undefined;
    }
    return response;
  };

  // After this run's signal aborted: when a user Stop caused it, classify the
  // failure as that stop and re-stamp the stopped tree so the API response and
  // storage agree. Shared by the run-time and preflight failure paths.
  // Undefined when the abort was not a user Stop.
  const userStopFailure = async () => {
    // The stop marker is keyed by the session id stopSession saw, which
    // for resume/continue is req.sessionId; fall back to it when the abort
    // landed before activeSessionId was resolved so an early user-stop is
    // not misreported as a timeout.
    const stoppedSessionId = (activeSessionId && ctx.activeStoppedSessions.has(activeSessionId))
      ? activeSessionId
      : (req.sessionId && ctx.activeStoppedSessions.has(req.sessionId))
        ? req.sessionId
        : undefined;
    if (stoppedSessionId === undefined) return undefined;
    const stoppedFailure = abortController.signal.reason instanceof RunAbortError
      ? classifyFailure(abortController.signal.reason)
      : { code: 'USER_STOPPED', cause: 'user_stopped', message: 'Session stopped by user' };
    if (sessionManager) {
      await sessionManager.stopSessionTree(stoppedSessionId, {
        code: stoppedFailure.code,
        message: stoppedFailure.message
      }).catch(() => {});
    }
    return stoppedFailure;
  };

  ctx.activeExecuteRequests++;
  try {
    invalidateListCaches(req.projectRoot);
    let agentPath = req.agentPath ? resolve(req.projectRoot, req.agentPath) : '';
    const inMemoryAgent = req.type === 'execute' && typeof req.agentContent === 'string';
    if (req.type === 'execute' && !inMemoryAgent && (!req.agentPath || !existsSync(agentPath))) {
      return {
        id: req.id,
        success: false,
        error: { code: 'AGENT_NOT_FOUND', message: `Agent file not found: ${req.agentPath}` },
      };
    }

    // Load environment from project root
    const envFile = resolve(req.projectRoot, '.env');
    const envLocalFile = resolve(req.projectRoot, '.env.local');
    if (existsSync(envLocalFile)) {
      dotenv.config({ path: envLocalFile });
    } else if (existsSync(envFile)) {
      dotenv.config({ path: envFile });
    }

    try {
      await initStorage(req.projectRoot);
    } catch {
      // Ignore storage init errors
    }

    sessionManager = new SessionManager();
    let existingSessionId: string | undefined = req.sessionId;
    let runPrompt = req.prompt;
    let runCwd = req.projectRoot;
    if (req.type === 'finish-cascade') {
      // Recovery for a chain stranded between a child ending and its parent's
      // bookmark completing (issue #199): finish the walk-up from storage.
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for finish-cascade request' },
        };
      }
      return await finishCascadeFromStorage({
        ctx,
        sessionManager,
        rootSessionId: req.sessionId,
        projectRoot: req.projectRoot,
        abortController,
        startTime,
        reqId: req.id,
        ...(req.debug !== undefined && { debug: req.debug }),
        ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
      });
    }
    if (req.type === 'retry-cascade') {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for retry-cascade request' },
        };
      }
      return await retryFailedCascade({
        ctx,
        sessionManager,
        rootSessionId: req.sessionId,
        projectRoot: req.projectRoot,
        abortController,
        startTime,
        reqId: req.id,
        ...(req.debug !== undefined && { debug: req.debug }),
        ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
      });
    }
    if (req.type === 'resume') {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for resume request' },
        };
      }

      // Cascade: if this session is a manager root parked on a delegated child's
      // gate (subagent_wait), resolve + resume the whole chain rather than a single
      // session. Falls through to the normal resume when there is no cascade.
      const cascade = await resumeApprovalCascade({
        ctx,
        sessionManager,
        rootSessionId: req.sessionId,
        toolResult: req.toolResult,
        ...(req.resumeToken && { resumeToken: req.resumeToken }),
        projectRoot: req.projectRoot,
        abortController,
        startTime,
        reqId: req.id,
        ...(req.debug !== undefined && { debug: req.debug }),
        ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
      });
      if (cascade.handled) {
        return cascade.response;
      }

      const resumed = await applyResumeToolResult({
        sessionManager,
        sessionId: req.sessionId,
        toolResult: req.toolResult,
        ...(req.resumeToken && { resumeToken: req.resumeToken }),
        buildResumedMessages: true,
      });
      resumeRollback = resumed.rollback;
      prebuiltResumeMessages = resumed.resumedMessages;
      if (!resumed.agentFilePath) {
        return restoreResumeAndReturn({
          id: req.id,
          success: false,
          error: { code: 'AGENT_NOT_FOUND', message: `Session ${req.sessionId} does not record an agent file path` },
        });
      }
      agentPath = resumed.agentFilePath;
      existingSessionId = req.sessionId;
    } else if (req.type === 'continue-session') {
      if (!req.sessionId) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for continue request' },
        };
      }

      const found = await sessionManager.findSession(req.sessionId);
      if (!found) {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
        };
      }
      if (found.session.status === 'preparing' || found.session.status === 'running') {
        return {
          id: req.id,
          success: false,
          error: {
            code: found.session.status === 'preparing' ? 'SESSION_PREPARING' : 'SESSION_RUNNING',
            message: `Session ${req.sessionId} is already ${found.session.status}`,
          },
        };
      }
      if (found.session.status === 'suspended') {
        return {
          id: req.id,
          success: false,
          error: { code: 'SESSION_SUSPENDED', message: `Session ${req.sessionId} is suspended; submit an approval decision instead` },
        };
      }
      if (!found.session.agent.filePath) {
        return {
          id: req.id,
          success: false,
          error: { code: 'AGENT_NOT_FOUND', message: `Session ${req.sessionId} does not record an agent file path` },
        };
      }

      agentPath = found.session.agent.filePath;
      existingSessionId = req.sessionId;
      runCwd = found.session.project.cwd || req.projectRoot;
      continuationSession = { sessionId: req.sessionId, agentId: found.agentId };
      runPrompt = await buildContinuationPrompt(
        sessionManager,
        req.sessionId,
        found.agentId,
        found.session,
        req.prompt
      );
    }

    const agent = inMemoryAgent
      ? parseAgentContent(req.agentContent!, req.agentName ?? 'in-memory-agent')
      : await parseAgent(agentPath);

    const envValidation = validateAgentEnvVars(agent.config);
    if (!envValidation.valid) {
      return restoreResumeAndReturn({
        id: req.id,
        success: false,
        error: { code: 'ENV_MISSING', message: formatEnvValidationError(envValidation) },
      });
    }

    let runModelOverride: RunModelOverride | undefined;
    if (req.model) {
      const resolved = resolveModelString(req.model);
      runModelOverride = { requested: req.model, resolved };
      applyRunModelOverride(agent.config, runModelOverride);
    }

    const mcpBasePath = inMemoryAgent ? undefined : dirname(agentPath);
    mcp = await connectMCP(agent.config.mcpServers, req.debug ?? false, mcpBasePath, runCwd);

    const timeoutSeconds = req.timeout ?? agent.config.timeout ?? 300;
    executionBudget = new ExecutionBudget(timeoutSeconds * 1000, { controller: abortController });
    const projectContext = { projectRoot: req.projectRoot, stateRoot: req.projectRoot, cwd: runCwd };
    let pluginManager: PluginManager | null = null;
    try {
      const pluginContext = resolveProjectContext(req.projectRoot, { projectRoot: req.projectRoot });
      pluginManager = new PluginManager();
      await pluginManager.loadPlugins(pluginContext.pluginDirs, pluginContext.projectRoot);
    } catch {
      pluginManager = null;
    }

    const preparedExecution = await prepareAgentExecution({
      agent,
      mcpClients: mcp,
      ...(runModelOverride && { subagentModelOverride: runModelOverride }),
      ...(!inMemoryAgent && { agentFilePath: agentPath }),
      cliMaxSteps: req.maxSteps,
      sessionManager,
      projectContext,
      userPrompt: runPrompt,
      abortSignal: abortController.signal,
      pluginManager,
      verbose: req.debug ?? false,
      existingSessionId,
      ...(prebuiltResumeMessages && { prebuiltMessages: prebuiltResumeMessages }),
      // A continuation adds a new user turn to an ended run, so it can repair
      // an older missing snapshot from today's agent definition. Approval
      // resumes deliberately keep the strict historical-snapshot requirement.
      ...(req.type === 'continue-session' && { rebuildMissingToolsSnapshot: true }),
      ...(req.trigger && { trigger: req.trigger }),
      // Detached runs only: pre-assign the fresh session's id. Ignored on the
      // resume/continue paths, which carry existingSessionId instead.
      ...(req.type === 'execute' && req.newSessionId && { newSessionId: req.newSessionId }),
      ...(req.type === 'execute' && req.preparedSession && { preparedSession: true })
    });

    activeSessionId = preparedExecution.sessionID ?? existingSessionId;

    // runAgent's finally releases the prepared resources once it is called.
    // Until then they are still this worker's: a failure here must release
    // them too. The continued session's status is left as it was.
    if (continuationSession) {
      try {
        await sessionManager.setSessionRunning(continuationSession.sessionId, continuationSession.agentId);
      } catch (err) {
        await preparedExecution.cleanup().catch((cleanupErr) => {
          logger.debug(`Failed to release prepared resources after continuation error: ${(cleanupErr as Error).message}`);
        });
        throw err;
      }
    }

    if (activeSessionId) {
      ctx.activeExecutionControllers.set(activeSessionId, abortController);
    }

    try {
      const result = await runAgent(
        agent,
        mcp,
        req.debug ?? false,
        abortController.signal,
        startTime,
        false,
        inMemoryAgent ? undefined : agentPath,
        req.maxSteps,
        sessionManager,
        // Serve registers projects explicitly; agents live in their registered
        // project so stateRoot equals projectRoot here.
        projectContext,
        runPrompt,
        preparedExecution,
        true,
        pluginManager,
        true,
        existingSessionId,
        req.runChannelHandles,
        req.type === 'continue-session' ? req.prompt : undefined,
        req.trigger
      );

      await executionBudget.finish();
      resumeRollback = undefined;
      const duration = Date.now() - startTime;

      // Opt-in automatic observation runs once inside runAgent's post-run
      // lifecycle. Deliberate reviewer learning is saved separately when
      // Learn is selected, so nothing extra is needed here.

      return workerRunResponse(req.id, result, duration);
    } catch (err) {
      await executionBudget.finish();
      // Once the agent run has started, keep the reviewer's decision durable.
      // Rolling the await_human part back here makes an accepted approval look
      // pending again after a downstream model/tool error, which is both
      // misleading and can invite duplicate external actions. Preflight
      // failures before runAgent still use restoreResumeAndReturn above.
      resumeRollback = undefined;
      if (abortController.signal.aborted) {
        const stoppedFailure = await userStopFailure();
        if (stoppedFailure) return { id: req.id, success: false, error: stoppedFailure };
      }
      return {
        id: req.id,
        success: false,
        error: classifyFailure(err, abortController.signal),
      };
    }
  } catch (err) {
    if (sessionManager && resumeRollback) {
      await restoreResumeToolResult({ sessionManager, rollback: resumeRollback }).catch((restoreErr) => {
        logger.warn(`Failed to restore pending approval after resume error: ${(restoreErr as Error).message}`);
      });
    }
    if (abortController.signal.aborted) {
      const stoppedFailure = await userStopFailure();
      if (stoppedFailure) return { id: req.id, success: false, error: stoppedFailure };
    }
    const failure = classifyFailure(err, abortController.signal);
    return {
      id: req.id,
      success: false,
      error: { ...failure, ...(failure.cause === 'unknown' && { code: 'INTERNAL_ERROR' }) },
    };
  } finally {
    await executionBudget?.finish();
    // Clear both the up-front (req.sessionId) and resolved (activeSessionId)
    // registrations; they usually coincide for resume/continue but may differ
    // defensively, and a stale entry would wrongly abort a later run reusing
    // the same id.
    for (const id of new Set([activeSessionId, req.sessionId, req.newSessionId])) {
      if (!id) continue;
      ctx.activeExecutionControllers.delete(id);
      ctx.activeStoppedSessions.delete(id);
    }
    await closeMCPConnections(mcp);
    ctx.activeExecuteRequests--;
    invalidateListCaches(req.projectRoot);
  }
}
