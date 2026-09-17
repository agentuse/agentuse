import { activeTimingForTree, sessionTimingRow } from '../session/timing';
import { classifyFailure } from '../runner/failure';
import { ExecutionBudget } from '../runner/execution-budget';
import { dirname, join } from 'path';
import { parseAgent } from '../parser';
import { connectMCP } from '../mcp';
import { runAgent, prepareAgentExecution, applyResumeToolResult, restoreResumeToolResult, workerRunResponse } from '../runner';
import { composeSubagentResult } from '../tools/report-outcome';
import { findPendingSubagentWaitChildId, findPendingAwaitHumanPart, loadSessionPartsFlat, describeStaleCascade, isRecoverableCascadeFailure, isFinishableStale, loadStoredSubagentResult, CASCADE_ORPHANED_CODE, CASCADE_RECOVERABLE_CODE, MAX_CASCADE_DEPTH } from '../runner/subagent-cascade';
import { currentProcessRef } from '../utils/process-info';
import { withOwnershipLock } from '../utils/ownership-lock';
import { buildDescendantActivity, buildDescendantReport, buildImportantDescendantEvents, buildImportantDescendants } from '../session/important-descendants';
import { resolveProjectContext } from '../utils/project';
import { logger } from '../utils/logger';
import { PluginManager } from '../plugin';
import { assertResolvedToolCall, rehydrateMessages, SessionManager } from '../session/index.js';
import type { Part, SessionInfo } from '../session';
import type { ModelMessage } from 'ai';
import { sessionErrorFields } from './helpers.js';
import type { WorkerContext } from './context.js';

export async function sessionHierarchySummaries(
  sessionManager: InstanceType<typeof SessionManager>,
  rootSession: SessionInfo,
  sessionId: string,
  sessionPath?: string,
  /** The root's own parts: judge children hanging directly off the root read
   *  their verdict from the root's verify markers, which `evidence` omits. */
  rootParts?: Part[]
) {
  const descendants = await sessionManager.listDescendantSessions(sessionId, sessionPath);
  const summarize = ({ session, parts }: { session: SessionInfo; parts?: Part[] }) => ({
    sessionId: session.id,
    agent: {
      id: session.agent.id,
      name: session.agent.name,
      ...(session.agent.description && { description: session.agent.description }),
      ...(session.agent.filePath && { filePath: session.agent.filePath }),
    },
    status: session.status,
    trigger: session.trigger ?? 'manual',
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    timing: activeTimingForTree(session.id, evidence.map(item => sessionTimingRow(item.session))),
    ...sessionErrorFields(session),
    ...(() => {
      const activity = buildDescendantActivity(session, parts ?? []);
      return activity ? { activity } : {};
    })(),
    ...(() => {
      const report = buildDescendantReport(parts ?? []);
      return report ? { report } : {};
    })(),
  });
  const evidence = await Promise.all(descendants.map(async ({ session, agentId }) => {
    try {
      const messages = await sessionManager.getSessionMessages(session.id, agentId);
      const parts = (await Promise.all(
        messages.map((message) => sessionManager.getMessageParts(session.id, agentId, message.id))
      )).flat() as Part[];
      return { session, parts };
    } catch (error) {
      // A damaged descendant must not make its Manager page unreadable. Its
      // terminal session status still participates in failure bubbling.
      logger.debug(`Failed to inspect descendant ${session.id}: ${(error as Error).message}`);
      return { session, parts: [] as Part[] };
    }
  }));
  const childSessions = evidence
    .filter(({ session }) => session.parentSessionID === sessionId)
    .map(summarize);
  return {
    childSessions,
    importantDescendants: buildImportantDescendants(rootSession, evidence, rootParts),
    importantDescendantEvents: buildImportantDescendantEvents(rootSession, evidence),
    evidence,
  };
}

// Resume one existing (suspended) session to completion or re-suspension, reusing
// the same prepare/run machinery as a top-level resume. The caller must already
// have flipped the session to a resumable state (leaf gate resolved, or the
// parent's subagent_wait bookmark completed + session set running). runAgent
// closes the MCP clients in its own finally; we close them too if it never runs.
export async function runExistingSession(opts: {
  ctx: WorkerContext;
  sessionManager: InstanceType<typeof SessionManager>;
  sessionId: string;
  projectRoot: string;
  abortController: AbortController;
  startTime: number;
  debug?: boolean;
  maxSteps?: number;
  continuationPrompt?: string;
  prebuiltMessages?: ModelMessage[];
}): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const { ctx, sessionManager, sessionId, projectRoot, abortController, startTime, debug, maxSteps, continuationPrompt, prebuiltMessages } = opts;
  const existingSessionPreRunError = Symbol.for('agentuse.existingSessionPreRunError');
  const markPreRunError = (error: unknown): unknown => {
    if (error && typeof error === 'object') {
      try {
        Object.defineProperty(error, existingSessionPreRunError, { value: true });
      } catch {
        // Non-extensible errors still propagate normally; they just won't be rollback-marked.
      }
    }
    return error;
  };
  let mcp: Awaited<ReturnType<typeof connectMCP>> = [];
  let executionBudget: ExecutionBudget | undefined;
  let enteredRunAgent = false;
  try {
    const found = await sessionManager.findSession(sessionId);
    if (!found || !found.session.agent.filePath) {
      throw new Error(`Cannot resume session ${sessionId}: missing agent file path`);
    }
    const agentPath = found.session.agent.filePath;
    const runCwd = found.session.project.cwd || projectRoot;
    const agent = await parseAgent(agentPath);
    mcp = await connectMCP(agent.config.mcpServers, debug ?? false, dirname(agentPath), runCwd);
    const projectContext = { projectRoot, stateRoot: projectRoot, cwd: runCwd };
    let pluginManager: PluginManager | null = null;
    try {
      const pluginContext = resolveProjectContext(projectRoot, { projectRoot });
      pluginManager = new PluginManager();
      await pluginManager.loadPlugins(pluginContext.pluginDirs, pluginContext.projectRoot);
    } catch {
      pluginManager = null;
    }
    const timeoutSeconds = agent.config.timeout ?? 300;
    executionBudget = new ExecutionBudget(timeoutSeconds * 1000, { parentSignal: abortController.signal });
    ctx.activeExecutionControllers.set(sessionId, abortController);
    const preparedExecution = await prepareAgentExecution({
      agent,
      mcpClients: mcp,
      agentFilePath: agentPath,
      cliMaxSteps: maxSteps,
      sessionManager,
      projectContext,
      userPrompt: continuationPrompt,
      abortSignal: executionBudget.signal,
      pluginManager,
      verbose: debug ?? false,
      existingSessionId: sessionId,
      ...(prebuiltMessages && { prebuiltMessages }),
    });
    enteredRunAgent = true;
    return await runAgent(
      agent, mcp, debug ?? false, executionBudget.signal, startTime, false, agentPath,
      maxSteps, sessionManager, projectContext, continuationPrompt, preparedExecution, true,
      pluginManager, true, sessionId, undefined, continuationPrompt,
    );
  } catch (err) {
    // runAgent closes MCP in its own finally; if we threw before/around it, close
    // here so a failed cascade level does not leak stdio MCP subprocesses.
    for (const conn of mcp) {
      try { await conn.client.close(); } catch { /* ignore */ }
    }
    if (enteredRunAgent && executionBudget?.signal.aborted) {
      if (executionBudget.parentAborted) throw executionBudget.signal.reason;
      const failure = classifyFailure(err, executionBudget.signal);
      return { status: 'failed', text: failure.message, toolCallCount: 0, hasTextOutput: false };
    }
    throw enteredRunAgent ? err : markPreRunError(err);
  } finally {
    await executionBudget?.finish();
    ctx.activeExecutionControllers.delete(sessionId);
  }
}

export function isExistingSessionPreRunError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as any)[Symbol.for('agentuse.existingSessionPreRunError')]);
}

// The slice of a child's run result the walk-up needs. Structurally satisfied
// both by a live runAgent result and by loadStoredSubagentResult's rebuild,
// which is what lets the recovery path share the exact same walk-up code.
export interface CascadeChildResult {
  text?: string | undefined;
  complete?: { headline: string; details?: string; artifacts?: string[] } | undefined;
  incomplete?: { reason: string } | undefined;
  usage?: { totalTokens?: number | undefined } | undefined;
}

// Complete a parent's parked subagent__* step with the resumed child's real output,
// matching the shape the sub-agent tool returns on a normal run, so rehydration can
// replay the tool result and the parent can resume.
export async function completeSubagentBookmark(
  sessionManager: InstanceType<typeof SessionManager>,
  parentSessionId: string,
  parentAgentId: string,
  childSessionId: string,
  childAgentName: string,
  childResult: CascadeChildResult
): Promise<{
  rollback: NonNullable<Awaited<ReturnType<typeof applyResumeToolResult>>['rollback']>;
  resumedMessages: ModelMessage[];
}> {
  const sessionDir = await sessionManager.getSessionDirectory(parentSessionId, parentAgentId);
  return withOwnershipLock(join(sessionDir, '.resume-claim'), async () => {
    const parts = await loadSessionPartsFlat(sessionManager, parentSessionId, parentAgentId);
    const part = [...parts].reverse().find((p: any) =>
      p?.type === 'tool' &&
      p?.state?.status === 'pending' &&
      p?.state?.resumePayload?.kind === 'subagent_wait' &&
      p?.state?.resumePayload?.childSessionID === childSessionId
    ) as any;
    if (!part) {
      throw new Error(`No pending subagent_wait bookmark for child ${childSessionId} in ${parentSessionId}`);
    }
    const rollback = {
      sessionId: parentSessionId,
      agentId: parentAgentId,
      messageId: part.messageID,
      partId: part.id,
      state: part.state,
    };
    const start = typeof part.state?.suspendedAt === 'number' ? part.state.suspendedAt : Date.now();
    let updated = false;
    try {
      await sessionManager.updatePart(parentSessionId, parentAgentId, part.messageID, part.id, {
        state: {
          status: 'completed',
          input: part.state?.input ?? {},
          output: (() => {
            // Same composer as the straight-through path (subagent.ts), so a child
            // resumed after a human cleared its gate hands the parent the same
            // shape. Rebuilding this pair by hand is what used to drop the child's
            // headline and artifacts on this path alone. `childResult.text` is
            // already composed by runAgent, so the composer sees a body it merely
            // re-splits rather than an opener it would double.
            const composed = composeSubagentResult({
              agent: childAgentName,
              outcome: {
                ...(childResult.complete && { complete: childResult.complete }),
                ...(childResult.incomplete && { incomplete: childResult.incomplete }),
              },
              text: childResult.text,
            });
            return {
              output: composed.output,
              metadata: {
                ...composed.metadata,
                ...(childResult.usage?.totalTokens && { tokensUsed: childResult.usage.totalTokens }),
              },
            };
          })(),
          time: { start, end: Date.now() },
        },
      } as any);
      updated = true;
      const applied = await sessionManager.getPart(parentSessionId, parentAgentId, part.messageID, part.id) as any;
      if (applied?.state?.status !== 'completed') {
        throw new Error(`DECISION_NOT_PERSISTED: sub-agent result for ${childSessionId} did not persist to parent ${parentSessionId}`);
      }
      const resumedMessages = await rehydrateMessages(sessionManager, parentSessionId, parentAgentId);
      assertResolvedToolCall(resumedMessages, part.callID);
      await sessionManager.setSessionRunning(parentSessionId, parentAgentId);
      return { rollback, resumedMessages };
    } catch (error) {
      if (updated) {
        await restoreResumeToolResult({ sessionManager, rollback }).catch((restoreError) => {
          logger.warn(`Failed to restore sub-agent bookmark after resume history preparation failed: ${(restoreError as Error).message}`);
        });
      }
      throw error;
    }
  }, {
    staleMs: 30_000,
    retryMs: 10,
    maxWaitMs: 35_000,
    label: `resume:${parentSessionId}`,
  });
}

export function cascadeReparkedResponse(reqId: string, rootSessionId: string) {
  // A level re-suspended on a new gate; the root chain stays durably parked and the
  // gate re-surfaces at the root on the next poll. Report 'suspended' so serve keeps
  // the session in its suspended/awaiting-approval handling.
  return {
    id: reqId,
    success: true as const,
    result: { text: '', finishReason: 'suspended', duration: 0, toolCalls: 0, sessionId: rootSessionId },
  };
}

// Mark this process as the one driving a parked ancestor chain. The orphan
// sweep's only way to tell a healthy mid-cascade chain from a stranded one is
// the parent's recorded owner being alive — but until the walk-up reaches a
// parent, its owner still names whichever worker originally suspended it,
// which may be several restarts dead while this cascade is perfectly healthy
// (issue #199). Best-effort: a failed stamp only weakens that liveness
// signal, it must not block the resume.
export async function claimCascadeChain(
  sessionManager: InstanceType<typeof SessionManager>,
  chain: Array<{ sessionId: string; agentId: string }>
): Promise<void> {
  await Promise.all(chain.map(({ sessionId, agentId }) =>
    sessionManager.updateSession(sessionId, agentId, { owner: currentProcessRef() } as any).catch(() => {})
  ));
}

// Walk a parked ancestor chain back up from a finished child: complete each
// ancestor's subagent_wait bookmark with its child's real output, resume it,
// and stop if any level re-suspends on a new gate (its gate re-surfaces at
// the root on the next poll). `ancestors` is ordered root → … → parent-of-child.
// Shared by the live approval cascade (resumeApprovalCascade) and the
// storage-driven recovery path (finishCascadeFromStorage) so they can't drift.
//
// NOTE: an intermediate child's `report_incomplete` deliberately does NOT stop
// the walk. It is the child's own verdict on its product outcome, not a
// control-flow signal: in an ungated run the parent's `subagent__*` tool still
// returns the child's text and the manager keeps going (see subagent.ts).
// Returning early here instead left every ancestor durably `suspended` on a
// bookmark pointing at a child that had already ended — a run nothing could
// ever resume, absent from the approvals list, and mislabeled "resuming"
// forever.
export async function walkUpCascadeChain(opts: {
  ctx: WorkerContext;
  sessionManager: InstanceType<typeof SessionManager>;
  ancestors: Array<{ sessionId: string; agentId: string; agentName: string }>;
  childSessionId: string;
  childAgentName: string;
  childResult: CascadeChildResult;
  projectRoot: string;
  abortController: AbortController;
  startTime: number;
  debug?: boolean;
  maxSteps?: number;
}): Promise<{ suspended: true } | { suspended: false; result: Awaited<ReturnType<typeof runAgent>> }> {
  const { ctx, sessionManager, ancestors, projectRoot, abortController, startTime, debug, maxSteps } = opts;
  let childSessionId = opts.childSessionId;
  let childAgentName = opts.childAgentName;
  let childResult = opts.childResult;
  let lastParentResult: Awaited<ReturnType<typeof runAgent>> | undefined;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    let parentRollback: Awaited<ReturnType<typeof completeSubagentBookmark>>['rollback'] | undefined;
    let enteredParentRun = false;
    let parentResult: Awaited<ReturnType<typeof runAgent>>;
    try {
      const completedBookmark = await completeSubagentBookmark(sessionManager, parent.sessionId, parent.agentId, childSessionId, childAgentName, childResult);
      parentRollback = completedBookmark.rollback;
      enteredParentRun = true;
      parentResult = await runExistingSession({ ctx, sessionManager, sessionId: parent.sessionId, projectRoot, abortController, startTime, prebuiltMessages: completedBookmark.resumedMessages, ...(debug !== undefined && { debug }), ...(maxSteps !== undefined && { maxSteps }) });
      parentRollback = undefined;
    } catch (error) {
      if (parentRollback && (!enteredParentRun || isExistingSessionPreRunError(error))) {
        await restoreResumeToolResult({ sessionManager, rollback: parentRollback }).catch((restoreErr) => {
          logger.warn(`Failed to restore sub-agent bookmark after resume setup error: ${(restoreErr as Error).message}`);
        });
        await sessionManager.setSessionSuspended(parent.sessionId, parent.agentId).catch(() => {});
      }
      throw error;
    }
    if (parentResult.status === 'suspended') {
      return { suspended: true };
    }
    childResult = parentResult;
    lastParentResult = parentResult;
    childSessionId = parent.sessionId;
    childAgentName = parent.agentName;
  }
  return { suspended: false, result: lastParentResult! };
}

// Resolve a delegated approval gate by descending to the leaf, resolving it, then
// resuming child→…→root: run the leaf, complete each ancestor's bookmark with the
// child's output and resume it, stopping if any level re-suspends. Returns
// { handled: false } when the session is not a cascade root (caller does the normal
// single-session resume).
export async function resumeApprovalCascade(opts: {
  ctx: WorkerContext;
  sessionManager: InstanceType<typeof SessionManager>;
  rootSessionId: string;
  toolResult: unknown;
  resumeToken?: string;
  projectRoot: string;
  abortController: AbortController;
  startTime: number;
  reqId: string;
  debug?: boolean;
  maxSteps?: number;
}): Promise<{ handled: false } | { handled: true; response: any }> {
  const { ctx, sessionManager, rootSessionId, toolResult, resumeToken, projectRoot, abortController, startTime, reqId, debug, maxSteps } = opts;

  const rootFound = await sessionManager.findSession(rootSessionId);
  if (!rootFound) return { handled: false };
  const rootParts = await loadSessionPartsFlat(sessionManager, rootSessionId, rootFound.agentId);
  let cursorChildId = findPendingSubagentWaitChildId(rootParts);
  if (!cursorChildId) return { handled: false };

  // Build the chain root → … → leaf following pending subagent_wait bookmarks.
  const chain: Array<{ sessionId: string; agentId: string; agentName: string }> = [
    { sessionId: rootSessionId, agentId: rootFound.agentId, agentName: rootFound.session.agent.name },
  ];
  let leafFound = false;
  for (let i = 0; i < MAX_CASCADE_DEPTH && cursorChildId; i++) {
    const f = await sessionManager.findSession(cursorChildId);
    if (!f || f.session.status !== 'suspended') break;
    chain.push({ sessionId: cursorChildId, agentId: f.agentId, agentName: f.session.agent.name });
    const parts = await loadSessionPartsFlat(sessionManager, cursorChildId, f.agentId);
    if (findPendingAwaitHumanPart(parts)) { leafFound = true; break; }
    cursorChildId = findPendingSubagentWaitChildId(parts);
  }
  if (!leafFound) return { handled: false };

  const leaf = chain[chain.length - 1];

  // This process now drives the whole chain; stamp every level so the orphan
  // sweep's owner-liveness probe points at a process that actually exists.
  await claimCascadeChain(sessionManager, chain);

  // 1. Resolve the leaf's human gate with the decision.
  let leafRollback: Awaited<ReturnType<typeof applyResumeToolResult>>['rollback'] | undefined;
  const appliedLeaf = await applyResumeToolResult({
    sessionManager,
    sessionId: leaf.sessionId,
    toolResult,
    ...(resumeToken && { resumeToken }),
    buildResumedMessages: true,
  });
  leafRollback = appliedLeaf.rollback;

  // 2. Run the leaf to completion (or re-suspension on a new gate).
  let childResult: Awaited<ReturnType<typeof runAgent>>;
  try {
    if (!appliedLeaf.resumedMessages) {
      throw new Error(`RESUME_HISTORY_INVALID: no resolved history was built for delegated leaf ${leaf.sessionId}`);
    }
    childResult = await runExistingSession({ ctx, sessionManager, sessionId: leaf.sessionId, projectRoot, abortController, startTime, prebuiltMessages: appliedLeaf.resumedMessages, ...(debug !== undefined && { debug }), ...(maxSteps !== undefined && { maxSteps }) });
    leafRollback = undefined;
  } catch (error) {
    if (leafRollback && isExistingSessionPreRunError(error)) {
      await restoreResumeToolResult({ sessionManager, rollback: leafRollback }).catch((restoreErr) => {
        logger.warn(`Failed to restore delegated approval after resume setup error: ${(restoreErr as Error).message}`);
      });
    }
    throw error;
  }
  if (childResult.status === 'suspended') {
    return { handled: true, response: cascadeReparkedResponse(reqId, rootSessionId) };
  }

  // 3. Walk up: complete each ancestor's bookmark with the child's output,
  //    resume it, stopping if it re-suspends. The final response reports
  //    whatever the ROOT ended as (see walkUpCascadeChain for the
  //    report_incomplete semantics at each hop).
  const walked = await walkUpCascadeChain({
      ctx,
    sessionManager,
    ancestors: chain.slice(0, -1),
    childSessionId: leaf.sessionId,
    childAgentName: leaf.agentName,
    childResult,
    projectRoot,
    abortController,
    startTime,
    ...(debug !== undefined && { debug }),
    ...(maxSteps !== undefined && { maxSteps }),
  });
  if (walked.suspended) {
    return { handled: true, response: cascadeReparkedResponse(reqId, rootSessionId) };
  }

  const duration = Date.now() - startTime;
  return {
    handled: true,
    response: workerRunResponse(reqId, walked.result, duration, rootSessionId),
  };
}

// Resume is addressed to the manager the user started, but recovery begins at
// the deepest child that failed in a model stream. Rehydrate that same child
// session from its durable transcript, let it finish, then use the normal
// child-to-root walk so every parked subagent__* call receives a real result.
// This deliberately handles only isRecoverableCascadeFailure: a generic
// execution error may have an ambiguous external effect and must not be
// replayed automatically.
export async function retryFailedCascade(opts: {
  ctx: WorkerContext;
  sessionManager: InstanceType<typeof SessionManager>;
  rootSessionId: string;
  projectRoot: string;
  abortController: AbortController;
  startTime: number;
  reqId: string;
  debug?: boolean;
  maxSteps?: number;
}): Promise<any> {
  const { ctx, sessionManager, rootSessionId, projectRoot, abortController, startTime, reqId, debug, maxSteps } = opts;
  const root = await sessionManager.findSession(rootSessionId);
  if (!root) {
    return { id: reqId, success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${rootSessionId}` } };
  }
  const rootDirectory = await sessionManager.getSessionDirectory(rootSessionId, root.agentId);

  // Share the finish-cascade claim because completing an already-finished
  // child and retrying a failed one both mutate the same pending bookmarks.
  return withOwnershipLock(join(rootDirectory, '.finish-cascade-claim'), async () => {
    const currentRoot = await sessionManager.findSession(rootSessionId);
    if (!currentRoot) {
      return { id: reqId, success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${rootSessionId}` } };
    }
    const rootCanRetry = currentRoot.session.status === 'suspended' ||
      (currentRoot.session.status === 'error' &&
        (currentRoot.session.error?.code === CASCADE_RECOVERABLE_CODE || currentRoot.session.error?.code === CASCADE_ORPHANED_CODE));
    if (!rootCanRetry) {
      return { id: reqId, success: false, error: { code: 'SESSION_NOT_RESUMABLE', message: `Session ${rootSessionId} is ${currentRoot.session.status}` } };
    }

    const ancestors: Array<{ sessionId: string; agentId: string; agentName: string }> = [
      { sessionId: rootSessionId, agentId: currentRoot.agentId, agentName: currentRoot.session.agent.name || currentRoot.agentId },
    ];
    let cursorChildId = findPendingSubagentWaitChildId(
      await loadSessionPartsFlat(sessionManager, rootSessionId, currentRoot.agentId)
    );
    let failed: { sessionId: string; agentId: string; agentName: string } | undefined;

    for (let i = 0; i < MAX_CASCADE_DEPTH && cursorChildId; i++) {
      const child = await sessionManager.findSession(cursorChildId);
      if (!child) break;
      if (isRecoverableCascadeFailure(child.session)) {
        failed = {
          sessionId: cursorChildId,
          agentId: child.agentId,
          agentName: child.session.agent.name || child.agentId,
        };
        break;
      }
      const parked = child.session.status === 'suspended' ||
        (child.session.status === 'error' &&
          (child.session.error?.code === CASCADE_RECOVERABLE_CODE || child.session.error?.code === CASCADE_ORPHANED_CODE));
      if (!parked) break;
      const parts = await loadSessionPartsFlat(sessionManager, cursorChildId, child.agentId);
      if (findPendingAwaitHumanPart(parts)) break;
      const nextChildId = findPendingSubagentWaitChildId(parts);
      if (!nextChildId) break;
      ancestors.push({
        sessionId: cursorChildId,
        agentId: child.agentId,
        agentName: child.session.agent.name || child.agentId,
      });
      cursorChildId = nextChildId;
    }

    if (!failed) {
      return {
        id: reqId,
        success: false,
        error: {
          code: 'CASCADE_NOT_RETRYABLE',
          message: `Session ${rootSessionId} is not waiting on a sub-agent interrupted by a recoverable model-stream stall`,
        },
      };
    }

    // Fail before changing any status or bookmark when a level cannot be
    // reloaded. Once the child finishes, every ancestor must be runnable for
    // the result to reach the user-facing root.
    for (const level of [...ancestors, failed]) {
      const found = await sessionManager.findSession(level.sessionId);
      if (!found?.session.agent.filePath) {
        return {
          id: reqId,
          success: false,
          error: { code: 'AGENT_NOT_FOUND', message: `Session ${level.sessionId} does not record an agent file path` },
        };
      }
    }

    await claimCascadeChain(sessionManager, [...ancestors, failed]);
    for (const ancestor of ancestors) {
      await sessionManager.updateSession(ancestor.sessionId, ancestor.agentId, {
        status: 'suspended',
        error: undefined,
      } as any);
    }

    let childResult: Awaited<ReturnType<typeof runAgent>>;
    try {
      childResult = await runExistingSession({
      ctx,
        sessionManager,
        sessionId: failed.sessionId,
        projectRoot,
        abortController,
        startTime,
        continuationPrompt: 'Continue the interrupted task from the existing progress. Do not repeat completed work.',
        ...(debug !== undefined && { debug }),
        ...(maxSteps !== undefined && { maxSteps }),
      });
    } catch (error) {
      // Keep the manager actionable when the retry itself fails. The child
      // run has already persisted its latest terminal error.
      const latest = await sessionManager.findSession(failed.sessionId);
      const stale = latest ? {
        sessionId: failed.sessionId,
        agentName: failed.agentName,
        status: latest.session.status,
        ...(latest.session.error && { error: latest.session.error }),
      } : {
        sessionId: failed.sessionId,
        agentName: failed.agentName,
        status: 'missing',
      };
      await sessionManager.setSessionError(rootSessionId, currentRoot.agentId, {
        code: isRecoverableCascadeFailure(stale) ? CASCADE_RECOVERABLE_CODE : CASCADE_ORPHANED_CODE,
        message: describeStaleCascade(stale),
      }).catch(() => {});
      throw error;
    }

    if (childResult.status === 'suspended') {
      return cascadeReparkedResponse(reqId, rootSessionId);
    }
    const walked = await walkUpCascadeChain({
      ctx,
      sessionManager,
      ancestors,
      childSessionId: failed.sessionId,
      childAgentName: failed.agentName,
      childResult,
      projectRoot,
      abortController,
      startTime,
      ...(debug !== undefined && { debug }),
      ...(maxSteps !== undefined && { maxSteps }),
    });
    if (walked.suspended) {
      return cascadeReparkedResponse(reqId, rootSessionId);
    }
    return workerRunResponse(reqId, walked.result, Date.now() - startTime, rootSessionId);
  }, {
    staleMs: 30_000,
    retryMs: 10,
    maxWaitMs: 35_000,
    label: `retry-cascade:${rootSessionId}`,
  });
}

// Finish a cascade whose driving worker died after the delegated child ended
// but before the ancestors were resumed (issue #199). Everything the walk-up
// needs survived: the child's final text and declared outcome, and each
// ancestor's pending subagent_wait bookmark. Rebuild the child's result from
// storage and run the normal walk-up. Nothing external re-executes — the
// child already did its work — and each ancestor resumes its own remaining
// steps exactly once, same as if the original worker had lived.
//
// Also accepts an ancestor already stamped CASCADE_ORPHANED by an older sweep
// (the pre-recovery behavior): its bookmark is still pending, so the same
// walk-up applies once the stale error is cleared.
export async function finishCascadeFromStorage(opts: {
  ctx: WorkerContext;
  sessionManager: InstanceType<typeof SessionManager>;
  rootSessionId: string;
  projectRoot: string;
  abortController: AbortController;
  startTime: number;
  reqId: string;
  debug?: boolean;
  maxSteps?: number;
}): Promise<any> {
  const { ctx, sessionManager, rootSessionId, projectRoot, abortController, startTime, reqId, debug, maxSteps } = opts;

  const recoverableStrand = (session: SessionInfo): boolean =>
    session.status === 'suspended' ||
    (session.status === 'error' && session.error?.code === CASCADE_ORPHANED_CODE);

  const initialRoot = await sessionManager.findSession(rootSessionId);
  if (!initialRoot) {
    return { id: reqId, success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${rootSessionId}` } };
  }
  const rootDirectory = await sessionManager.getSessionDirectory(rootSessionId, initialRoot.agentId);

  // The recoverable status is only a predicate, not a claim. Two daemons can
  // discover the same stranded root in the same sweep, so serialize the whole
  // read/complete/run transition on a durable lock shared by every process.
  return withOwnershipLock(join(rootDirectory, '.finish-cascade-claim'), async () => {
    const rootFound = await sessionManager.findSession(rootSessionId);
    if (!rootFound) {
      return { id: reqId, success: false, error: { code: 'SESSION_NOT_FOUND', message: `Session not found: ${rootSessionId}` } };
    }
    // Anything else means a live process already resumed it (or it ended):
    // finishing twice is the double-fire this whole path exists to avoid.
    if (!recoverableStrand(rootFound.session)) {
      return { id: reqId, success: false, error: { code: 'SESSION_NOT_SUSPENDED', message: `SESSION_NOT_SUSPENDED: ${rootFound.session.status}` } };
    }

    // Follow pending bookmarks down to the child that ended with a durable
    // result. A live human gate or a still-running descendant means the chain
    // is healthy and there is nothing to finish.
    const chain: Array<{ sessionId: string; agentId: string; agentName: string }> = [
      { sessionId: rootSessionId, agentId: rootFound.agentId, agentName: rootFound.session.agent.name },
    ];
    let cursorChildId = findPendingSubagentWaitChildId(await loadSessionPartsFlat(sessionManager, rootSessionId, rootFound.agentId));
    let ended: { sessionId: string; agentId: string; agentName: string } | undefined;
    for (let i = 0; i < MAX_CASCADE_DEPTH && cursorChildId; i++) {
      const f = await sessionManager.findSession(cursorChildId);
      if (!f) break;
      if (isFinishableStale(f.session)) {
        ended = { sessionId: cursorChildId, agentId: f.agentId, agentName: f.session.agent.name || f.agentId };
        break;
      }
      if (!recoverableStrand(f.session)) break;
      const parts = await loadSessionPartsFlat(sessionManager, cursorChildId, f.agentId);
      if (findPendingAwaitHumanPart(parts)) break;
      const next = findPendingSubagentWaitChildId(parts);
      if (!next) break;
      chain.push({ sessionId: cursorChildId, agentId: f.agentId, agentName: f.session.agent.name || f.agentId });
      cursorChildId = next;
    }
    if (!ended) {
      return { id: reqId, success: false, error: { code: 'CASCADE_NOT_FINISHABLE', message: `Session ${rootSessionId} is not parked on a delegated sub-agent that ended with a durable result` } };
    }

    // This process drives the chain now: stamp liveness, and clear any stale
    // CASCADE_ORPHANED verdict so the resumed levels report a clean run.
    await claimCascadeChain(sessionManager, chain);
    for (const level of chain) {
      const f = await sessionManager.findSession(level.sessionId);
      if (f?.session.error?.code === CASCADE_ORPHANED_CODE) {
        await sessionManager.updateSession(level.sessionId, level.agentId, { status: 'suspended', error: undefined } as any).catch(() => {});
      }
    }

    const stored = await loadStoredSubagentResult(sessionManager, ended.sessionId, ended.agentId);
    const walked = await walkUpCascadeChain({
      ctx,
      sessionManager,
      ancestors: chain,
      childSessionId: ended.sessionId,
      childAgentName: ended.agentName,
      childResult: stored,
      projectRoot,
      abortController,
      startTime,
      ...(debug !== undefined && { debug }),
      ...(maxSteps !== undefined && { maxSteps }),
    });
    if (walked.suspended) {
      return cascadeReparkedResponse(reqId, rootSessionId);
    }
    return workerRunResponse(reqId, walked.result, Date.now() - startTime, rootSessionId);
  }, {
    staleMs: 30_000,
    retryMs: 10,
    maxWaitMs: 35_000,
    label: `finish-cascade:${rootSessionId}`,
  });
}
