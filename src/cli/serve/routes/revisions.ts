import { agentBaseName } from "../../../utils/agent-id.js";
import { failChangeset, latestChangesetProposal, listChangesetRecords, readChangesetRecord, recordChangesetTestRun, reopenChangeset, writeChangesetRecord } from "../../../agents/changeset";
import { restoreChangeset as restoreChangesetFiles } from "../../../agents/changeset-apply";
import { changesetBasePath, changesetEditRoot } from "../../../agents/changeset-types";
import type { ChangesetRecord } from "../../../agents/changeset-types";
import { AgentCreationError, agentCreationProviders } from "../../../agents/create";
import { discoverProjectSkillCatalog, prepareProjectDiscoveryView } from "../../../agents/discover";
import { latestAgentDraft, markAgentDraftDiscarded, markAgentDraftSaved, readAgentDraftRecord, recordAgentDraftTestRun, reopenAgentDraft, settleAgentDraftTestRun } from "../../../agents/draft";
import { internalAgentSourcePath, writeInternalAgentSource } from "../../../agents/internal-agent-file";
import { agentRevisionAgentName, agentRevisionDescription, applyAgentRevision, buildAgentRevisionSessionAgent, buildChangesetRevisionSessionAgent, createAgentRevisionRecord, discardAgentRevision, failAgentRevision, internalAgentRevisionPath, listAgentRevisionRecords, readAgentRevisionRecord, reopenAgentRevision, restoreAgentRevision, sourceHash, writeInternalAgentRevisionSource } from "../../../agents/revision";
import type { AgentRevisionRecord } from "../../../agents/revision";
import { providerSetupSnapshot } from "../../../auth/provider-setup";
import { REASONING_LEVELS } from "../../../model-compatibility";
import type { ReasoningLevel } from "../../../model-compatibility";
import { runInternalJobLifecycle } from "../../../onboarding/internal-job-runner";
import { buildChangesetCreatorSessionAgent } from "../../../onboarding/session-agents";
import { parseAgentContent } from "../../../parser";
import { loadBuiltinSkillSource } from "../../../skill/builtin";
import { stripAgentExtension } from "../../../utils/agent-id.js";
import { toErrorMessage } from "../../../utils/error-message.js";
import { logger } from "../../../utils/logger";
import { isPathInside } from "../../../utils/path-policy";
import { sessionViewToken } from "../../../utils/session-token";
import { agentSummaryCache, collectAgentDetail, collectAgents } from "../agents-data";
import { sessionAgentRevisionAllowed } from "../auth";
import { CHANGESET_ID_PATTERN, ChangesetActiveError, ChangesetTargetError, applyProjectChangeset, changesetAcceptsChangeRequest, changesetListSummary, changesetReviewHref, discardProjectChangeset, prepareChangesetStart, removeChangesetWorkspace, resolveChangesetTargetPath, settleChangesetSession } from "../changesets";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { OnboardingModelJob } from "../internal-jobs";
import { resolveScopedAgentPath } from "../project";
import type { Project } from "../project";
import { CHANGESET_CREATE_MAX_STEPS, CHANGESET_CREATE_TIMEOUT_SECONDS, CHANGESET_REVISE_MAX_STEPS, CHANGESET_REVISE_TIMEOUT_SECONDS, revisionProposalTag, revisionRequestTag } from "../revision-limits";
import { buildRunTranscript } from "../session-lists";
import { WorkerApprovalInfoResult } from "../session-types";
import { existsSync } from "fs";
import { lstat, readFile, realpath } from "fs/promises";
import { ServerResponse } from "http";
import { relative } from "path";
import { ulid } from "ulid";
import type { ServeContext, ServeRequest } from "../context";

/**
 * Agent revisions and change sets: starting a revision or change-set session,
 * listing and acting on the resulting drafts, proposals and revisions.
 */
export async function revisionRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath, sessionAuthorized } = rq;
  const {
    options,
    apiKey,
    effectiveHideAgentSource,
    projects,
    projectsById,
    agentCounts,
    updateRegistryCounts,
    workers,
    wakeListHubs,
    findSessionInfo,
    activeApprovalResumes,
    activeSessionContinuations,
    startSessionContinue,
    onboardingJobs,
    internalViewCleanups,
    revisionMutations,
    draftMutations,
    changesetMutations,
    preferredAgentCreationModel,
    cleanupInternalView,
    persistOnboardingJob,
    beginInternalAgentJob,
    resolveAgentCreationRecovery,
    finishAgentCreation,
    draftViewPayload,
    reconcileAgentDraftRecord,
    reconcileAgentRevisionRecord,
    startMockTestRun,
    startChangesetTestRun,
    settleStaleChangesetTestRuns,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    const originRevisionsMatch = !isApi && req.method === 'GET'
      ? routePath.match(/^\/sessions\/([^/?#]+)\/revisions$/)
      : null;
    if (originRevisionsMatch) {
      try {
        const originSessionId = decodeURIComponent(originRevisionsMatch[1]!);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const projectId = requestUrl.searchParams.get('project') ?? undefined;
        if (!sessionAuthorized(originSessionId, token)) {
          sendError(res, 401, 'UNAUTHORIZED', 'Not authorized for this session');
          return;
        }
        const found = await findSessionInfo(originSessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const revisions = await Promise.all(
          (await listAgentRevisionRecords(found.project.root, originSessionId))
            .map((revision) => reconcileAgentRevisionRecord(found.project, revision))
        );
        sendJSON(res, 200, {
          success: true,
          revisions: revisions.map(({ proposedSource: _proposed, previousSource: _previous, ...record }) => {
            const params = new URLSearchParams({ project: found.project.id });
            const revisionToken = sessionViewToken(record.revisionSessionId, apiKey);
            if (revisionToken) params.set('token', revisionToken);
            return {
              ...record,
              href: `/sessions/${encodeURIComponent(record.revisionSessionId)}?${params.toString()}`,
            };
          }),
        });
      } catch (err) {
        sendError(res, 400, 'REVISION_LIST_FAILED', toErrorMessage(err));
      }
      return;
    }

    /**
     * Start a create or revise change set. Mirrors the agent-creation and
     * revision starts: validate, write the durable record and the staged
     * workspace, then hand the generated session agent to the same durable
     * preparing shell. The session agent is persisted like the reviser's so
     * request-changes can continue it.
     */
    const startChangeset = async (
      res: ServerResponse,
      project: Project,
      body: Record<string, unknown>,
    ): Promise<void> => {
      const mode = body.mode;
      if (mode !== 'create' && mode !== 'revise') {
        sendError(res, 400, 'CHANGESET_MODE_INVALID', 'A change set is either a create or a revise');
        return;
      }
      const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
      if (!instruction || instruction.length > 12_000) {
        sendError(res, 400, 'CHANGESET_INSTRUCTION_REQUIRED', 'Describe what this change should do');
        return;
      }
      const worker = workers.get(project.id);
      if (!worker) {
        sendError(res, 500, 'WORKER_UNAVAILABLE', `No worker for project ${project.id}`);
        return;
      }
      const snapshot = await providerSetupSnapshot();
      const providers = await agentCreationProviders(snapshot.status, preferredAgentCreationModel);
      const availableModels = [...new Set(providers.flatMap((provider) => provider.models))];
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model || !availableModels.includes(model)) {
        sendError(res, 400, 'CHANGESET_MODEL_INVALID', 'Choose a configured authoring model');
        return;
      }
      let reasoning: ReasoningLevel | undefined;
      if (body.reasoning !== undefined) {
        if (typeof body.reasoning !== 'string' || !(REASONING_LEVELS as readonly string[]).includes(body.reasoning)) {
          sendError(res, 400, 'CHANGESET_REASONING_INVALID', 'Choose a valid thinking effort');
          return;
        }
        reasoning = body.reasoning as ReasoningLevel;
      }
      const originSessionId = typeof body.originSessionId === 'string' && body.originSessionId.trim()
        ? body.originSessionId.trim()
        : undefined;

      // Revise: resolve the target inside the served scope before anything
      // durable is written, so a bad path never leaves a record behind.
      let target: { path: string; name: string } | undefined;
      let currentSource: string | undefined;
      if (mode === 'revise') {
        const requested = typeof body.target === 'string' ? body.target.trim() : '';
        if (!requested) {
          sendError(res, 400, 'CHANGESET_TARGET_REQUIRED', 'Choose the agent this change set revises');
          return;
        }
        let requestedPath: string;
        try {
          requestedPath = await resolveChangesetTargetPath(project.scopeRoot, requested);
        } catch (error) {
          if (!(error instanceof ChangesetTargetError)) throw error;
          sendError(res, 400, 'INVALID_AGENT_PATH', error.message);
          return;
        }
        currentSource = await readFile(resolveScopedAgentPath(project, requestedPath), 'utf8');
        target = {
          path: requestedPath,
          name: parseAgentContent(currentSource, agentBaseName(requestedPath)).name,
        };
      }

      // A run-anchored revision carries that run's transcript as evidence.
      // Resolve it before anything durable is written: an origin the daemon
      // cannot read is a request error, not a revision that quietly works
      // from the source alone.
      let originTranscript: string | undefined;
      if (originSessionId) {
        const origin = await findSessionInfo(originSessionId, project.id);
        if (!origin.success) {
          sendError(res, origin.status, origin.code, origin.message);
          return;
        }
        originTranscript = buildRunTranscript(origin.info.approval.logs, 80_000, {
          focus: 'latest-attempt',
          terminal: {
            status: origin.info.approval.sessionStatus,
            ...(origin.info.approval.errorCode && { errorCode: origin.info.approval.errorCode }),
            ...(origin.info.approval.errorMessage && { errorMessage: origin.info.approval.errorMessage }),
          },
        });
      }

      const sessionId = ulid();
      const record = await prepareChangesetStart({
        sessionId,
        projectId: project.id,
        projectRoot: project.root,
        scopeRoot: project.scopeRoot,
        mode,
        instruction,
        authoringModel: model,
        ...(target && { target }),
        ...(originSessionId && { originSessionId }),
      });

      const timeout = mode === 'create' ? CHANGESET_CREATE_TIMEOUT_SECONDS : CHANGESET_REVISE_TIMEOUT_SECONDS;
      const maxSteps = mode === 'create' ? CHANGESET_CREATE_MAX_STEPS : CHANGESET_REVISE_MAX_STEPS;
      const agentName = mode === 'create' ? 'internal-agent-creator' : agentRevisionAgentName(target!.name);
      const agentDescription = mode === 'create'
        ? 'Turn a user brief into a production AgentUse agent'
        : agentRevisionDescription(target!.name, originSessionId);
      const job: OnboardingModelJob = {
        id: sessionId,
        sessionId,
        projectId: project.id,
        kind: 'changeset',
        status: 'running',
        phase: 'preparing',
        model,
        createdAt: record.createdAt,
      };
      const prepared = await beginInternalAgentJob({
        job,
        worker,
        project,
        agentId: stripAgentExtension(
          relative(project.root, internalAgentSourcePath(project.root, 'changeset', sessionId)),
        ),
        agentName,
        agentDescription,
        trigger: 'manual',
        timeout,
        maxSteps,
      });
      if (!prepared.success) {
        await failChangeset(project.root, sessionId, prepared.error).catch(() => undefined);
        throw new Error(prepared.error.message);
      }
      const sessionToken = apiKey ? sessionViewToken(sessionId, apiKey) : undefined;
      sendJSON(res, 202, { success: true, changeset: record, ...(sessionToken && { sessionToken }) });
      wakeListHubs();

      void runInternalJobLifecycle({
        job,
        prepare: async () => {
          const [creatorSkill, availableSkills, collected] = await Promise.all([
            loadBuiltinSkillSource('creator'),
            discoverProjectSkillCatalog(project.root),
            collectAgents([project]),
          ]);
          // The dashboard's own agent list, so the model sees exactly the
          // layout the operator sees and can reference it by path.
          const existingAgents = collected.agents.map((agent) => ({
            path: agent.runPath,
            name: agent.name,
            description: agent.description ?? '',
          }));
          const agentContent = mode === 'create'
            ? buildChangesetCreatorSessionAgent({
                model,
                ...(reasoning && { reasoning }),
                sessionId,
                projectId: project.id,
                projectRoot: project.root,
                scopeRoot: project.scopeRoot,
                editRoot: changesetEditRoot(project.root, sessionId),
                basePath: changesetBasePath(project.root, sessionId),
                creatorSkill,
                objective: instruction,
                availableModels,
                availableSkills,
                existingAgents,
              })
            : buildChangesetRevisionSessionAgent({
                sessionId,
                ...(originSessionId && { originSessionId }),
                ...(originTranscript && { originTranscript }),
                projectId: project.id,
                projectRoot: project.root,
                scopeRoot: project.scopeRoot,
                editRoot: changesetEditRoot(project.root, sessionId),
                basePath: changesetBasePath(project.root, sessionId),
                targetRunPath: target!.path,
                targetAgentName: target!.name,
                instruction,
                model,
                ...(reasoning && { reasoning }),
                currentSource: currentSource!,
                creatorSkill,
                availableModels,
                availableSkills,
                existingAgents,
              });
          return writeInternalAgentSource(project.root, 'changeset', sessionId, agentContent);
        },
        execute: (internalAgentPath) => worker.execute({
          agentPath: internalAgentPath,
          projectRoot: project.root,
          newSessionId: sessionId,
          preparedSession: true,
          trigger: 'manual',
          timeout,
          maxSteps,
          debug: options.debug,
        }),
        consume: async (execution) => {
          const latest = await readChangesetRecord(project.root, sessionId);
          if (execution.success && (latest?.status === 'proposed' || latest?.status === 'no-change')) {
            job.status = 'completed';
            job.result = { kind: 'changeset', sessionId, projectId: project.id };
            return;
          }
          const failure = await settleChangesetSession(project.root, sessionId, execution);
          if (failure) {
            job.status = 'error';
            job.error = failure;
          }
        },
        mapError: (error) => ({ code: 'CHANGESET_FAILED', message: toErrorMessage(error) }),
        persist: () => persistOnboardingJob(job),
        wake: wakeListHubs,
        failPreparing: (failure) => worker.failPreparingSession({
          projectRoot: project.root,
          sessionId,
          code: failure.code,
          message: failure.message,
        }).then(() => undefined),
        onError: (failure) => failChangeset(project.root, sessionId, failure).then(() => undefined),
        onPersistenceError: (error) => logger.warn(`Failed to persist internal agent job ${job.id}: ${toErrorMessage(error)}`),
      });
    };

    // Shared by the two start routes below. A run-anchored revision
    // carries the origin session and its transcript as evidence; an
    // agent-anchored one (the agent page, for an agent with no finished
    // run) works from the current source alone. Everything after the
    // target is resolved lives here so the two routes cannot drift.
    const startAgentRevisionSession = async (input: {
      project: Project;
      body: Record<string, unknown>;
      targetAgentPath: string;
      targetAgentName: string;
      targetAgentRunPath?: string | undefined;
      origin?: { sessionId: string; info: WorkerApprovalInfoResult } | undefined;
      mutationKey: string;
      // Which existing records block a new start: the same run, or the same agent file.
      conflictsWith: (record: AgentRevisionRecord) => boolean;
    }): Promise<void> => {
      const { project, body, targetAgentPath, targetAgentName, origin } = input;
      const originSessionId = origin?.sessionId;
      if (revisionMutations.has(input.mutationKey)) {
        sendError(res, 409, 'REVISION_STARTING', 'A revision is already being started for this target');
        return;
      }
      revisionMutations.add(input.mutationKey);
      try {
        const existingRevisions = await Promise.all(
          (await listAgentRevisionRecords(project.root, originSessionId))
            .filter(input.conflictsWith)
            .map((revision) => reconcileAgentRevisionRecord(project, revision))
        );
        const activeRevision = existingRevisions.find((revision) =>
          revision.status === 'running' || revision.status === 'proposed' || revision.status === 'no-change');
        if (activeRevision) {
          const params = new URLSearchParams({ project: project.id });
          const activeToken = sessionViewToken(activeRevision.revisionSessionId, apiKey);
          if (activeToken) params.set('token', activeToken);
          sendJSON(res, 409, {
            success: false,
            error: {
              code: 'REVISION_ALREADY_ACTIVE',
              message: originSessionId
                ? 'This session already has a revision waiting for completion or review'
                : 'This agent already has a revision waiting for completion or review',
              revisionSessionId: activeRevision.revisionSessionId,
              href: `/sessions/${encodeURIComponent(activeRevision.revisionSessionId)}?${params.toString()}`,
            },
          });
          return;
        }
        const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
        if (!instruction || instruction.length > 12_000) {
          sendError(res, 400, 'REVISION_INSTRUCTION_REQUIRED', 'Describe what the revision should focus on');
          return;
        }
        if (!isPathInside(project.scopeRoot, targetAgentPath) || !existsSync(targetAgentPath)) {
          sendError(res, 400, 'INVALID_AGENT_PATH', 'The agent is outside the served project scope');
          return;
        }
        const [targetStat, realScope, realTarget] = await Promise.all([
          lstat(targetAgentPath),
          realpath(project.scopeRoot),
          realpath(targetAgentPath),
        ]);
        if (!targetStat.isFile() || targetStat.isSymbolicLink() || !isPathInside(realScope, realTarget)) {
          sendError(res, 400, 'INVALID_AGENT_PATH', 'The agent must be a regular file inside the served project scope');
          return;
        }
        const worker = workers.get(project.id);
        if (!worker) {
          sendError(res, 500, 'WORKER_UNAVAILABLE', `No worker for project ${project.id}`);
          return;
        }
        const snapshot = await providerSetupSnapshot();
        const providers = await agentCreationProviders(snapshot.status, preferredAgentCreationModel);
        const availableModels = [...new Set(providers.flatMap((provider) => provider.models))];
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!model || !availableModels.includes(model)) {
          sendError(res, 400, 'REVISION_MODEL_INVALID', 'Choose a configured authoring model');
          return;
        }
        let reasoning: ReasoningLevel | undefined;
        if (body.reasoning !== undefined) {
          if (typeof body.reasoning !== 'string' || !(REASONING_LEVELS as readonly string[]).includes(body.reasoning)) {
            sendError(res, 400, 'REVISION_REASONING_INVALID', 'Choose a valid thinking effort');
            return;
          }
          reasoning = body.reasoning as ReasoningLevel;
        }
        const revisionSessionId = ulid();
        const currentSource = await readFile(targetAgentPath, 'utf8');
        const expectedSourceHash = sourceHash(currentSource);
        const record = await createAgentRevisionRecord({
          revisionSessionId,
          ...(originSessionId && { originSessionId }),
          projectId: project.id,
          projectRoot: project.root,
          targetAgentPath,
          ...(input.targetAgentRunPath && { targetAgentRunPath: input.targetAgentRunPath }),
          targetAgentName,
          instruction,
          authoringModel: model,
          expectedSourceHash,
          previousSource: currentSource,
        });
        const job: OnboardingModelJob = {
          id: revisionSessionId,
          sessionId: revisionSessionId,
          projectId: project.id,
          kind: 'agent-revision',
          status: 'running',
          phase: 'preparing',
          model,
          createdAt: record.createdAt,
        };
        const prepared = await beginInternalAgentJob({
          job,
          worker,
          project,
          agentId: stripAgentExtension(relative(project.root, internalAgentRevisionPath(project.root, revisionSessionId))),
          agentName: `Revise ${targetAgentName}`,
          agentDescription: agentRevisionDescription(targetAgentName, originSessionId),
          trigger: 'manual',
          timeout: 480,
          maxSteps: 20,
        });
        if (!prepared.success) {
          await failAgentRevision(project.root, revisionSessionId, prepared.error).catch(() => undefined);
          throw new Error(prepared.error.message);
        }
        const sessionToken = apiKey ? sessionViewToken(revisionSessionId, apiKey) : undefined;
        sendJSON(res, 202, { success: true, job: { ...job, ...(sessionToken && { sessionToken }) } });
        wakeListHubs();

        let cleanupView: (() => Promise<void>) | undefined;
        void runInternalJobLifecycle({
          job,
          prepare: async () => {
            const viewPromise = prepareProjectDiscoveryView(project.scopeRoot).then((view) => {
              cleanupView = view.cleanup;
              return view;
            });
            const [creatorSkill, availableSkills, view] = await Promise.all([
              loadBuiltinSkillSource('creator'),
              discoverProjectSkillCatalog(project.root),
              viewPromise,
            ]);
            const agentContent = buildAgentRevisionSessionAgent({
              revisionSessionId,
              ...(originSessionId && { originSessionId }),
              projectId: project.id,
              projectRoot: project.root,
              targetAgentPath,
              targetAgentName,
              instruction,
              model,
              ...(reasoning && { reasoning }),
              expectedSourceHash,
              currentSource,
              ...(origin && {
                originTranscript: buildRunTranscript(origin.info.approval.logs, 80_000, {
                  focus: 'latest-attempt',
                  terminal: {
                    status: origin.info.approval.sessionStatus,
                    ...(origin.info.approval.errorCode && { errorCode: origin.info.approval.errorCode }),
                    ...(origin.info.approval.errorMessage && { errorMessage: origin.info.approval.errorMessage }),
                  },
                }),
              }),
              safeViewRoot: view.root,
              creatorSkill,
              availableModels,
              availableSkills,
            });
            const internalAgentPath = await writeInternalAgentRevisionSource(
              project.root,
              revisionSessionId,
              agentContent,
            );
            const finishRevisionView = cleanupView;
            if (finishRevisionView) {
              internalViewCleanups.set(revisionSessionId, finishRevisionView);
              cleanupView = undefined;
            }
            return internalAgentPath;
          },
          execute: (internalAgentPath) => worker.execute({
              agentPath: internalAgentPath,
              projectRoot: project.root,
              newSessionId: revisionSessionId,
              preparedSession: true,
              trigger: 'manual',
              timeout: 480,
              maxSteps: 20,
              debug: options.debug,
            }),
          consume: async (execution) => {
            if (!execution.success) {
              job.status = 'error';
              job.error = execution.error;
              await failAgentRevision(project.root, revisionSessionId, execution.error);
              return;
            }
            const latest = await readAgentRevisionRecord(project.root, revisionSessionId);
            if (latest?.status === 'proposed' || latest?.status === 'no-change' || latest?.status === 'accepted') {
              job.status = 'completed';
              job.result = latest;
              return;
            }
            if (execution.result.finishReason === 'suspended' || execution.result.approvalUrl) {
              return;
            }
            const error = { code: 'REVISION_NOT_SUBMITTED', message: 'The revision session ended without submitting a validated outcome' };
            job.status = 'error';
            job.error = error;
            await failAgentRevision(project.root, revisionSessionId, error);
          },
          mapError: (error) => ({ code: 'REVISION_FAILED', message: toErrorMessage(error) }),
          persist: () => persistOnboardingJob(job),
          wake: wakeListHubs,
          failPreparing: (failure) => worker.failPreparingSession({
            projectRoot: project.root,
            sessionId: revisionSessionId,
            code: failure.code,
            message: failure.message,
          }).then(() => undefined),
          onError: (failure) => failAgentRevision(project.root, revisionSessionId, failure).then(() => undefined),
          cleanup: async () => {
            await cleanupView?.().catch(() => undefined);
            const latest = await readAgentRevisionRecord(project.root, revisionSessionId).catch(() => undefined);
            if (latest && (latest.status === 'accepted' || latest.status === 'applied' || latest.status === 'discarded' || latest.status === 'restored' || latest.status === 'error')) {
              await cleanupInternalView(revisionSessionId);
            }
          },
          onPersistenceError: (error) => logger.warn(`Failed to persist internal agent job ${job.id}: ${toErrorMessage(error)}`),
        });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, 'REVISION_START_FAILED', toErrorMessage(err));
      } finally {
        revisionMutations.delete(input.mutationKey);
      }
    };

    // POST /sessions/:id/revisions: revise the agent behind a finished (or
    // gated) run, with that run's transcript as evidence.
    const startRevisionMatch = !isApi && req.method === 'POST'
      ? routePath.match(/^\/sessions\/([^/?#]+)\/revisions$/)
      : null;
    if (startRevisionMatch) {
      try {
        if (!sessionAgentRevisionAllowed(req.headers.authorization, apiKey)) {
          sendError(res, 403, 'OPERATOR_REQUIRED', 'Only an authenticated operator can start an agent revision');
          return;
        }
        if (effectiveHideAgentSource) {
          sendError(res, 403, 'AGENT_SOURCE_HIDDEN', 'Agent revision is unavailable while serve.hideAgentSource is enabled');
          return;
        }
        const originSessionId = decodeURIComponent(startRevisionMatch[1]!);
        const body = await parseJSONBody(req);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
        const found = await findSessionInfo(originSessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const targetAgent = found.info.approval.originAgent ?? found.info.approval.agent;
        if (!targetAgent.filePath) {
          sendError(res, 400, 'NO_AGENT_FILE', 'This session does not record an editable agent file');
          return;
        }
        const targetAgentPath = targetAgent.filePath;
        await startAgentRevisionSession({
          project: found.project,
          body,
          targetAgentPath,
          targetAgentName: targetAgent.name || found.info.approval.agent.name,
          targetAgentRunPath: found.info.approval.agent.runPath && targetAgentPath === found.info.approval.agent.filePath
            ? found.info.approval.agent.runPath
            : undefined,
          origin: { sessionId: originSessionId, info: found.info },
          mutationKey: `origin:${found.project.id}:${originSessionId}`,
          conflictsWith: (record) => record.originSessionId === originSessionId,
        });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, 'REVISION_START_FAILED', toErrorMessage(err));
      }
      return;
    }

    // POST /api/agents/revisions {project, path, instruction, model,
    // reasoning?}: revise an agent from its current source. The agent page
    // uses this when the agent has no finished run to anchor a revision on,
    // so "Revise Agent" always reaches the reviser instead of falling back
    // to a copied prompt.
    if (isApi && req.method === 'POST' && routePath === '/agents/revisions') {
      try {
        if (!sessionAgentRevisionAllowed(req.headers.authorization, apiKey)) {
          sendError(res, 403, 'OPERATOR_REQUIRED', 'Only an authenticated operator can start an agent revision');
          return;
        }
        if (effectiveHideAgentSource) {
          sendError(res, 403, 'AGENT_SOURCE_HIDDEN', 'Agent revision is unavailable while serve.hideAgentSource is enabled');
          return;
        }
        const body = await parseJSONBody(req);
        const requestedProject = typeof body.project === 'string' ? body.project : undefined;
        const requestedPath = typeof body.path === 'string' ? body.path : undefined;
        if (!requestedProject || !requestedPath) {
          sendError(res, 400, 'MISSING_PARAMS', 'Both project and path are required');
          return;
        }
        const project = projects.find((p) => p.id === requestedProject);
        if (!project || !project.agentFiles.includes(requestedPath)) {
          sendError(res, 404, 'AGENT_NOT_FOUND', `Agent not loaded: ${requestedPath}`);
          return;
        }
        const targetAgentPath = resolveScopedAgentPath(project, requestedPath);
        const detail = await collectAgentDetail(project, requestedPath);
        await startAgentRevisionSession({
          project,
          body,
          targetAgentPath,
          targetAgentName: detail.name,
          targetAgentRunPath: requestedPath,
          mutationKey: `agent:${project.id}:${requestedPath}`,
          conflictsWith: (record) => record.targetAgentRunPath === requestedPath || record.targetAgentPath === targetAgentPath,
        });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, 'REVISION_START_FAILED', toErrorMessage(err));
      }
      return;
    }

    /* ── Change sets ───────────────────────────────────────────────────
       The multi-file successor to the draft and revision routes below.
       One family covers create and revise: start, read, list, and the six
       review actions. The draft and revision routes stay live until the
       dashboard has finished moving over. */
    const changesetMatch = isApi
      ? routePath.match(/^\/projects\/([^/?#]+)\/changesets(?:\/([^/?#]+))?(?:\/(apply|discard|restore|request-changes|cancel|test-run))?$/)
      : null;
    if (changesetMatch) {
      let mutationKey: string | undefined;
      try {
        const projectId = decodeURIComponent(changesetMatch[1]!);
        const sessionId = changesetMatch[2] ? decodeURIComponent(changesetMatch[2]) : undefined;
        const action = changesetMatch[3];
        const project = projectsById.get(projectId);
        if (!project) {
          sendError(res, 404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
          return;
        }
        if (effectiveHideAgentSource) {
          sendError(res, 403, 'AGENT_SOURCE_HIDDEN', 'Change sets are unavailable while serve.hideAgentSource is enabled');
          return;
        }
        if (sessionId !== undefined && !CHANGESET_ID_PATTERN.test(sessionId)) {
          sendError(res, 404, 'CHANGESET_NOT_FOUND', 'Change set not found');
          return;
        }

        if (req.method === 'GET' && !sessionId) {
          const target = requestUrl.searchParams.get('target')?.trim();
          const records = await listChangesetRecords(
            project.root,
            target ? { targetPath: target } : {},
          );
          sendJSON(res, 200, { success: true, changesets: records.map(changesetListSummary) });
          return;
        }

        if (req.method === 'POST' && !sessionId) {
          if (!sessionAgentRevisionAllowed(req.headers.authorization, apiKey)) {
            sendError(res, 403, 'OPERATOR_REQUIRED', 'Only an authenticated operator can start a change set');
            return;
          }
          await startChangeset(res, project, await parseJSONBody(req));
          return;
        }

        if (!sessionId) {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Unsupported change set action');
          return;
        }

        if (req.method === 'GET' && !action) {
          const token = requestUrl.searchParams.get('token') ?? undefined;
          if (!sessionAuthorized(sessionId, token)) {
            sendError(res, 401, 'UNAUTHORIZED', 'Not authorized for this change set session');
            return;
          }
          const stored = await readChangesetRecord(project.root, sessionId);
          if (!stored) {
            sendError(res, 404, 'CHANGESET_NOT_FOUND', 'Change set not found');
            return;
          }
          const record = await settleStaleChangesetTestRuns(project, stored);
          const sessionToken = sessionViewToken(sessionId, apiKey);
          sendJSON(res, 200, {
            success: true,
            changeset: record,
            ...(sessionToken && { sessionToken }),
          });
          return;
        }

        if (req.method !== 'POST' || !action) {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Unsupported change set action');
          return;
        }
        if (!sessionAgentRevisionAllowed(req.headers.authorization, apiKey)) {
          sendError(res, 403, 'OPERATOR_REQUIRED', 'Only an authenticated operator can change agent source');
          return;
        }
        // Same ownership rule as the draft and revision locks: only set
        // once this request owns the lock, so a rejected caller cannot free
        // the running action's lock on its way out.
        const changesetKey = `changeset:${project.id}:${sessionId}`;
        if (changesetMutations.has(changesetKey)) {
          sendError(res, 409, 'CHANGESET_ACTION_IN_PROGRESS', 'Another action is already changing this change set');
          return;
        }
        changesetMutations.add(changesetKey);
        mutationKey = changesetKey;

        if (action === 'request-changes') {
          const body = await parseJSONBody(req);
          const request = typeof body.request === 'string' ? body.request.trim() : '';
          if (!request || request.length > 12_000) {
            sendError(res, 400, 'CHANGESET_FEEDBACK_REQUIRED', 'Describe the change you want to this proposal');
            return;
          }
          const record = await readChangesetRecord(project.root, sessionId);
          if (!record) {
            sendError(res, 404, 'CHANGESET_NOT_FOUND', 'Change set not found');
            return;
          }
          if (!changesetAcceptsChangeRequest(record.status)) {
            sendError(res, 409, 'CHANGESET_NOT_PROPOSED', 'This change set is not waiting for a change request');
            return;
          }
          const activeKey = `${project.id}:${sessionId}`;
          if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
            sendError(res, 409, 'SESSION_ACTIVE', 'This change set session is already continuing');
            return;
          }
          await reopenChangeset(project.root, sessionId, request);
          const job = onboardingJobs.get(sessionId);
          if (job?.kind === 'changeset') {
            job.status = 'running';
            delete job.error;
            delete job.result;
            await persistOnboardingJob(job);
          }
          // The staged files are still exactly as the model left them, so
          // the reopened turn edits them in place rather than being handed
          // a copy of its own proposal.
          startSessionContinue(res, {
            project,
            sessionId,
            prompt: [
              '[runtime] The operator reviewed your previous change set and asked for a change to it.',
              'The files you wrote are still staged exactly as you left them. Read and edit them at their project paths.',
              '',
              revisionRequestTag(request),
              '',
              'Call submit_changes again once the files answer the request.',
            ].join('\n'),
          });
          return;
        }

        if (action === 'cancel') {
          const record = await readChangesetRecord(project.root, sessionId);
          if (!record || record.status !== 'running') {
            sendError(res, 409, 'CHANGESET_NOT_RUNNING', 'This change set is no longer running');
            return;
          }
          const worker = workers.get(project.id);
          if (worker) {
            await worker.stopSession({
              projectRoot: project.root,
              sessionId,
              reason: 'Change set cancelled by operator',
            }).catch(() => undefined);
          }
          const cancelled: ChangesetRecord = { ...record, status: 'discarded' };
          await writeChangesetRecord(cancelled);
          await removeChangesetWorkspace(project.root, sessionId).catch(() => undefined);
          const job = onboardingJobs.get(sessionId);
          if (job?.kind === 'changeset') {
            job.status = 'error';
            job.error = { code: 'CHANGESET_CANCELLED', message: 'The change set was cancelled by the operator' };
            await persistOnboardingJob(job);
          }
          wakeListHubs();
          sendJSON(res, 200, { success: true, changeset: cancelled });
          return;
        }

        if (action === 'test-run') {
          const stored = await readChangesetRecord(project.root, sessionId);
          const record = stored ? await settleStaleChangesetTestRuns(project, stored) : undefined;
          const proposal = record ? latestChangesetProposal(record) : undefined;
          if (!record || !proposal || proposal.files.length === 0 || !proposal.entry) {
            sendError(res, 409, 'CHANGESET_NOT_PROPOSED', 'There are no proposed files to test yet');
            return;
          }
          // A second mount would rebuild the shadow root under a live run.
          if (record.testRuns.some((run) => run.status === 'running')) {
            sendError(res, 409, 'CHANGESET_TEST_RUN_ACTIVE', 'A test run of this change set is already in flight');
            return;
          }
          const started = await startChangesetTestRun(project, record, proposal);
          await recordChangesetTestRun(project.root, sessionId, {
            sessionId: started.sessionId,
            proposalIndex: proposal.index,
            startedAt: Date.now(),
            status: 'running',
          });
          sendJSON(res, 202, { success: true, testRun: started });
          return;
        }

        if (action === 'restore') {
          const result = await restoreChangesetFiles({
            projectRoot: project.root,
            scopeRoot: project.scopeRoot,
            sessionId,
          });
          for (const file of result.record.applied?.files ?? []) {
            agentSummaryCache.delete(resolveScopedAgentPath(project, file.path));
          }
          wakeListHubs();
          sendJSON(res, 200, { success: true, changeset: result.record, skipped: result.skipped });
          return;
        }

        if (action === 'discard') {
          const discarded = await discardProjectChangeset(project.root, sessionId);
          wakeListHubs();
          sendJSON(res, 200, { success: true, changeset: discarded });
          return;
        }

        // apply
        const snapshot = await providerSetupSnapshot();
        const availableModels = [...new Set(
          (await agentCreationProviders(snapshot.status, preferredAgentCreationModel))
            .flatMap((provider) => provider.models),
        )];
        const availableSkills = (await discoverProjectSkillCatalog(project.root))
          .filter((skill) => !skill.ambiguous)
          .map((skill) => skill.name);
        const applied = await applyProjectChangeset({
          projectRoot: project.root,
          scopeRoot: project.scopeRoot,
          sessionId,
          availableModels,
          availableSkills,
        });
        let addedAgent = false;
        for (const file of applied.applied?.files ?? []) {
          agentSummaryCache.delete(resolveScopedAgentPath(project, file.path));
          if (!file.path.toLowerCase().endsWith('.agentuse')) continue;
          if (project.agentFiles.includes(file.path)) continue;
          project.agentFiles.push(file.path);
          addedAgent = true;
        }
        if (addedAgent) {
          project.agentFiles.sort();
          agentCounts.set(project.id, project.agentFiles.length);
          updateRegistryCounts();
        }
        wakeListHubs();
        sendJSON(res, 200, { success: true, changeset: applied });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        if (err instanceof ChangesetActiveError) {
          sendJSON(res, 409, {
            success: false,
            error: {
              code: 'CHANGESET_ALREADY_ACTIVE',
              message: err.message,
              sessionId: err.sessionId,
              href: changesetReviewHref(decodeURIComponent(changesetMatch[1]!), err.sessionId),
            },
          });
          return;
        }
        sendError(res, 400, 'CHANGESET_ACTION_FAILED', toErrorMessage(err));
      } finally {
        if (mutationKey) changesetMutations.delete(mutationKey);
      }
      return;
    }

    const draftActionMatch = isApi
      ? routePath.match(/^\/agents\/drafts\/([^/?#]+)(?:\/(save|discard|request-changes|test-run))?$/)
      : null;
    if (draftActionMatch) {
      let mutationKey: string | undefined;
      try {
        const jobId = decodeURIComponent(draftActionMatch[1]!);
        const action = draftActionMatch[2];
        const projectId = requestUrl.searchParams.get('project') ?? undefined;
        const project = projectId ? projectsById.get(projectId) : projects.length === 1 ? projects[0] : undefined;
        if (!project) {
          sendError(res, 400, 'PROJECT_REQUIRED', 'Choose the project that owns this draft');
          return;
        }
        if (effectiveHideAgentSource) {
          sendError(res, 403, 'AGENT_SOURCE_HIDDEN', 'Agent drafts are unavailable while serve.hideAgentSource is enabled');
          return;
        }
        const stored = await readAgentDraftRecord(project.root, jobId);
        if (!stored) {
          sendError(res, 404, 'DRAFT_NOT_FOUND', 'Draft not found');
          return;
        }
        const record = await reconcileAgentDraftRecord(project, stored);

        if (req.method === 'GET' && !action) {
          sendJSON(res, 200, { success: true, draft: draftViewPayload(project, record) });
          return;
        }
        if (req.method !== 'POST' || !action) {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Unsupported draft action');
          return;
        }
        if (!sessionAgentRevisionAllowed(req.headers.authorization, apiKey)) {
          sendError(res, 403, 'OPERATOR_REQUIRED', 'Only an authenticated operator can change agent source');
          return;
        }
        // mutationKey is what `finally` releases, so it is only set once
        // this request owns the lock. Setting it before the check let a
        // rejected caller free the running action's lock on its way out.
        const draftKey = `draft:${project.id}:${jobId}`;
        if (draftMutations.has(draftKey)) {
          sendError(res, 409, 'DRAFT_ACTION_IN_PROGRESS', 'Another action is already changing this draft');
          return;
        }
        draftMutations.add(draftKey);
        mutationKey = draftKey;

        if (action === 'request-changes') {
          const body = await parseJSONBody(req);
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt || prompt.length > 12_000) {
            sendError(res, 400, 'DRAFT_FEEDBACK_REQUIRED', 'Describe the change you want to this draft');
            return;
          }
          if (record.status === 'saved' || record.status === 'discarded') {
            sendError(res, 409, 'DRAFT_CLOSED', 'This draft is no longer open for changes');
            return;
          }
          const activeKey = `${project.id}:${jobId}`;
          if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
            sendError(res, 409, 'SESSION_ACTIVE', 'This creator session is already continuing');
            return;
          }
          await reopenAgentDraft(project.root, jobId, prompt);
          const job = onboardingJobs.get(jobId);
          if (job?.kind === 'agent-creation') {
            job.status = 'running';
            delete job.error;
            delete job.result;
            await persistOnboardingJob(job);
          }
          startSessionContinue(res, { project, sessionId: jobId, prompt });
          return;
        }

        if (action === 'discard') {
          if (record.status === 'running') {
            const worker = workers.get(project.id);
            if (worker) {
              await worker.stopSession({
                projectRoot: project.root,
                sessionId: jobId,
                reason: 'Agent draft discarded by operator',
              }).catch(() => undefined);
            }
          }
          const discarded = await markAgentDraftDiscarded(project.root, jobId);
          await cleanupInternalView(jobId);
          wakeListHubs();
          sendJSON(res, 200, { success: true, draft: draftViewPayload(project, discarded) });
          return;
        }

        // Dormant: nothing in the UI links here. The mock scopes only ground
        // a bash-fenced agent, so an MCP-first one would be fully fabricated
        // or would fire a real send. Kept working for when scope understands
        // MCP; `agentuse test` shares the same helpers.
        if (action === 'test-run') {
          const latest = latestAgentDraft(record);
          if (!latest) {
            sendError(res, 409, 'DRAFT_NOT_READY', 'There is no draft to test yet');
            return;
          }
          const started = await startMockTestRun(project, latest, (testSessionId, outcome) =>
            settleAgentDraftTestRun(project.root, record.jobId, testSessionId, outcome).then(() => undefined));
          await recordAgentDraftTestRun(project.root, record.jobId, {
            sessionId: started.sessionId,
            draftIndex: latest.index,
            startedAt: Date.now(),
            status: 'running',
          });
          sendJSON(res, 202, { success: true, testRun: started });
          return;
        }

        // save
        const latest = latestAgentDraft(record);
        if (!latest) {
          sendError(res, 409, 'DRAFT_NOT_READY', 'There is no draft to save yet');
          return;
        }
        // Save transitions out of an open draft, so the server decides which
        // states may make that move. A second tab left idle stops polling and
        // can still offer Save after another tab discarded or reopened this draft.
        if (record.status === 'saved') {
          sendError(res, 409, 'DRAFT_ALREADY_SAVED', 'This draft was already saved');
          return;
        }
        if (record.status === 'discarded') {
          sendError(res, 409, 'DRAFT_CLOSED', 'This draft is no longer open for changes');
          return;
        }
        if (record.status === 'running') {
          sendError(res, 409, 'DRAFT_NOT_READY', 'This draft is still being written');
          return;
        }
        const recovery = await resolveAgentCreationRecovery(jobId, record);
        const created = await finishAgentCreation(project, recovery, {
          source: latest.source,
          name: latest.name,
          fileName: latest.fileName,
        });
        await markAgentDraftSaved(project.root, jobId, created.agent.runPath);
        await cleanupInternalView(jobId);
        const job = onboardingJobs.get(jobId);
        if (job?.kind === 'agent-creation') {
          job.result = created;
          job.status = 'completed';
          await persistOnboardingJob(job);
        }
        wakeListHubs();
        sendJSON(res, 200, { success: true, agent: created.agent });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        if (err instanceof AgentCreationError) {
          sendError(res, 400, err.code, err.message);
        } else {
          sendError(res, 400, 'DRAFT_ACTION_FAILED', toErrorMessage(err));
        }
      } finally {
        if (mutationKey) draftMutations.delete(mutationKey);
      }
      return;
    }

    const revisionActionMatch = !isApi
      ? routePath.match(/^\/agent-revisions\/([^/?#]+)(?:\/(apply|discard|restore|request-changes|cancel|test-run))?$/)
      : null;
    if (revisionActionMatch) {
      let mutationKey: string | undefined;
      try {
        const revisionSessionId = decodeURIComponent(revisionActionMatch[1]!);
        const action = revisionActionMatch[2];
        const projectId = requestUrl.searchParams.get('project') ?? undefined;
        const project = projectId ? projectsById.get(projectId) : projects.length === 1 ? projects[0] : undefined;
        if (!project) {
          sendError(res, 400, 'PROJECT_REQUIRED', 'Choose the project that owns this revision');
          return;
        }
        if (req.method === 'GET' && !action) {
          const token = requestUrl.searchParams.get('token') ?? undefined;
          if (!sessionAuthorized(revisionSessionId, token)) {
            sendError(res, 401, 'UNAUTHORIZED', 'Not authorized for this revision session');
            return;
          }
          if (effectiveHideAgentSource) {
            sendError(res, 403, 'AGENT_SOURCE_HIDDEN', 'Agent revision review is unavailable while serve.hideAgentSource is enabled');
            return;
          }
          const storedRecord = await readAgentRevisionRecord(project.root, revisionSessionId);
          const record = storedRecord
            ? await reconcileAgentRevisionRecord(project, storedRecord)
            : undefined;
          if (!record) {
            sendError(res, 404, 'REVISION_NOT_FOUND', 'Revision not found');
            return;
          }
          const { previousSource: _previous, ...visibleRecord } = record;
          const baseSource = record.previousSource
            ?? (record.status === 'proposed' || record.status === 'no-change' || record.status === 'accepted' || record.status === 'running'
              ? await readFile(record.targetAgentPath, 'utf8').catch(() => undefined)
              : undefined);
          const originHref = (() => {
            if (!record.originSessionId) return undefined;
            const originParams = new URLSearchParams({ project: project.id });
            const originToken = sessionViewToken(record.originSessionId, apiKey);
            if (originToken) originParams.set('token', originToken);
            return `/sessions/${encodeURIComponent(record.originSessionId)}?${originParams.toString()}`;
          })();
          if (record.status === 'accepted' || record.status === 'applied' || record.status === 'discarded' || record.status === 'restored' || record.status === 'error') {
            await cleanupInternalView(revisionSessionId);
          }
          sendJSON(res, 200, {
            success: true,
            revision: {
              ...visibleRecord,
              ...(baseSource && { baseSource }),
              ...(originHref && { originHref }),
            },
          });
          return;
        }
        if (req.method !== 'POST' || !action) {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Unsupported revision action');
          return;
        }
        if (!sessionAgentRevisionAllowed(req.headers.authorization, apiKey)) {
          sendError(res, 403, 'OPERATOR_REQUIRED', 'Only an authenticated operator can change agent source');
          return;
        }
        // Same ownership rule as the draft lock above.
        const revisionKey = `revision:${project.id}:${revisionSessionId}`;
        if (revisionMutations.has(revisionKey)) {
          sendError(res, 409, 'REVISION_ACTION_IN_PROGRESS', 'Another action is already changing this revision');
          return;
        }
        revisionMutations.add(revisionKey);
        mutationKey = revisionKey;
        if (action === 'request-changes') {
          const body = await parseJSONBody(req);
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt || prompt.length > 12_000) {
            sendError(res, 400, 'REVISION_FEEDBACK_REQUIRED', 'Describe the changes you want to the proposal');
            return;
          }
          const activeKey = `${project.id}:${revisionSessionId}`;
          if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
            sendError(res, 409, 'SESSION_ACTIVE', 'This revision session is already continuing');
            return;
          }
          // The reopened turn is answering a change to a specific proposal.
          // Restating the source it is editing keeps the reviser from
          // hunting for a file the sanitized project view does not contain.
          const standing = await readAgentRevisionRecord(project.root, revisionSessionId);
          const continuePrompt = standing?.proposedSource
            ? [
                '[runtime] The operator reviewed your previous proposal and asked for a change to it.',
                'The text below is that proposal exactly as it stands. Derive your exact edits against the current agent source you were given at the start of this session, not against a file on disk.',
                '',
                revisionProposalTag(standing.proposedSource.trim()),
                '',
                revisionRequestTag(prompt),
                '',
                'Call submit_agent_revision again with the full ordered edit set.',
              ].join('\n')
            : prompt;
          await reopenAgentRevision(project.root, revisionSessionId, prompt);
          startSessionContinue(res, { project, sessionId: revisionSessionId, prompt: continuePrompt });
          return;
        }
        // Dormant, as on the draft route above: unreachable from the UI
        // until mock scope understands MCP.
        if (action === 'test-run') {
          const record = await readAgentRevisionRecord(project.root, revisionSessionId);
          if (!record?.proposedSource) {
            sendError(res, 409, 'REVISION_NOT_PROPOSED', 'There is no proposed source to test yet');
            return;
          }
          const fileName = (record.targetAgentRunPath ?? record.targetAgentPath).split('/').pop() ?? 'agent.agentuse';
          const started = await startMockTestRun(project, {
            source: record.proposedSource,
            name: record.targetAgentName,
            fileName,
            model: record.authoringModel,
            index: record.proposalCount ?? 1,
          });
          sendJSON(res, 202, { success: true, testRun: started });
          return;
        }
        if (action === 'cancel') {
          const record = await readAgentRevisionRecord(project.root, revisionSessionId);
          if (!record || record.status !== 'running') {
            sendError(res, 409, 'REVISION_NOT_RUNNING', 'This revision is no longer running');
            return;
          }
          const worker = workers.get(project.id);
          if (worker) {
            await worker.stopSession({
              projectRoot: project.root,
              sessionId: revisionSessionId,
              reason: 'Revision cancelled by operator',
            }).catch(() => undefined);
          }
          const cancelled = await failAgentRevision(project.root, revisionSessionId, {
            code: 'REVISION_CANCELLED',
            message: 'The revision was cancelled by the operator',
          });
          const job = onboardingJobs.get(revisionSessionId);
          if (job) {
            job.status = 'error';
            job.error = cancelled?.error ?? {
              code: 'REVISION_CANCELLED',
              message: 'The revision was cancelled by the operator',
            };
            await persistOnboardingJob(job);
          }
          await cleanupInternalView(revisionSessionId);
          wakeListHubs();
          const { previousSource: _previous, ...visibleRecord } = cancelled ?? record;
          sendJSON(res, 200, { success: true, revision: visibleRecord });
          return;
        }
        let record;
        if (action === 'apply') {
          const snapshot = await providerSetupSnapshot();
          const availableModels = [...new Set((await agentCreationProviders(snapshot.status, preferredAgentCreationModel)).flatMap((provider) => provider.models))];
          const availableSkills = (await discoverProjectSkillCatalog(project.root)).filter((skill) => !skill.ambiguous).map((skill) => skill.name);
          record = await applyAgentRevision({
            projectRoot: project.root,
            scopeRoot: project.scopeRoot,
            revisionSessionId,
            availableModels,
            availableSkills,
          });
          agentSummaryCache.delete(record.targetAgentPath);
          if (record.targetAgentRunPath) agentSummaryCache.delete(resolveScopedAgentPath(project, record.targetAgentRunPath));
        } else if (action === 'restore') {
          record = await restoreAgentRevision({ projectRoot: project.root, scopeRoot: project.scopeRoot, revisionSessionId });
          agentSummaryCache.delete(record.targetAgentPath);
        } else {
          record = await discardAgentRevision(project.root, revisionSessionId);
        }
        wakeListHubs();
        const { previousSource: _previous, ...visibleRecord } = record;
        sendJSON(res, 200, { success: true, revision: visibleRecord });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, 'REVISION_ACTION_FAILED', toErrorMessage(err));
      } finally {
        if (mutationKey) revisionMutations.delete(mutationKey);
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
