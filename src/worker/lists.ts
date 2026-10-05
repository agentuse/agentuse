import { gateRound } from '../session/gate-rounds';
import { findPendingSubagentWaitChildId, loadSessionPartsFlat, descendToLeafGate, findStaleCascadeChild, describeStaleCascade, CASCADE_ORPHANED_CODE } from '../runner/subagent-cascade';
import { readOutcomeCall } from '../tools/report-outcome';
import { logger } from '../utils/logger';
import { SessionManager } from '../session/index.js';
import { initStorage, CorruptStorageError, readJSON, writeJSON } from '../storage/index.js';
import type { SessionInfo } from '../session';
import { approvalPartCache, approvalPartCacheKey, boundedCacheSet, listCacheKey, sessionBelongsToProject, withListCache, MAX_CACHED_APPROVAL_PARTS } from './cache.js';
import { approvalProjectionKey, dismissedAtField, mockField, sessionErrorFields, valueAsRecord } from './helpers.js';
import { normalizeApprovalOptions, normalizeReviewEscalation } from './approval-logs.js';
import type { WorkerContext } from './context.js';
import type { ApprovalProjectionIndex, ApprovalSummary, ApprovalSummaryStatus, ExecuteRequest } from './types.js';
import type { SessionListSummary } from '../session/manager.js';
import type { SessionSuccessfulOutcome } from '../session/types.js';

export async function listAllApprovals(ctx: WorkerContext, req: ExecuteRequest) {
  return withListCache(ctx, listCacheKey(req, 'approvals'), req.id, async () => {
  try {
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const approvalGeneration = await sessionManager.getApprovalIndexGeneration();
    const projectionKey = approvalProjectionKey(req.projectRoot);
    let projection: ApprovalProjectionIndex | null = null;
    try {
      projection = await readJSON<ApprovalProjectionIndex>(projectionKey);
    } catch (error) {
      if (!(error instanceof CorruptStorageError)) throw error;
      logger.warn(`Rebuilding corrupt approval index: ${error.message}`);
    }
    if (projection && projection.approvalGeneration === approvalGeneration && Array.isArray(projection.approvals)) {
      return {
        id: req.id,
        success: true as const,
        approvals: typeof req.approvalCreatedAfter === 'number'
          ? projection.approvals.filter((approval) => (approval.createdAt ?? 0) >= req.approvalCreatedAfter!)
          : projection.approvals,
      };
    }

    const indexedSessions = await sessionManager.listSessionSummaries({ includeSubagents: true });
    const indexedTopLevel = indexedSessions.filter((session) =>
      !session.parentSessionId && sessionBelongsToProject(session, req.projectRoot)
    );
    const currentSessionIds = new Set(indexedTopLevel.map((session) => session.sessionId));
    const indexedById = new Map(indexedSessions.map((session) => [session.sessionId, session]));
    // Approval rows are owned by the root manager, but the durable gate lives
    // on the delegated leaf. A reviewer comment can resume and re-gate that
    // leaf without changing the root's timestamp, so root.updatedAt alone is
    // not a sufficient incremental-projection revision. Fold every
    // approval-relevant descendant's timestamp into its root instead. The
    // compact index makes this O(session count * cascade depth) without
    // reading any message or part trees.
    const approvalSourceUpdatedAt = new Map<string, number>();
    for (const session of indexedSessions) {
      if (session.approvalRelevant !== true) continue;
      let root = session;
      const seen = new Set<string>([session.sessionId]);
      while (root.parentSessionId) {
        if (seen.has(root.parentSessionId)) break;
        seen.add(root.parentSessionId);
        const parent = indexedById.get(root.parentSessionId);
        if (!parent) break;
        root = parent;
      }
      if (!currentSessionIds.has(root.sessionId)) continue;
      approvalSourceUpdatedAt.set(
        root.sessionId,
        Math.max(approvalSourceUpdatedAt.get(root.sessionId) ?? 0, session.updatedAt)
      );
    }
    const priorApprovals = projection && Array.isArray(projection.approvals)
      ? projection.approvals.filter((approval) => currentSessionIds.has(approval.sessionId))
      : [];
    const priorSourceUpdatedAt = projection?.version === 2 && projection.sourceUpdatedAt
      ? projection.sourceUpdatedAt
      : {};
    const incremental = projection !== null && Array.isArray(projection.approvals);
    const summariesToRefresh = incremental
      ? indexedTopLevel.filter((session) =>
          approvalSourceUpdatedAt.has(session.sessionId) &&
          priorSourceUpdatedAt[session.sessionId] !== approvalSourceUpdatedAt.get(session.sessionId)
        )
      : indexedTopLevel;
    const refreshIds = new Set(summariesToRefresh.map((session) => session.sessionId));
    const approvals: ApprovalSummary[] = incremental
      ? priorApprovals.filter((approval) => !refreshIds.has(approval.sessionId))
      : [];
    const sourceUpdatedAt: Record<string, number> = incremental
      ? Object.fromEntries(Object.entries(priorSourceUpdatedAt).filter(([sessionId]) => currentSessionIds.has(sessionId)))
      : {};
    const sessionBatchSize = 16;

    const summarizeApproval = async (
      { session, agentId }: { session: SessionInfo; agentId: string }
    ): Promise<ApprovalSummary | null> => {
      if (!sessionBelongsToProject(session, req.projectRoot)) {
        return null;
      }
      // Delegated children surface through their root manager's single cascade
      // entry, not as separate approvals. Skip them here to avoid double-counting.
      if (typeof session.parentSessionID === 'string' && session.parentSessionID.length > 0) {
        return null;
      }
      const cacheKey = approvalPartCacheKey(req.projectRoot, session, agentId);
      const updatedAt = session.time.updated;
      const cached = approvalPartCache.get(cacheKey);
      const gate = cached && cached.updatedAt === updatedAt
        ? cached
        : await sessionManager.getLatestApprovalGate(session.id, agentId);
      let approvalPart = gate?.part ?? null;
      let round = gate?.round ?? 1;
      if (!cached || cached.updatedAt !== updatedAt) {
        boundedCacheSet(approvalPartCache, cacheKey, { updatedAt, part: approvalPart, round }, MAX_CACHED_APPROVAL_PARTS);
      }
      // Cascade: a root parked on a delegated child's gate (subagent_wait) has no
      // await_human part of its own. Descend to the leaf and surface its gate here,
      // labeled with the leaf but addressed at the root session.
      let originAgentName: string | undefined;
      let originAgentFilePath: string | undefined;
      if (!approvalPart && session.status === 'suspended') {
        const rootParts = await loadSessionPartsFlat(sessionManager, session.id, agentId);
        const childId = findPendingSubagentWaitChildId(rootParts);
        if (childId) {
          const leaf = await descendToLeafGate(sessionManager, childId);
          if (leaf) {
            approvalPart = leaf.approvalPart;
            round = gateRound(leaf.parts);
            originAgentName = leaf.session.agent.name;
            originAgentFilePath = leaf.session.agent.filePath;
          } else {
            // The bookmark points at a child that ended (or is itself stuck) without
            // its ancestors ever being resumed. There is no gate left to act on, but
            // the root is still durably `suspended`, so dropping it here made it
            // invisible everywhere: absent from every approvals bucket, and rendered
            // "resuming" on home forever. Surface it as an errored approval instead,
            // naming the child that broke the chain.
            const stale = await findStaleCascadeChild(sessionManager, childId);
            if (stale) {
              const createdAt = session.time.created;
              return {
                sessionId: session.id,
                agentId,
                agentName: session.agent.name || session.agent.id,
                ...(session.agent.description && { agentDescription: session.agent.description }),
                ...(session.agent.filePath && { agentFilePath: session.agent.filePath }),
                status: 'errored' as const,
                sessionStatus: session.status,
                createdAt,
                errorCode: CASCADE_ORPHANED_CODE,
                errorMessage: describeStaleCascade(stale),
                ...(session.channels && { channels: session.channels }),
              };
            }
          }
        }
      }
      if (!approvalPart) return null;

      const state = approvalPart.state;
      const input = valueAsRecord(state.input);
      const metadata = 'metadata' in state ? valueAsRecord(state.metadata) : {};
      const resumePayload = state.status === 'pending'
        ? valueAsRecord(state.resumePayload)
        : valueAsRecord(metadata.resumePayload);
      const channelMessage = valueAsRecord(resumePayload.channelMessage);
      const output = state.status === 'completed' ? valueAsRecord(state.output) : {};
      const approvalResponse = valueAsRecord(metadata.approvalResponse);
      const isGenericToolApproval = resumePayload.kind === 'tool_approval';
      const reviewEscalation = normalizeReviewEscalation(resumePayload.reviewEscalation);
      const reviewer = isGenericToolApproval
        ? valueAsRecord(metadata.approvalReviewer)
        : valueAsRecord(output.reviewer);
      const suspendedAt = state.status === 'pending' && typeof state.suspendedAt === 'number'
        ? state.suspendedAt
        : undefined;

      let status: ApprovalSummaryStatus;
      let errorMessage: string | undefined;
      const sessionError = sessionErrorFields(session);
      if (isGenericToolApproval && approvalResponse.type === 'tool-approval-response' && approvalResponse.approved === false) {
        status = 'rejected';
      } else if (isGenericToolApproval && approvalResponse.type === 'tool-approval-response' && approvalResponse.approved === true) {
        status = 'approved';
      } else if (state.status === 'pending' && session.error?.code === 'USER_STOPPED') {
        status = 'errored';
        errorMessage = session.error.message || 'Session stopped by user';
      } else if (state.status === 'pending' && session.error?.code === 'TIMEOUT') {
        status = 'expired';
        errorMessage = session.error.message || 'Session timed out';
      } else if (state.status === 'pending' && session.status !== 'suspended' && session.status !== 'running') {
        // The gate part is still 'pending' but the run terminally ended (errored,
        // completed, stopped, timed out) without resolving it. An orphaned gate on a
        // dead session is not an actionable approval - classify it as errored so it
        // drops out of the pending bucket instead of lingering as unclearable forever.
        status = 'errored';
        errorMessage = session.error?.message || sessionError.errorMessage;
      } else if (state.status === 'pending') {
        status = 'pending';
      } else if (state.status === 'completed') {
        const decisionStatus = typeof output.status === 'string' ? output.status.toLowerCase() : '';
        status = decisionStatus === 'approve' || decisionStatus === 'approved'
          ? 'approved'
          : decisionStatus === 'reject' || decisionStatus === 'rejected'
            ? 'rejected'
            : decisionStatus === 'comment' || decisionStatus === 'commented'
              ? 'commented'
              : 'approved';
      } else if (state.status === 'error') {
        const errText = typeof state.error === 'string' ? state.error : '';
        status = /timed out|timeout|APPROVAL_TIMEOUT/i.test(errText) ||
          session.error?.code === 'APPROVAL_TIMEOUT'
          ? 'expired'
          : 'errored';
        errorMessage = errText || session.error?.message;
      } else {
        status = 'errored';
      }
      if (sessionError.errorMessage) errorMessage = sessionError.errorMessage;

      const decisionAt = state.status === 'completed' || state.status === 'error'
        ? (typeof state.time?.end === 'number' ? state.time.end : undefined)
        : undefined;

      return {
        sessionId: session.id,
        agentId,
        // Label cascade entries with the originating leaf; addressed at the root.
        agentName: originAgentName ?? (session.agent.name || session.agent.id),
        ...(session.agent.description && { agentDescription: session.agent.description }),
        ...((originAgentFilePath ?? session.agent.filePath) && { agentFilePath: originAgentFilePath ?? session.agent.filePath }),
        status,
        sessionStatus: session.status,
        ...(reviewEscalation
          ? { prompt: 'Revision needs your input' }
          : typeof input.prompt === 'string'
            ? { prompt: input.prompt }
          : isGenericToolApproval
            ? { prompt: `Approve execution of ${approvalPart.tool}?` }
            : {}),
        ...(typeof input.summary === 'string' && { summary: input.summary }),
        ...(typeof input.risk === 'string' && { risk: input.risk }),
        ...(normalizeApprovalOptions(input.options) && { hasOptions: true }),
        ...(reviewEscalation && { needsRevisionGuidance: true }),
        ...(round > 1 && { round }),
        ...(suspendedAt !== undefined && { suspendedAt }),
        ...(typeof resumePayload.expiresAt === 'number' && { expiresAt: resumePayload.expiresAt }),
        ...(typeof session.time?.created === 'number' && { createdAt: session.time.created }),
        ...(decisionAt !== undefined && { decisionAt }),
        ...(isGenericToolApproval && typeof approvalResponse.approved === 'boolean'
          ? { decisionStatus: approvalResponse.approved ? 'approved' : 'rejected' }
          : typeof output.status === 'string'
            ? { decisionStatus: output.status }
            : {}),
        ...(isGenericToolApproval && typeof approvalResponse.reason === 'string'
          ? { decisionComment: approvalResponse.reason }
          : typeof output.comment === 'string'
            ? { decisionComment: output.comment }
            : {}),
        ...(typeof reviewer.username === 'string' && { decisionReviewer: reviewer.username }),
        ...(typeof resumePayload.resumeToken === 'string' && { resumeToken: resumePayload.resumeToken }),
        ...(sessionError.errorCause && { errorCause: sessionError.errorCause }),
        ...(sessionError.errorSubject && { errorSubject: sessionError.errorSubject }),
        ...(sessionError.errorCauseSource && { errorCauseSource: sessionError.errorCauseSource }),
        ...(sessionError.errorCode && { errorCode: sessionError.errorCode }),
        ...(errorMessage && { errorMessage }),
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
      };
    };

    // A stale projection used to trigger listAllSessions(), reading every
    // historical session and regularly exceeding the serve worker's 30s RPC
    // deadline after worker recycling. The compact session index already
    // records exactly which roots have participated in an approval lifecycle.
    // Preserve legacy rows from the previous projection and re-read only
    // indexed approval roots whose timestamp changed. A missing/corrupt
    // projection still takes the conservative full-history bootstrap path.
    for (let i = 0; i < summariesToRefresh.length; i += sessionBatchSize) {
      const summaryBatch = summariesToRefresh.slice(i, i + sessionBatchSize);
      const batch = (await Promise.all(summaryBatch.map((summary) =>
        sessionManager.findSession(summary.sessionId)
      ))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const summaries = await Promise.all(batch.map(summarizeApproval));
      approvals.push(...summaries.filter((approval): approval is ApprovalSummary => approval !== null));
      for (const summary of summaryBatch) {
        sourceUpdatedAt[summary.sessionId] = approvalSourceUpdatedAt.get(summary.sessionId) ?? summary.updatedAt;
      }
    }

    await writeJSON(projectionKey, {
      version: 2,
      approvalGeneration,
      approvals,
      sourceUpdatedAt,
    } satisfies ApprovalProjectionIndex);

    return {
      id: req.id,
      success: true as const,
      approvals: typeof req.approvalCreatedAfter === 'number'
        ? approvals.filter((approval) => (approval.createdAt ?? 0) >= req.approvalCreatedAfter!)
        : approvals,
    };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'LIST_APPROVALS_ERROR', message: (err as Error).message }
    };
  }
  });
}

/** Recover the latest successful verdict from the newest stored turn. This is
 * used once for sessions written before the compact index carried `outcome`;
 * the result is then persisted into that index, so steady-state list polling
 * remains an index-only operation. */
async function storedSuccessfulOutcome(
  sessionManager: SessionManager,
  session: SessionListSummary,
): Promise<SessionSuccessfulOutcome> {
  const messages = await sessionManager.getSessionMessages(session.sessionId, session.agent.id);
  // Compaction summaries can be appended after the primary run message. They
  // are context bookkeeping, not a new outcome boundary.
  const latest = [...messages].reverse().find((message) => message.assistant.summary !== true);
  if (!latest) return 'complete';
  const parts = await sessionManager.getMessageParts(session.sessionId, session.agent.id, latest.id);
  for (const part of [...parts].reverse()) {
    if (part.type !== 'tool' || part.state.status !== 'completed') continue;
    const call = readOutcomeCall(part.tool, part.state.input);
    if (!call || call.status === 'incomplete') continue;
    return call.status;
  }
  // Runs from before report_outcome, and models that omitted the tool, retain
  // the historical successful-completion behavior.
  return 'complete';
}

async function backfillSuccessfulOutcomes(
  sessionManager: SessionManager,
  sessions: SessionListSummary[],
): Promise<Map<string, SessionSuccessfulOutcome>> {
  const outcomes = new Map<string, SessionSuccessfulOutcome>();
  const missing = sessions.filter((session) => session.status === 'completed' && !session.outcome);
  const batchSize = 10;
  for (let index = 0; index < missing.length; index += batchSize) {
    await Promise.all(missing.slice(index, index + batchSize).map(async (session) => {
      try {
        const outcome = await storedSuccessfulOutcome(sessionManager, session);
        const persisted = await sessionManager.backfillSessionOutcome(
          session.sessionId,
          session.agent.id,
          outcome,
          session.updatedAt,
        );
        if (persisted) outcomes.set(session.sessionId, outcome);
      } catch (error) {
        logger.warn(`Could not recover outcome for session ${session.sessionId}: ${(error as Error).message}`);
      }
    }));
  }
  return outcomes;
}

export async function listSessions(ctx: WorkerContext, req: ExecuteRequest) {
  return withListCache(ctx, listCacheKey(req, 'sessions'), req.id, async () => {
  try {
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const sessions = await sessionManager.listSessionSummaries({
      ...(typeof req.sessionsUpdatedAfter === 'number' && { updatedAfter: req.sessionsUpdatedAfter }),
      includeSubagents: req.includeSubagents ?? false,
      // A time window bounds history, not work still in progress. Otherwise a
      // stalled long-running session disappears from Home at the boundary.
      includeLiveBeforeUpdatedAfter: true,
    });
    const backfilledOutcomes = await backfillSuccessfulOutcomes(sessionManager, sessions);

    // Top-level runs by default; approval-filtered session views opt into
    // subagents so approval history links can land on the exact run.
    let summaries = sessions
      .filter((session) => sessionBelongsToProject(session, req.projectRoot))
      .filter((session) => req.sessionsMock === 'include' || (req.sessionsMock === 'only' ? session.mock === true : session.mock !== true))
      .map((session) => ({
        sessionId: session.sessionId,
        ...(session.parentSessionId && { parentSessionId: session.parentSessionId }),
        agent: {
          id: session.agent.id,
          name: session.agent.name,
          ...(session.agent.description && { description: session.agent.description }),
          ...(session.agent.filePath && { filePath: session.agent.filePath }),
          ...(session.agent.isSubAgent && { isSubAgent: true }),
        },
        status: session.status,
        ...((session.outcome ?? backfilledOutcomes.get(session.sessionId)) && {
          outcome: session.outcome ?? backfilledOutcomes.get(session.sessionId),
        }),
        trigger: session.trigger ?? 'manual',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        timing: session.timing,
        ...sessionErrorFields(session),
        ...dismissedAtField(session),
        ...mockField(session),
        ...(session.subagentActive && { subagentActive: true }),
      }))
      .sort((a, b) =>
        ((a.status === 'preparing' || a.status === 'running' || a.subagentActive) ? 0 : 1)
        - ((b.status === 'preparing' || b.status === 'running' || b.subagentActive) ? 0 : 1)
        || b.updatedAt - a.updatedAt
        || b.createdAt - a.createdAt
      );

    if (typeof req.sessionsPerAgent === 'number' && req.sessionsPerAgent > 0) {
      const counts = new Map<string, number>();
      summaries = summaries.filter((session) => {
        const key = session.agent.filePath ?? session.agent.id;
        const count = counts.get(key) ?? 0;
        if (count >= req.sessionsPerAgent!) return false;
        counts.set(key, count + 1);
        return true;
      });
    }
    if (typeof req.sessionsLimit === 'number' && req.sessionsLimit > 0) {
      summaries = summaries.slice(0, req.sessionsLimit);
    }

    return {
      id: req.id,
      success: true as const,
      sessions: summaries
    };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'LIST_SESSIONS_ERROR', message: (err as Error).message }
    };
  }
  });
}

export async function getSessionFinalResponses(req: ExecuteRequest) {
  try {
    await initStorage(req.projectRoot);
    const sessionManager = new SessionManager();
    const refs = (req.sessionRefs ?? []).slice(0, 100);
    const responses: Record<string, string> = {};

    // Bound concurrent filesystem walks: feed pages are normally 50 rows,
    // and reading them all at once can overwhelm slower networked volumes.
    const batchSize = 10;
    for (let index = 0; index < refs.length; index += batchSize) {
      const batch = refs.slice(index, index + batchSize);
      const values = await Promise.all(batch.map(async (ref) => ({
        sessionId: ref.sessionId,
        text: await sessionManager.getLastAssistantText(ref.sessionId, ref.agentId),
      })));
      for (const value of values) {
        if (value.text !== undefined) responses[value.sessionId] = value.text;
      }
    }

    return { id: req.id, success: true as const, responses };
  } catch (err) {
    return {
      id: req.id,
      success: false as const,
      error: { code: 'SESSION_FINAL_RESPONSES_ERROR', message: (err as Error).message }
    };
  }
}
