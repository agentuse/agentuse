import { sessionStopReason, classifyFailure } from '../runner/failure';
import { reconcileOrphanedSessions, reopenSuspendedGate } from '../runner';
import { findRootSessionId } from '../runner/subagent-cascade';
import { SessionManager } from '../session/index.js';
import { initStorage, CorruptStorageError } from '../storage/index.js';
import { buildSessionContextPayload } from '../cli/serve/context-stack.js';
import { version as packageVersion } from '../../package.json';
import { finalizeSessionRunChannels } from '../channels/run';
import { logger } from '../utils/logger';
import { invalidateListCaches, sessionBelongsToProject } from './cache.js';
import { mockField, sessionErrorFields, valueAsRecord } from './helpers.js';
import type { WorkerContext } from './context.js';
import type { ExecuteRequest, ExpiredApproval } from './types.js';

export async function getSessionStatusInfo(req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for status request' },
      };
    }

    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const found = await sessionManager.findSession(req.sessionId);
    if (!found || !sessionBelongsToProject(found.session, req.projectRoot)) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
      };
    }

    return {
      id: req.id,
      success: true,
      session: {
        sessionId: found.session.id,
        sessionStatus: found.session.status,
        ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
        ...(typeof found.session.time?.updated === 'number' && { updatedAt: found.session.time.updated }),
        model: found.session.model,
        ...mockField(found.session),
        ...sessionErrorFields(found.session),
        agent: {
          id: found.session.agent.id,
          name: found.session.agent.name,
          ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
          ...(found.session.agent.description && { description: found.session.agent.description })
        }
      }
    };
  } catch (err) {
    if (err instanceof CorruptStorageError) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_CORRUPTED', message: `This session's stored data is corrupted and cannot be displayed (${err.message}).` },
      };
    }
    return {
      id: req.id,
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    };
  }
}

export async function createPreparingSession(req: ExecuteRequest) {
  try {
    if (!req.sessionId || !req.agentId || !req.agentName || !req.model || !req.preparerOwner) {
      return {
        id: req.id,
        success: false,
        error: { code: 'PREPARING_SESSION_INVALID', message: 'Preparing session identity, model, and owner are required' },
      };
    }
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const sessionId = await sessionManager.createSession({
      id: req.sessionId,
      initialStatus: 'preparing',
      owner: req.preparerOwner,
      agent: {
        id: req.agentId,
        name: req.agentName,
        ...(req.agentDescription && { description: req.agentDescription }),
        isSubAgent: false,
      },
      model: req.model,
      version: packageVersion,
      config: {
        ...(req.sessionTimeout !== undefined && { timeout: req.sessionTimeout }),
        ...(req.maxSteps !== undefined && { maxSteps: req.maxSteps }),
      },
      project: { root: req.projectRoot, cwd: req.projectRoot },
      ...(req.trigger && { trigger: req.trigger }),
    });
    invalidateListCaches(req.projectRoot);
    return { id: req.id, success: true as const, sessionId };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'PREPARING_SESSION_CREATE_FAILED', message: (err as Error).message },
    };
  }
}

export async function failPreparingSession(req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing preparing session id' },
      };
    }
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const found = await sessionManager.findSession(req.sessionId);
    if (!found || found.session.status !== 'preparing') {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_NOT_PREPARING', message: `Session ${req.sessionId} is not preparing` },
      };
    }
    await sessionManager.setSessionError(req.sessionId, found.agentId, {
      code: req.errorCode || 'PREPARATION_FAILED',
      message: req.errorMessage || 'Session preparation failed',
    });
    invalidateListCaches(req.projectRoot);
    return { id: req.id, success: true as const, sessionId: req.sessionId };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'PREPARING_SESSION_FAIL_FAILED', message: (err as Error).message },
    };
  }
}

/**
 * The context stack for one session: what the model was actually sent.
 * Read-only, and built entirely from what the run already persisted (the
 * resolved system messages, the resolved instructions, the tool snapshot),
 * so it also answers for sessions that ran before this endpoint existed.
 */
export async function getSessionContext(req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for context request' },
      };
    }

    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const found = await sessionManager.findSession(req.sessionId);
    if (!found || !sessionBelongsToProject(found.session, req.projectRoot)) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
      };
    }

    const [message, tools, messages] = await Promise.all([
      sessionManager.getPrimaryMessage(found.session.id, found.agentId),
      sessionManager.readToolsSnapshot(found.session.id, found.agentId),
      sessionManager.getSessionMessages(found.session.id, found.agentId),
    ]);

    // Mid-run file reads live in the tool parts, which are per message.
    const parts = (await Promise.all(
      messages.map((m) => sessionManager.getMessageParts(found.session.id, found.agentId, m.id))
    )).flat();

    return {
      id: req.id,
      success: true,
      context: buildSessionContextPayload({ session: found.session, message, tools, parts }),
    };
  } catch (err) {
    if (err instanceof CorruptStorageError) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_CORRUPTED', message: `This session's stored data is corrupted and cannot be displayed (${err.message}).` },
      };
    }
    return {
      id: req.id,
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    };
  }
}

export async function sweepExpiredApprovals(req: ExecuteRequest) {
  try {
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const now = Date.now();
    const sweepCreatedAfter = now - 30 * 24 * 60 * 60 * 1000;
    const suspended = (await sessionManager.listSessionsCreatedAfter(sweepCreatedAfter, {
      includeSubagents: true
    })).filter(({ session }) => session.status === 'suspended');
    const expired: ExpiredApproval[] = [];

    for (const { session, agentId } of suspended) {
      const pendingPart = await sessionManager.getLatestApprovalPart(session.id, agentId);
      if (!pendingPart) continue;
      const state = pendingPart.state;
      if (state.status !== 'pending') continue;
      const resumePayload = state.resumePayload;
      const expiresAt = typeof resumePayload?.expiresAt === 'number' ? resumePayload.expiresAt : undefined;
      if (!expiresAt || expiresAt > now) continue;

      const start = state.suspendedAt ?? expiresAt;
      const timeoutMessage = `Approval not received before ${new Date(expiresAt).toISOString()}`;
      await sessionManager.updatePart(
        session.id,
        agentId,
        pendingPart.messageID,
        pendingPart.id,
        {
          state: {
            status: 'error',
            input: state.input,
            error: 'Approval timed out',
            ...(resumePayload && { metadata: { resumePayload } }),
            time: { start, end: now }
          }
        } as any
      ).catch(() => {});

      await sessionManager.setSessionError(session.id, agentId, {
        code: 'APPROVAL_TIMEOUT',
        message: timeoutMessage
      }).catch(() => {});

      const rootSessionId = typeof session.parentSessionID === 'string' && session.parentSessionID.length > 0
        ? await findRootSessionId(sessionManager, session.id)
        : session.id;
      if (rootSessionId !== session.id) {
        await sessionManager.stopSessionTree(rootSessionId, {
          code: 'APPROVAL_TIMEOUT',
          message: timeoutMessage
        }).catch(() => {});
      }

      const input = valueAsRecord(state.input);
      const channelMessage = valueAsRecord(resumePayload?.channelMessage);
      expired.push({
        sessionId: rootSessionId,
        agentId,
        agentName: session.agent.name || session.agent.id,
        ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
        expiresAt,
        ...(typeof state.suspendedAt === 'number' && { suspendedAt: state.suspendedAt }),
        ...(Object.keys(channelMessage).length > 0 && {
          channelMessage: {
            ...(typeof channelMessage.type === 'string' && { type: channelMessage.type }),
            ...(typeof channelMessage.channel === 'string' && { channel: channelMessage.channel }),
            ...(typeof channelMessage.ts === 'string' && { ts: channelMessage.ts }),
            ...(typeof channelMessage.actionTs === 'string' && { actionTs: channelMessage.actionTs }),
            ...(typeof channelMessage.url === 'string' && { url: channelMessage.url })
          }
        }),
        ...(session.channels && { channels: session.channels })
      });
    }

    if (expired.length > 0) invalidateListCaches(req.projectRoot);

    return {
      id: req.id,
      success: true as const,
      expired
    };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'SWEEP_ERROR', message: (err as Error).message }
    };
  }
}

/**
 * Mark the run cards of sessions that just ended without a live runner.
 * `failure` defaults to the error now recorded on each session.
 */
async function finalizeEndedSessionCards(
  sessionManager: SessionManager,
  sessionIds: string[],
  failure?: { message: string },
): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      const found = await sessionManager.findSession(sessionId);
      if (!found) continue;
      await finalizeSessionRunChannels(found.session, failure ?? found.session.error ?? { message: 'Run ended' });
    } catch (error) {
      logger.debug(`Run card finalize failed for ${sessionId}: ${(error as Error).message}`);
    }
  }
}

// Thin IPC shell over reconcileOrphanedSessions (see runner/resume.ts): recover
// sessions a dead worker left stuck 'running' with no live process. Invoked when
// this worker (re)spawns; cutoff is the ready time so only pre-existing orphans
// are flipped to WORKER_INTERRUPTED, making the reopen path reachable.
export async function reconcileOrphanSessions(req: ExecuteRequest) {
  try {
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const cutoff = typeof req.reconcileCutoff === 'number' ? req.reconcileCutoff : Date.now();
    const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff, ...(req.workerDeath && { workerDeath: req.workerDeath }) });
    if (reconciled.length > 0) invalidateListCaches(req.projectRoot);
    // The dead worker's runner never reached its catch, so its card still
    // reads "running" (or "waiting for approval" for a stranded manager).
    await finalizeEndedSessionCards(
      sessionManager,
      reconciled.filter((entry) => entry.reason === 'interrupted' || entry.reason === 'stranded').map((entry) => entry.sessionId),
    );
    return { id: req.id, success: true as const, reconciled };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'RECONCILE_ERROR', message: (err as Error).message }
    };
  }
}

export async function markSessionReviewed(req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for review request' },
      };
    }
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const result = await sessionManager.markSessionReviewed(req.sessionId);
    if (!result) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
      };
    }
    if (!result.alreadyReviewed) invalidateListCaches(req.projectRoot);
    return { id: req.id, success: true, ...result };
  } catch (err) {
    return {
      id: req.id,
      success: false,
      error: { code: 'MARK_REVIEWED_ERROR', message: (err as Error).message },
    };
  }
}

export async function stopSession(ctx: WorkerContext, req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for stop request' },
      };
    }

    const stopReason = sessionStopReason(req.reason, req.stopCause);
    const stopFailure = classifyFailure(stopReason);
    const controller = ctx.activeExecutionControllers.get(req.sessionId);
    if (controller) {
      ctx.activeStoppedSessions.add(req.sessionId);
      controller.abort(stopReason);
    }

    await initStorage(req.projectRoot);
    invalidateListCaches(req.projectRoot);
    const sessionManager = new SessionManager();
    // stopSessionTree stamps each session under its resume claim, so a
    // concurrent approval rollback anywhere in the tree either finishes first
    // or sees the stop and leaves it alone, never reopening a gate the user
    // just stopped.
    const stopped = await sessionManager.stopSessionTree(req.sessionId, {
      code: stopFailure.code,
      message: stopFailure.message,
      ...(req.dismissEnded === true && { dismissEnded: true })
    });
    if (stopped.length === 0) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${req.sessionId}` },
      };
    }
    // A running session's own runner marks its card when the abort lands; a
    // suspended one has no runner, so its card would stay "waiting for approval".
    await finalizeEndedSessionCards(
      sessionManager,
      stopped.filter((entry) => entry.stopped && entry.wasStatus === 'suspended').map((entry) => entry.sessionId),
      stopFailure,
    );
    return {
      id: req.id,
      success: true,
      stopped
    };
  } catch (err) {
    return {
      id: req.id,
      success: false,
      error: { code: 'STOP_SESSION_ERROR', message: (err as Error).message },
    };
  } finally {
    invalidateListCaches(req.projectRoot);
  }
}

export async function reopenGate(req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for reopen request' },
      };
    }
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const result = await reopenSuspendedGate({ sessionManager, sessionId: req.sessionId });
    if (!result.ok) {
      return { id: req.id, success: false, error: { code: result.code, message: result.message } };
    }
    invalidateListCaches(req.projectRoot);
    return { id: req.id, success: true, agentId: result.agentId };
  } catch (err) {
    return {
      id: req.id,
      success: false,
      error: { code: 'REOPEN_GATE_ERROR', message: (err as Error).message },
    };
  }
}
