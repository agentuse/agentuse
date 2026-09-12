import { parseAgent } from '../parser';
import { contextUsageFromSnapshot } from '../session/usage';
import { summarizeSessionTiming } from '../session/timing';
import { descendToLeafGate, findPendingSubagentWaitChildId, findRootSessionId, findStaleCascadeChild, describeStaleCascade, isRecoverableCascadeFailure, CASCADE_ORPHANED_CODE, CASCADE_RECOVERABLE_CODE } from '../runner/subagent-cascade';
import { repairEscapedText } from '../utils/display-text';
import { safeHttpUrl } from '../utils/url';
import { logger } from '../utils/logger';
import { completeApprovalValueDisplay } from '../utils/approval-value';
import { SessionManager } from '../session/index.js';
import { initStorage, CorruptStorageError } from '../storage/index.js';
import type { Part, SessionInfo } from '../session';
import { aggregateSessionTokenUsage, dismissedAtField, mockField, sessionErrorFields, valueAsRecord } from './helpers.js';
import { buildApprovalLogs, buildAwaitHumanDetails, approvalWasRolledBackAfterResume, judgeSummaryForGate, judgedAttempt, logsWithRecoveredApprovalDecision, logsWithSessionError, normalizeApprovalChanges, normalizeApprovalOptions, normalizeApprovalReference } from './approval-logs.js';
import { approvalInfoCacheKey, sessionBelongsToProject, withApprovalInfoCache } from './cache.js';
import { sessionHierarchySummaries } from './cascade.js';
import type { ExecuteRequest } from './types.js';

export async function getApprovalInfo(req: ExecuteRequest) {
  return withApprovalInfoCache(
    approvalInfoCacheKey(req),
    req.id,
    async () => getApprovalInfoUncached(req),
    req.sessionId ? () => approvalInfoChangeSignature(req.projectRoot, req.sessionId!) : undefined
  );
}

/**
 * Change probe backing the non-terminal approval-info cache: the max
 * directory mtime across the session's subtree (see
 * SessionManager.getSessionChangeSignature). Returns null when the session
 * can't be resolved so the caller never caches against a blind signature.
 */
export async function approvalInfoChangeSignature(projectRoot: string, sessionId: string): Promise<string | null> {
  try {
    await initStorage(projectRoot);
    const sessionManager = new SessionManager();
    const found = await sessionManager.findSession(sessionId);
    if (!found) return null;
    return await sessionManager.getSessionChangeSignature(found.path);
  } catch (error) {
    logger.debug(`Approval-info change probe failed for ${sessionId}: ${(error as Error).message}`);
    return null;
  }
}

export async function learningInfoForSession(session: SessionInfo): Promise<{ capture: boolean; apply: boolean } | undefined> {
  const agentPath = session.agent.filePath;
  if (!agentPath) return undefined;
  try {
    const agent = await parseAgent(agentPath);
    return agent.config.learning
      ? { capture: Boolean(agent.config.learning.capture), apply: agent.config.learning.apply }
      : undefined;
  } catch (error) {
    logger.debug(`Failed to read learning config for ${agentPath}: ${(error as Error).message}`);
    return undefined;
  }
}

export async function getApprovalInfoUncached(req: ExecuteRequest) {
  try {
    if (!req.sessionId) {
      return {
        id: req.id,
        success: false,
        error: { code: 'SESSION_REQUIRED', message: 'Missing sessionId for approval request' },
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

    const messages = await sessionManager.getSessionMessages(req.sessionId, found.agentId);
    // Usage/metadata only: skip media rehydration (no need to read cache files).
    const contextOverride = contextUsageFromSnapshot(await sessionManager.readContextSnapshot(req.sessionId, found.agentId, { rehydrateMedia: false }));
    const tokenUsage = aggregateSessionTokenUsage(messages, contextOverride);
    // The per-run instruction this session was started with (CLI args / the
    // "run with custom instruction" composer), kept separate from the agent's
    // own body. It lives in the first message's metadata, not in the parts the
    // log is built from, so surface it here for the session page to display.
    const firstUserPrompt = messages[0]?.user?.prompt?.user;
    const additionalInstruction = typeof firstUserPrompt === 'string' && firstUserPrompt.trim()
      ? firstUserPrompt
      : undefined;
    const parts = (await Promise.all(
      messages.map((message) => sessionManager.getMessageParts(req.sessionId!, found.agentId, message.id))
    )).flat();
    let logs = logsWithSessionError(buildApprovalLogs(parts), found.session);
    const { childSessions, importantDescendants, importantDescendantEvents, evidence: descendantEvidence } = await sessionHierarchySummaries(
      sessionManager,
      found.session,
      req.sessionId,
      found.path,
      parts as Part[]
    );
    // Name the judge child behind each gate's verdict so the card can link to
    // it. serve turns the id into a tokenized href.
    logs = logs.map((entry) => {
      const judge = entry.details?.judge;
      if (!judge || judge.sessionId) return entry;
      const match = importantDescendants.find((descendant) =>
        descendant.parentSessionId === req.sessionId
        && descendant.kinds.includes('judge')
        && judgedAttempt(descendant, judge.attempt)
      );
      return match
        ? { ...entry, details: { ...entry.details, judge: { ...judge, sessionId: match.sessionId } } }
        : entry;
    });
    const timing = summarizeSessionTiming(found.session, [
      { session: found.session, parts: parts as Part[] },
      ...descendantEvidence,
    ]);
    const approvalParts = parts.filter((part: any) => {
      if (part?.type !== 'tool') return false;
      const kind = part?.state?.status === 'pending'
        ? part?.state?.resumePayload?.kind
        : part?.state?.metadata?.resumePayload?.kind;
      return part?.tool === 'await_human' || kind === 'await_human' || kind === 'tool_approval';
    }) as any;
    const pendingApprovalPart = [...approvalParts].reverse().find((part: any) =>
      part?.state?.status === 'pending'
    );
    const latestApprovalPart = [...approvalParts].reverse()[0];
    let effectiveApprovalPart = pendingApprovalPart ?? latestApprovalPart;

    // Cascade: this session may have no human gate of its own but be parked on a
    // delegated child (subagent_wait). Descend to the leaf holding the real gate
    // and surface it here, addressed at this (root/intermediate) session.
    let cascadeLeaf: { session: SessionInfo; agentId: string; parts: any[]; approvalPart: any } | null = null;
    if (!pendingApprovalPart) {
      const childSessionId = findPendingSubagentWaitChildId(parts);
      if (childSessionId) {
        cascadeLeaf = await descendToLeafGate(sessionManager, childSessionId);
        if (cascadeLeaf) effectiveApprovalPart = cascadeLeaf.approvalPart;
      }
    }

    // An ended session (error/completed) whose latest gate was resolved via a
    // resume can be manually rolled back to its suspended approval so a reviewer
    // can retry a resume that failed downstream. The gate keeps its original
    // resumePayload, which is what reopenSuspendedGate rebuilds the pending
    // state from. Surfaced as `reopenable` so the UI can offer a Retry action.
    const reopenable = (found.session.status === 'error' || found.session.status === 'completed')
      && approvalParts.some((part: any) =>
        (part?.state?.status === 'completed' || part?.state?.status === 'error') &&
        part?.state?.metadata?.resumePayload?.kind === 'await_human'
      );

    // A delegated child viewed directly is view-only: approval happens at the root.
    const isDelegatedChild = typeof found.session.parentSessionID === 'string' && found.session.parentSessionID.length > 0;
    const parentSessionId = isDelegatedChild ? found.session.parentSessionID : undefined;
    const viewOnlyRootSessionId = isDelegatedChild
      ? await findRootSessionId(sessionManager, req.sessionId)
      : undefined;
    // Resolve the immediate parent's agent name so the child page can render a
    // readable breadcrumb back to it.
    let parentAgentName: string | undefined;
    if (parentSessionId) {
      const parentFound = await sessionManager.findSession(parentSessionId);
      parentAgentName = parentFound?.session.agent.name;
    }
    const viewOnlyFields = isDelegatedChild
      ? {
          viewOnly: true as const,
          ...(parentSessionId && { parentSessionId }),
          ...(parentAgentName && { parentAgentName }),
          ...(viewOnlyRootSessionId && { rootSessionId: viewOnlyRootSessionId }),
        }
      : {};
    const originAgentFields = cascadeLeaf
      ? { originAgent: {
          id: cascadeLeaf.session.agent.id,
          name: cascadeLeaf.session.agent.name,
          ...(cascadeLeaf.session.agent.filePath && { filePath: cascadeLeaf.session.agent.filePath }),
          ...(cascadeLeaf.session.agent.description && { description: cascadeLeaf.session.agent.description }),
        } }
      : {};
    const learning = await learningInfoForSession(cascadeLeaf?.session ?? found.session);

    // Same stranded-cascade case the approvals list handles: this session is
    // durably suspended on a delegated child that has already ended, so it has no
    // gate of its own and none below. Without this the page renders a bare
    // "suspended" run with no hint that nothing will ever move it again.
    let orphanedCascadeFields: { errorCode: string; errorMessage: string; cascadeRetryable?: true } | undefined;
    if (!effectiveApprovalPart) {
      const childSessionId = findPendingSubagentWaitChildId(parts);
      const stale = childSessionId ? await findStaleCascadeChild(sessionManager, childSessionId) : null;
      if (stale) {
        if (isRecoverableCascadeFailure(stale)) {
          orphanedCascadeFields = {
            errorCode: CASCADE_RECOVERABLE_CODE,
            errorMessage: describeStaleCascade(stale),
            cascadeRetryable: true,
          };
        } else if (found.session.status === 'suspended' && !found.session.error) {
          orphanedCascadeFields = {
            errorCode: CASCADE_ORPHANED_CODE,
            errorMessage: describeStaleCascade(stale),
          };
        }
      }
    }

    if (!effectiveApprovalPart) {
      return {
        id: req.id,
        success: true,
        approval: {
          sessionId: req.sessionId,
          sessionStatus: found.session.status,
          ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
          model: found.session.model,
          ...mockField(found.session),
          ...sessionErrorFields(found.session),
          ...(orphanedCascadeFields ?? {}),
          ...dismissedAtField(found.session),
          ...(reopenable && { reopenable }),
          agent: {
            id: found.session.agent.id,
            name: found.session.agent.name,
            ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
            ...(found.session.agent.description && { description: found.session.agent.description })
          },
          ...(learning && { learning }),
          ...viewOnlyFields,
          ...(additionalInstruction && { additionalInstruction }),
          ...(childSessions.length > 0 && { childSessions }),
          ...(importantDescendants.length > 0 && { importantDescendants }),
          ...(importantDescendantEvents.length > 0 && { importantDescendantEvents }),
          ...(tokenUsage && { tokenUsage }),
          timing,
          logs
        },
      };
    }

    const state = effectiveApprovalPart.state;
    const rolledBackAfterResume = cascadeLeaf
      ? approvalWasRolledBackAfterResume(cascadeLeaf.session, effectiveApprovalPart, cascadeLeaf.parts)
      : approvalWasRolledBackAfterResume(found.session, effectiveApprovalPart, parts);
    const sessionStatus = rolledBackAfterResume ? 'error' : found.session.status;
    if (rolledBackAfterResume) {
      logs = logsWithRecoveredApprovalDecision(logs, effectiveApprovalPart);
    }
    const input = valueAsRecord(state.input);
    const metadata = valueAsRecord(state.metadata);
    const resumePayload = state.status === 'pending'
      ? valueAsRecord(state.resumePayload)
      : valueAsRecord(metadata.resumePayload);
    const isGenericToolApproval = resumePayload.kind === 'tool_approval';
    const expectedToken = typeof resumePayload.resumeToken === 'string' ? resumePayload.resumeToken : undefined;
    // For read-only views (e.g. /status polling, page render via an old Slack
    // link), accept any resumeToken that was issued for any await_human gate
    // in this session. /decision and resume.ts keep strict latest-token
    // checks, so authorization to act is not weakened.
    const tokenMatchesHistory = (() => {
      if (!req.allowHistorical || !req.resumeToken) return false;
      for (const part of approvalParts) {
        const partState = (part as any).state ?? {};
        const partMeta = valueAsRecord(partState.metadata);
        const partPayload = partState.status === 'pending'
          ? valueAsRecord(partState.resumePayload)
          : valueAsRecord(partMeta.resumePayload);
        if (typeof partPayload.resumeToken === 'string' && partPayload.resumeToken === req.resumeToken) {
          return true;
        }
      }
      return false;
    })();
    // skipTokenCheck is set only by the serve process after it has already
    // authorized the viewer; it lets the unified /sessions/:id page resolve
    // the current gate's resumeToken without the caller knowing it.
    if (expectedToken && expectedToken !== req.resumeToken && !tokenMatchesHistory && !req.skipTokenCheck) {
      return {
        id: req.id,
        success: false,
        error: { code: 'RESUME_TOKEN_INVALID', message: 'Invalid approval token' },
      };
    }
    if (!expectedToken) {
      return {
        id: req.id,
        success: true,
        approval: {
          sessionId: req.sessionId,
          sessionStatus,
          ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
          model: found.session.model,
          ...mockField(found.session),
          ...sessionErrorFields(found.session),
          ...dismissedAtField(found.session),
          ...(reopenable && { reopenable }),
          agent: {
            id: found.session.agent.id,
            name: found.session.agent.name,
            ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
            ...(found.session.agent.description && { description: found.session.agent.description })
          },
          ...(learning && { learning }),
          ...originAgentFields,
          ...viewOnlyFields,
          ...(additionalInstruction && { additionalInstruction }),
          ...(childSessions.length > 0 && { childSessions }),
          ...(importantDescendants.length > 0 && { importantDescendants }),
          ...(importantDescendantEvents.length > 0 && { importantDescendantEvents }),
          ...(tokenUsage && { tokenUsage }),
          timing,
          logs
        },
      };
    }

    // Cascade: the gate lives on the leaf, but the root's log shows only its
    // pending `subagent__*` bookmark entry. Surface the leaf's full gate on
    // that bookmark entry (prompt/summary/draft/risk + resume token) so the
    // session page renders it as one actionable approval box. Without the
    // gate content the entry renders an empty approval card; without the
    // token the approve/reject/comment actions never attach. Skip for a
    // delegated child (its own page is view-only).
    if (cascadeLeaf && !isDelegatedChild && state.status === 'pending' && expectedToken && !rolledBackAfterResume) {
      const bookmarkPart = parts.find((part: any) =>
        part?.type === 'tool' &&
        part?.state?.status === 'pending' &&
        part?.state?.resumePayload?.kind === 'subagent_wait'
      );
      if (bookmarkPart) {
        const bookmarkId = String(bookmarkPart.id);
        const leafGateDetails = isGenericToolApproval
          ? buildApprovalLogs(cascadeLeaf.parts).find((entry) => entry.id === String(effectiveApprovalPart.id))?.details
          : buildAwaitHumanDetails(state);
        if (leafGateDetails) {
          // The gate is the leaf's, and so is the verdict that produced it:
          // the manager's own parts carry neither.
          const leafJudge = judgeSummaryForGate(cascadeLeaf.parts, String(effectiveApprovalPart.id));
          const leafJudgeSession = leafJudge && importantDescendants.find((descendant) =>
            descendant.parentSessionId === cascadeLeaf!.session.id
            && descendant.kinds.includes('judge')
            && judgedAttempt(descendant, leafJudge.attempt)
          );
          logs = logs.map((entry) => entry.id === bookmarkId
            ? { ...entry, details: {
                ...(entry.details ?? {}),
                ...leafGateDetails,
                ...(leafJudge && { judge: {
                  ...leafJudge,
                  ...(leafJudgeSession && { sessionId: leafJudgeSession.sessionId }),
                } }),
              } }
            : entry);
        }
      }
    }

    const channelMessage = valueAsRecord(resumePayload.channelMessage);
    let approvalUrl: string | undefined;
    if (cascadeLeaf) {
      // The leaf minted a URL to its own (view-only) child page; the human acts at
      // the root, so rewrite the gate URL to this session.
      const { getSessionUrl } = await import('../tools/await-human.js');
      approvalUrl = getSessionUrl(req.sessionId, req.projectRoot);
    } else {
      approvalUrl = typeof resumePayload.approvalUrl === 'string'
        ? resumePayload.approvalUrl
        : typeof channelMessage.url === 'string'
          ? channelMessage.url
          : undefined;
    }
    const detailDraftUrl = safeHttpUrl(input.draft_url);
    const detailArtifactUrl = safeHttpUrl(input.artifact_url);
    const payloadChanges = normalizeApprovalChanges(input.changes);
    const payloadReference = normalizeApprovalReference(input.reference);
    const payloadOptions = normalizeApprovalOptions(input.options);
    const genericToolName = typeof resumePayload.toolName === 'string'
      ? resumePayload.toolName
      : String(effectiveApprovalPart.tool);
    const approvalPrompt = typeof input.prompt === 'string' && input.prompt.trim().length > 0
      ? repairEscapedText(input.prompt)
      : isGenericToolApproval
        ? `Approve execution of ${genericToolName}?`
        : undefined;
    const fullToolApproval = (() => {
      if (!isGenericToolApproval || typeof resumePayload.approvalId !== 'string') return undefined;
      const canonicalFallback = completeApprovalValueDisplay(state.input);
      const signedRawValue = Object.prototype.hasOwnProperty.call(state, 'rawApprovedInput')
        ? state.rawApprovedInput
        : state.input;
      const signedRawFallback = completeApprovalValueDisplay(signedRawValue);
      return {
        approvalId: resumePayload.approvalId,
        toolCallId: typeof resumePayload.toolCallId === 'string'
          ? resumePayload.toolCallId
          : String(effectiveApprovalPart.callID),
        toolName: genericToolName,
        canonicalInput: typeof resumePayload.canonicalInputDisplay === 'string'
          ? resumePayload.canonicalInputDisplay
          : canonicalFallback.text,
        canonicalInputDigest: typeof resumePayload.canonicalInputDigest === 'string'
          ? resumePayload.canonicalInputDigest
          : canonicalFallback.sha256,
        signedRawInput: typeof resumePayload.signedRawInputDisplay === 'string'
          ? resumePayload.signedRawInputDisplay
          : signedRawFallback.text,
        signedRawInputDigest: typeof resumePayload.signedRawInputDigest === 'string'
          ? resumePayload.signedRawInputDigest
          : signedRawFallback.sha256,
        ...(typeof resumePayload.signature === 'string' && { signature: resumePayload.signature }),
      };
    })();
    if (fullToolApproval && state.status === 'pending') {
      // The ordinary log projection stays bounded. Replace only the actionable
      // gate card with the complete reviewer representation captured before
      // session JSON persistence could truncate or coerce the canonical value.
      logs = logs.map((entry) => {
        if (
          entry.id !== String(effectiveApprovalPart.id)
          && entry.details?.resumeToken !== expectedToken
        ) return entry;
        const { toolCallId: _toolCallId, ...logToolApproval } = fullToolApproval;
        return {
          ...entry,
          details: {
            ...(entry.details ?? {}),
            ...(approvalPrompt && { prompt: approvalPrompt }),
            toolApproval: logToolApproval,
          },
        };
      });
    }
    return {
      id: req.id,
      success: true,
      approval: {
        sessionId: req.sessionId,
        sessionStatus,
        approvalKind: isGenericToolApproval ? 'tool_approval' : 'await_human',
        ...(typeof found.session.time?.created === 'number' && { createdAt: found.session.time.created }),
        model: found.session.model,
        ...mockField(found.session),
        ...sessionErrorFields(found.session),
        ...dismissedAtField(found.session),
        ...(reopenable && { reopenable }),
        agent: {
          id: found.session.agent.id,
          name: found.session.agent.name,
          ...(found.session.agent.filePath && { filePath: found.session.agent.filePath }),
          ...(found.session.agent.description && { description: found.session.agent.description })
        },
        ...(learning && { learning }),
        ...originAgentFields,
        ...viewOnlyFields,
        ...(additionalInstruction && { additionalInstruction }),
        ...(fullToolApproval && { toolApproval: fullToolApproval }),
        ...(approvalPrompt && { prompt: approvalPrompt }),
        ...(typeof input.summary === 'string' && { summary: repairEscapedText(input.summary) }),
        ...(typeof input.draft === 'string' && { draft: repairEscapedText(input.draft) }),
        ...(payloadChanges && { changes: payloadChanges }),
        ...(payloadReference && { reference: payloadReference }),
        ...(payloadOptions && { options: payloadOptions }),
        ...(detailDraftUrl && { draftUrl: detailDraftUrl }),
        ...(detailArtifactUrl && { artifactUrl: detailArtifactUrl }),
        ...(typeof input.context === 'string' && { context: repairEscapedText(input.context) }),
        ...(typeof input.risk === 'string' && { risk: repairEscapedText(input.risk) }),
        ...(typeof resumePayload.surface === 'string' && { surface: resumePayload.surface }),
        ...(approvalUrl && { approvalUrl }),
        // Delegated children are view-only: never surface an actionable token; the
        // root surfaces the gate (with this same leaf token) for the human to act.
        ...(state.status === 'pending' && expectedToken && !rolledBackAfterResume && !isDelegatedChild && { currentResumeToken: expectedToken }),
        ...(typeof resumePayload.expiresAt === 'number' && { expiresAt: resumePayload.expiresAt }),
        ...(typeof state.suspendedAt === 'number' && { suspendedAt: state.suspendedAt }),
        ...(Object.keys(channelMessage).length > 0 && { channelMessage }),
        ...(state.status === 'completed' && { decision: state.output }),
        ...(childSessions.length > 0 && { childSessions }),
        ...(importantDescendants.length > 0 && { importantDescendants }),
        ...(importantDescendantEvents.length > 0 && { importantDescendantEvents }),
        ...(tokenUsage && { tokenUsage }),
        timing,
        logs
      },
    };
  } catch (err) {
    // Corruption in the *requested* session's own files (session.json,
    // message, or part) can't be silently skipped like an unrelated session
    // in a list scan: it's the thing being viewed. Surface a distinct code so
    // the session page renders a clear "this session's data is corrupted"
    // error instead of spinning on a generic 500.
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

export type ApprovalInfoResponse = Awaited<ReturnType<typeof getApprovalInfoUncached>>;
