import { AgentCreationError, agentCreationProviders, listAgentFileNames, validateAgentCreationRequest } from "../../../agents/create";
import { discoverProjectSkillCatalog, prepareProjectDiscoveryView } from "../../../agents/discover";
import { appendAgentDraft, createAgentDraftRecord, failAgentDraft, internalAgentDraftPath, readAgentDraftRecord, writeInternalAgentDraftSource } from "../../../agents/draft";
import { providerSetupSnapshot } from "../../../auth/provider-setup";
import { REASONING_LEVELS } from "../../../model-compatibility";
import type { ReasoningLevel } from "../../../model-compatibility";
import { runInternalJobLifecycle } from "../../../onboarding/internal-job-runner";
import { buildAgentCreatorSessionAgent } from "../../../onboarding/session-agents";
import { parseScheduleExpression } from "../../../scheduler/parser";
import { loadBuiltinSkillSource } from "../../../skill/builtin";
import { stripAgentExtension } from "../../../utils/agent-id.js";
import { toErrorMessage } from "../../../utils/error-message.js";
import { logger } from "../../../utils/logger";
import { sessionViewToken } from "../../../utils/session-token";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { AgentCreationRecoveryInput, OnboardingModelJob } from "../internal-jobs";
import { relative } from "path";
import { ulid } from "ulid";
import type { ServeContext, ServeRequest } from "../context";

/**
 * Creating a new agent: the creation form's options, and the POST that starts
 * the creator session.
 */
export async function agentCreateRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath } = rq;
  const {
    options,
    state: serveState,
    apiKey,
    projects,
    projectsById,
    workers,
    wakeListHubs,
    agentCreationRecoveryInputs,
    internalViewCleanups,
    preferredAgentCreationModel,
    cleanupInternalView,
    persistOnboardingJob,
    beginInternalAgentJob,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    if (isApi && routePath === "/agents/create" && req.method === "GET") {
      try {
        const snapshot = await providerSetupSnapshot();
        // The dialog shows the skill pool the creator can draw on before
        // the brief is written, because a thin catalog usually means a thin
        // agent and that is worth knowing while the brief is still editable.
        const skillProjectId = requestUrl.searchParams.get('project')
          ?? serveState.effectiveDefault
          ?? (projects.length === 1 ? projects[0]!.id : null);
        const skillProject = skillProjectId ? projectsById.get(skillProjectId) : undefined;
        const skillCatalog = skillProject
          ? await discoverProjectSkillCatalog(skillProject.root).catch(() => [])
          : [];
        sendJSON(res, 200, {
          success: true,
          providers: await agentCreationProviders(
            snapshot.status,
            preferredAgentCreationModel,
          ),
          projects: projects.map((project) => ({
            id: project.id,
            path: project.root,
            ...(project.scopeRoot !== project.root && { scope: project.scopeRoot }),
          })),
          default: serveState.effectiveDefault ?? (projects.length === 1 ? projects[0]!.id : null),
          skills: {
            ...(skillProject && { project: skillProject.id }),
            counts: {
              project: skillCatalog.filter((skill) => skill.source === 'project').length,
              global: skillCatalog.filter((skill) => skill.source === 'global').length,
              ambiguous: skillCatalog.filter((skill) => skill.ambiguous).length,
            },
            items: skillCatalog.map((skill) => ({
              name: skill.name,
              source: skill.source,
              ...(skill.ambiguous && { ambiguous: true }),
            })),
          },
        });
      } catch (err) {
        sendError(res, 500, "AGENT_CREATE_OPTIONS_FAILED", toErrorMessage(err));
      }
      return;
    }

    if (isApi && routePath === "/agents" && req.method === "POST") {
      try {
        const body = await parseJSONBody(req);
        if (typeof body.project !== "string" || !body.project) {
          sendError(res, 400, "PROJECT_REQUIRED", "Choose a project for this agent");
          return;
        }
        const project = projects.find((candidate) => candidate.id === body.project);
        if (!project) {
          sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${body.project}`);
          return;
        }
        const worker = workers.get(project.id);
        if (!worker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }
        const snapshot = await providerSetupSnapshot();
        const providers = await agentCreationProviders(snapshot.status, preferredAgentCreationModel);
        const configuredProviders = providers.map((provider) => provider.id);
        const availableModels = [...new Set(providers.flatMap((provider) => provider.models))];
        const request = validateAgentCreationRequest(
          { name: body.name, objective: body.objective, model: body.model },
          configuredProviders,
          availableModels,
        );
        let reasoning: ReasoningLevel | undefined;
        if (body.reasoning !== undefined) {
          if (typeof body.reasoning !== 'string' || !(REASONING_LEVELS as readonly string[]).includes(body.reasoning)) {
            throw new AgentCreationError('INVALID_AGENT', 'Choose a valid thinking effort');
          }
          reasoning = body.reasoning as ReasoningLevel;
        }
        const schedule = body.schedule === undefined ? undefined : (() => {
          if (typeof body.schedule !== 'string' || !body.schedule.trim()) {
            throw new AgentCreationError('INVALID_AGENT', 'Choose a valid schedule for this agent');
          }
          parseScheduleExpression(body.schedule);
          return body.schedule.trim();
        })();
        const guided = body.guided === true;
        if (guided && !request.name) {
          throw new AgentCreationError('INVALID_AGENT', 'The reviewed suggestion must include an agent name');
        }
        if (guided && (typeof body.description !== 'string' || !body.description.trim() || body.description.trim().length > 240)) {
          throw new AgentCreationError('INVALID_AGENT', 'The reviewed suggestion must include a concise description');
        }
        const guidedDescription = guided ? (body.description as string).trim() : undefined;
        if (guided && !schedule) {
          throw new AgentCreationError('INVALID_AGENT', 'Choose a valid schedule for this agent');
        }
        const idea = guided
          ? {
              title: request.name!,
              ...(typeof body.evidence === 'string' && body.evidence.trim()
                ? { evidence: body.evidence.trim().slice(0, 240) }
                : {}),
            }
          : undefined;
        const sessionId = ulid();
        const job: OnboardingModelJob = {
          id: sessionId,
          sessionId,
          projectId: project.id,
          kind: 'agent-creation',
          status: 'running',
          phase: 'preparing',
          model: request.model,
          createdAt: Date.now(),
        };
        const recoveryInput: AgentCreationRecoveryInput = {
          request,
          ...(schedule && { schedule }),
          guided,
          configuredProviders,
          availableModels,
        };
        agentCreationRecoveryInputs.set(job.id, recoveryInput);
        // The catalog is read once and shared: the draft record shows the
        // pool the operator can reason about, and the creator agent is
        // built from the same list rather than a second, possibly
        // divergent, scan.
        const skillCatalog = await discoverProjectSkillCatalog(project.root);
        await createAgentDraftRecord({
          jobId: job.id,
          projectId: project.id,
          projectRoot: project.root,
          objective: request.objective,
          guided,
          ...(idea && { idea }),
          authoringModel: request.model,
          skillCounts: {
            project: skillCatalog.filter((skill) => skill.source === 'project').length,
            global: skillCatalog.filter((skill) => skill.source === 'global').length,
            ambiguous: skillCatalog.filter((skill) => skill.ambiguous).length,
          },
        });
        const prepared = await beginInternalAgentJob({
          job,
          worker,
          project,
          agentId: stripAgentExtension(relative(project.root, internalAgentDraftPath(project.root, sessionId))),
          agentName: 'internal-agent-creator',
          agentDescription: 'Turn a user brief into a production AgentUse agent',
          timeout: 300,
          maxSteps: 12,
          trigger: 'onboarding',
        });
        if (!prepared.success) {
          throw new AgentCreationError('CREATE_FAILED', prepared.error.message);
        }
        const sessionToken = apiKey ? sessionViewToken(sessionId, apiKey) : undefined;
        sendJSON(res, 202, {
          success: true,
          job: { ...job, ...(sessionToken && { sessionToken }) },
        });

        let cleanupView: (() => Promise<void>) | undefined;
        void runInternalJobLifecycle({
          job,
          prepare: async () => {
            const viewPromise = prepareProjectDiscoveryView(project.scopeRoot).then((view) => {
              cleanupView = view.cleanup;
              return view;
            });
            const [view, creatorSkill, existingAgentFileNames] = await Promise.all([
              viewPromise,
              loadBuiltinSkillSource('creator'),
              listAgentFileNames(project),
            ]);
            const availableSkills = skillCatalog;
            const agentContent = buildAgentCreatorSessionAgent({
              model: request.model,
              ...(reasoning && { reasoning }),
              safeViewRoot: view.root,
              creatorSkill,
              ...(request.name && { requestedName: request.name }),
              ...(guidedDescription && { description: guidedDescription }),
              objective: request.objective,
              ...(schedule && { schedule }),
              availableModels,
              availableSkills,
              existingAgentFileNames,
            });
            // Persist the generated agent the way the reviser does: a
            // continued session reloads its agent from disk, so a purely
            // in-memory creator could never answer a change request.
            const finishDraftView = cleanupView;
            if (finishDraftView) {
              internalViewCleanups.set(sessionId, finishDraftView);
              cleanupView = undefined;
            }
            return writeInternalAgentDraftSource(project.root, sessionId, agentContent);
          },
          execute: (internalAgentPath) => worker.execute({
              agentPath: internalAgentPath,
              projectRoot: project.root,
              newSessionId: sessionId,
              preparedSession: true,
              trigger: 'onboarding',
              timeout: 300,
              maxSteps: 12,
              debug: options.debug,
            }),
          consume: async (execution) => {
            if (!execution.success) {
              job.status = 'error';
              job.error = execution.error;
              await failAgentDraft(project.root, job.id, execution.error).catch(() => undefined);
              return;
            }
            if (
              !execution.result.agentSource
              || !execution.result.authoredAgentName
              || !execution.result.authoredAgentFileName
            ) {
              throw new AgentCreationError(
                'GENERATION_FAILED',
                'The creator finished without submitting an agent name, filename, and source through submit_agent_source',
              );
            }
            // The session ends "drafted", not saved: nothing is written to
            // the project until the operator presses Save on the draft page.
            await appendAgentDraft(project.root, job.id, {
              source: execution.result.agentSource,
              name: execution.result.authoredAgentName,
              fileName: execution.result.authoredAgentFileName,
              model: request.model,
              ...(execution.result.headline && { reply: execution.result.headline }),
              ...(execution.result.authoredAgentLoadedSkills?.length && {
                loadedSkills: execution.result.authoredAgentLoadedSkills,
              }),
            });
            job.result = { kind: 'draft', jobId: job.id, projectId: project.id };
            job.status = 'completed';
          },
          mapError: (error) => {
            const mapped = {
              code: error instanceof AgentCreationError ? error.code : 'AGENT_CREATE_FAILED',
              message: toErrorMessage(error),
            };
            void failAgentDraft(project.root, job.id, mapped).catch(() => undefined);
            return mapped;
          },
          persist: () => persistOnboardingJob(job),
          wake: wakeListHubs,
          failPreparing: (error) => worker.failPreparingSession({
            projectRoot: project.root,
            sessionId,
            code: error.code,
            message: error.message,
          }).then(() => undefined),
          cleanup: async () => {
            await cleanupView?.();
            const latest = await readAgentDraftRecord(project.root, job.id).catch(() => undefined);
            if (!latest || latest.status === 'saved' || latest.status === 'discarded') {
              await cleanupInternalView(job.id);
            }
          },
          onPersistenceError: (error) => logger.warn(`Failed to persist internal agent job ${job.id}: ${toErrorMessage(error)}`),
        });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        if (err instanceof AgentCreationError) {
          sendError(res, 400, err.code, err.message);
        } else {
          sendError(res, 500, "AGENT_CREATE_START_FAILED", toErrorMessage(err));
        }
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
