import { agentCreationProviders } from "../../../agents/create";
import { discoverProjectSkillCatalog, prepareProjectDiscoveryView } from "../../../agents/discover";
import { readAgentRevisionRecord } from "../../../agents/revision";
import { providerSetupSnapshot } from "../../../auth/provider-setup";
import { ONBOARDING_AGENT_ID, ONBOARDING_AGENT_SOURCE } from "../../../onboarding";
import { runInternalJobLifecycle } from "../../../onboarding/internal-job-runner";
import { recoverInternalCreatorSession } from "../../../onboarding/internal-job-store.js";
import { buildProjectDiscoverySessionAgent } from "../../../onboarding/session-agents";
import { toErrorMessage } from "../../../utils/error-message.js";
import { logger } from "../../../utils/logger";
import { isProcessRefAliveAsync } from "../../../utils/process-info";
import { sessionViewToken } from "../../../utils/session-token";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { AgentCreationRecoveryInput, OnboardingModelJob } from "../internal-jobs";
import { ulid } from "ulid";
import type { ServeContext, ServeRequest } from "../context";

/**
 * Onboarding: polling an internal model job, project discovery, and the guided
 * first run.
 */
export async function onboardingRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  const {
    options,
    apiKey,
    projects,
    projectsById,
    agentCounts,
    resolveRequestProject,
    workers,
    wakeListHubs,
    onboardingJobs,
    agentCreationRecoveryInputs,
    preferredAgentCreationModel,
    cleanupInternalView,
    pruneOnboardingJobs,
    persistOnboardingJob,
    loadPersistedOnboardingJob,
    beginInternalAgentJob,
    recoverAgentCreationJob,
    recoverProjectDiscoveryJob,
    reconcileAgentRevisionRecord,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    const onboardingJobMatch = isApi && req.method === 'GET'
      ? routePath.match(/^\/internal-agent-jobs\/([^/?#]+)$/)
      : null;
    if (onboardingJobMatch) {
      pruneOnboardingJobs();
      const jobId = decodeURIComponent(onboardingJobMatch[1]!);
      let job = onboardingJobs.get(jobId);
      if (!job) {
        const persisted = await loadPersistedOnboardingJob(jobId);
        if (persisted) {
          job = persisted.job;
          onboardingJobs.set(job.id, job);
          // A running job cannot be pruned from this process's in-memory
          // map. Therefore a legacy envelope that names our recycled PID
          // still belongs to an earlier daemon instance.
          const ownerAlive = persisted.owner
            ? await isProcessRefAliveAsync(persisted.owner)
            : persisted.ownerPid !== process.pid
              && await isProcessRefAliveAsync({ pid: persisted.ownerPid });
          if (persisted.agentCreation) {
            agentCreationRecoveryInputs.set(job.id, persisted.agentCreation);
            await recoverAgentCreationJob(job, !ownerAlive);
          } else if (job.kind === 'project-discovery') {
            await recoverProjectDiscoveryJob(job, !ownerAlive);
          } else if (job.kind === 'agent-revision') {
            const project = projectsById.get(job.projectId);
            const record = project
              ? await readAgentRevisionRecord(project.root, job.sessionId)
              : undefined;
            const reconciled = project && record
              ? await reconcileAgentRevisionRecord(project, record)
              : record;
            if (reconciled?.status === 'error') {
              job.status = 'error';
              job.error = reconciled.error ?? {
                code: 'REVISION_SESSION_FAILED',
                message: 'The revision session did not finish successfully',
              };
            } else if (reconciled && reconciled.status !== 'running') {
              job.status = 'completed';
              job.result = reconciled;
            }
            await persistOnboardingJob(job);
          } else if (job.status === 'running' && !ownerAlive) {
            job.status = 'error';
            job.error = {
              code: 'INTERNAL_JOB_INTERRUPTED',
              message: 'The serve daemon restarted before this internal job finished',
            };
            await persistOnboardingJob(job);
          }
        }
      }
      // Backward compatibility for creator sessions completed before job
      // envelopes and structured-delivery checkpoints became durable.
      if (!job) {
        for (const project of projects) {
          const session = await recoverInternalCreatorSession(project.root, jobId);
          if (!session || session.status !== 'completed') continue;
          const snapshot = await providerSetupSnapshot();
          const providers = await agentCreationProviders(snapshot.status, preferredAgentCreationModel);
          const recovery: AgentCreationRecoveryInput = {
            request: {
              objective: session.submission.source,
              model: session.submission.model,
            },
            guided: false,
            configuredProviders: providers.map((provider) => provider.id),
            availableModels: [...new Set(providers.flatMap((provider) => provider.models))],
          };
          job = {
            id: jobId,
            sessionId: jobId,
            projectId: project.id,
            kind: 'agent-creation',
            status: 'running',
            phase: 'running',
            model: session.submission.model,
            createdAt: Date.now(),
          };
          onboardingJobs.set(job.id, job);
          agentCreationRecoveryInputs.set(job.id, recovery);
          await persistOnboardingJob(job);
          await recoverAgentCreationJob(job);
          break;
        }
      }
      if (!job) {
        sendError(res, 404, 'ONBOARDING_JOB_NOT_FOUND', 'This onboarding job is no longer available');
        return;
      }
      if (job.status === 'running' && job.kind === 'agent-creation') {
        await recoverAgentCreationJob(job);
      } else if (job.status === 'running' && job.kind === 'project-discovery') {
        await recoverProjectDiscoveryJob(job);
      }
      if (job.kind === 'agent-revision') {
        const project = projectsById.get(job.projectId);
        const storedRecord = project ? await readAgentRevisionRecord(project.root, job.sessionId) : undefined;
        const record = project && storedRecord
          ? await reconcileAgentRevisionRecord(project, storedRecord)
          : storedRecord;
        if (record?.status === 'proposed' || record?.status === 'no-change' || record?.status === 'accepted' || record?.status === 'applied' || record?.status === 'restored' || record?.status === 'discarded') {
          job.status = 'completed';
          job.result = record;
          if (record.status === 'accepted' || record.status === 'applied' || record.status === 'restored' || record.status === 'discarded') {
            await cleanupInternalView(job.sessionId);
          }
        } else if (record?.status === 'error') {
          job.status = 'error';
          if (record.error) job.error = record.error;
          await cleanupInternalView(job.sessionId);
        }
        await persistOnboardingJob(job);
      }
      sendJSON(res, 200, { success: true, job });
      return;
    }

    if (isApi && routePath === '/onboarding/discovery' && req.method === 'POST') {
      try {
        const body = await parseJSONBody(req);
        if (typeof body.project !== 'string' || !body.project) {
          sendError(res, 400, 'PROJECT_REQUIRED', 'Choose a project to scan');
          return;
        }
        const project = projectsById.get(body.project);
        if (!project) {
          sendError(res, 404, 'PROJECT_NOT_FOUND', `Project not found: ${body.project}`);
          return;
        }
        const worker = workers.get(project.id);
        if (!worker) {
          sendError(res, 500, 'WORKER_UNAVAILABLE', `No worker for project ${project.id}`);
          return;
        }
        const providerSnapshot = await providerSetupSnapshot();
        const providers = await agentCreationProviders(providerSnapshot.status, preferredAgentCreationModel);
        const models = [...new Set(providers.flatMap((provider) => provider.models))];
        if (models.length === 0) {
          sendError(res, 409, 'PROVIDER_REQUIRED', 'Connect a model provider before scanning this project');
          return;
        }
        if (typeof body.model !== 'string' || !models.includes(body.model)) {
          sendError(res, 400, 'INVALID_DISCOVERY_MODEL', 'Choose a currently available model for project analysis');
          return;
        }
        const discoveryModel = body.model;

        const sessionId = ulid();
        const job: OnboardingModelJob = {
          id: sessionId,
          sessionId,
          projectId: project.id,
          kind: 'project-discovery',
          status: 'running',
          phase: 'preparing',
          model: discoveryModel,
          createdAt: Date.now(),
        };
        const prepared = await beginInternalAgentJob({
          job,
          worker,
          project,
          agentId: 'onboarding-project-discovery',
          agentName: 'onboarding-project-discovery',
          agentDescription: 'Explore a sanitized project view and propose useful recurring agents',
          timeout: 300,
          maxSteps: 20,
          trigger: 'onboarding',
        });
        if (!prepared.success) {
          throw new Error(prepared.error.message);
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
            const [view, availableSkills] = await Promise.all([
              viewPromise,
              discoverProjectSkillCatalog(project.root),
            ]);
            return buildProjectDiscoverySessionAgent({
              model: discoveryModel,
              projectName: view.projectName,
              inspectedFiles: view.inspectedFiles,
              safeViewRoot: view.root,
              availableSkills,
              existingAgents: view.existingAgents,
            });
          },
          execute: (agentContent) => worker.execute({
              agentContent,
              agentName: 'onboarding-project-discovery',
              projectRoot: project.root,
              newSessionId: sessionId,
              preparedSession: true,
              trigger: 'onboarding',
              timeout: 300,
              maxSteps: 20,
              debug: options.debug,
            }),
          consume: async (execution) => {
            if (!execution.success) {
              job.status = 'error';
              job.error = execution.error?.code === 'TIMEOUT'
                ? {
                    ...execution.error,
                    message: 'Project discovery ran out of time before it could submit suggestions. Try again or choose another model.',
                  }
                : execution.error;
              return;
            }
            const discovery = execution.result.projectDiscovery;
            if (!discovery) {
              job.status = 'error';
              job.error = {
                code: 'PROJECT_DISCOVERY_INVALID',
                message: 'The discovery agent finished without submitting suggestions through submit_project_suggestions',
              };
              return;
            }
            job.status = 'completed';
            job.result = { success: true, model: discoveryModel, ...discovery };
          },
          mapError: (error, phase) => ({
              code: phase === 'preparing' ? 'PROJECT_DISCOVERY_START_FAILED' : 'PROJECT_DISCOVERY_FAILED',
              message: toErrorMessage(error),
            }),
          persist: () => persistOnboardingJob(job),
          wake: wakeListHubs,
          failPreparing: (error) => worker.failPreparingSession({
            projectRoot: project.root,
            sessionId,
            code: error.code,
            message: error.message,
          }).then(() => undefined),
          cleanup: async () => { await cleanupView?.(); },
          onPersistenceError: (error) => logger.warn(`Failed to persist internal agent job ${job.id}: ${toErrorMessage(error)}`),
        });
      } catch (error) {
        if (sendRequestParseError(res, error)) return;
        sendError(res, 500, 'PROJECT_DISCOVERY_START_FAILED', toErrorMessage(error));
      }
      return;
    }

    if (req.method === "POST" && routePath === "/onboarding/run") {
      try {
        const rawBody = await parseJSONBody(req);
        const projectId = typeof rawBody.project === 'string' ? rawBody.project : undefined;
        const resolved = resolveRequestProject({
          agent: ONBOARDING_AGENT_ID,
          ...(projectId && { project: projectId }),
        });
        if ('error' in resolved) {
          const { status, code, message, extra } = resolved.error;
          if (extra) {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: { code, message }, ...extra }));
          } else {
            sendError(res, status, code, message);
          }
          return;
        }

        const project = resolved.project;
        if ((agentCounts.get(project.id) ?? 0) > 0) {
          sendError(res, 409, "ONBOARDING_NOT_AVAILABLE", "The sample run is available only while this project has no agents");
          return;
        }

        const onboardingWorker = workers.get(project.id);
        if (!onboardingWorker) {
          sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
          return;
        }

        const preassignedId = ulid();
        void onboardingWorker.execute({
          agentContent: ONBOARDING_AGENT_SOURCE,
          agentName: ONBOARDING_AGENT_ID,
          projectRoot: project.root,
          timeout: 60,
          maxSteps: 1,
          debug: options.debug,
          newSessionId: preassignedId,
          trigger: 'onboarding',
        }).then((result) => {
          if (!result.success) {
            logger.warn(`Onboarding run ${preassignedId} failed: ${result.error.message}`);
          }
        }).catch((err) => {
          logger.warn(`Onboarding run ${preassignedId} errored: ${toErrorMessage(err)}`);
        }).finally(wakeListHubs);

        wakeListHubs();
        const sessionToken = apiKey ? sessionViewToken(preassignedId, apiKey) : undefined;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          sessionId: preassignedId,
          status: "running",
          ...(sessionToken && { token: sessionToken }),
        }));
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
