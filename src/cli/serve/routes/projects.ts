import { toErrorMessage } from "../../../utils/error-message.js";
import { pickLocalProjectFolder } from "../../../utils/folder-picker";
import { persistServeProject, removeServeProject } from "../../../utils/global-config";
import { canUseHostFolderPicker } from "../../../utils/local-request";
import { ManagedProjectError, createManagedProjectTransaction } from "../../../utils/managed-project";
import { releaseSchedulerLock } from "../../../utils/scheduler-lock";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { resolveProjectFromPath } from "../project";
import { existsSync } from "fs";
import { resolve } from "path";
import type { ServeContext, ServeRequest } from "../context";

/**
 * Attaching, creating, detaching and browsing for the projects this daemon
 * serves. Every mutation takes the same in-flight latch.
 */
export async function projectRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, routePath } = rq;
  const {
    state: serveState,
    effectiveHost,
    projects,
    projectsById,
    projectSeeds,
    agentCounts,
    idSeen,
    pathSeen,
    fileWatchers,
    projectWatchers,
    attachProject,
    onboardingProjectInfo,
    updateRegistryCounts,
    workers,
    workerReadyAt,
    scheduler,
    pausedSchedulesByProject,
    scheduleStateErrors,
    schedulerLocksHeld,
    orphanReconcileLoop,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    if (req.method === "POST" && routePath === "/projects") {
      if (serveState.projectMutationInFlight) {
        sendError(res, 409, "PROJECT_MUTATION_IN_PROGRESS", "Another project change is already in progress");
        return;
      }
      serveState.projectMutationInFlight = true;
      try {
        const body = await parseJSONBody(req);
        // Runtime attachment is staged before config registration. A failed
        // worker or watcher startup therefore leaves neither a phantom
        // config entry nor a directory that blocks retry.
        const { managed, value: project } = await createManagedProjectTransaction(
          body.name,
          async (staged) => {
            const envLocal = resolve(staged.root, '.env.local');
            const attached = await attachProject({
              id: staged.id,
              root: staged.root,
              scopeRoot: staged.root,
              envFile: existsSync(envLocal) ? envLocal : resolve(staged.root, '.env'),
            });
            return { value: attached.project, rollback: attached.rollback };
          },
        );

        sendJSON(res, 201, {
          success: true,
          project: {
            id: project.id,
            path: project.root,
            agentCount: 0,
            scheduleCount: 0,
            about: { name: managed.name, description: 'Your AgentUse agents' },
          },
        });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        if (err instanceof ManagedProjectError && err.code === 'PROJECT_EXISTS') {
          sendError(res, 409, err.code, err.message);
        } else {
          sendError(res, err instanceof ManagedProjectError ? 500 : 400, "INVALID_PROJECT", toErrorMessage(err));
        }
      } finally {
        serveState.projectMutationInFlight = false;
      }
      return;
    }

    if (req.method === "POST" && routePath === "/projects/attach") {
      if (serveState.projectMutationInFlight) {
        sendError(res, 409, "PROJECT_MUTATION_IN_PROGRESS", "Another project change is already in progress");
        return;
      }
      serveState.projectMutationInFlight = true;
      let rollback: (() => Promise<void>) | undefined;
      try {
        const body = await parseJSONBody(req);
        if (typeof body.path !== 'string' || !body.path.trim()) {
          sendError(res, 400, "INVALID_PROJECT", "Enter the folder path for an existing project");
          return;
        }
        const seed = resolveProjectFromPath(body.path);
        const loadedProjectId = pathSeen.get(seed.root);
        if (loadedProjectId) {
          const loadedProject = projectsById.get(loadedProjectId);
          if (!loadedProject) throw new Error(`Loaded project metadata is missing for "${loadedProjectId}"`);
          sendJSON(res, 200, {
            success: true,
            project: await onboardingProjectInfo(loadedProject),
          });
          return;
        }
        const attached = await attachProject(seed);
        rollback = attached.rollback;
        persistServeProject({ id: seed.id, path: seed.scopeRoot });
        sendJSON(res, 201, {
          success: true,
          project: await onboardingProjectInfo(attached.project),
        });
      } catch (err) {
        await rollback?.().catch(() => {});
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_PROJECT", toErrorMessage(err));
      } finally {
        serveState.projectMutationInFlight = false;
      }
      return;
    }

    if (req.method === "DELETE" && routePath.startsWith("/projects/")) {
      if (serveState.projectMutationInFlight) {
        sendError(res, 409, "PROJECT_MUTATION_IN_PROGRESS", "Another project change is already in progress");
        return;
      }
      const projectId = decodeURIComponent(routePath.slice('/projects/'.length));
      const project = projectsById.get(projectId);
      if (!project) {
        sendError(res, 404, "PROJECT_NOT_FOUND", `Unknown project id: "${projectId}"`);
        return;
      }
      const worker = workers.get(project.id);
      if (worker && worker.activeRequestCount() > 0) {
        sendError(res, 409, "PROJECT_BUSY", "This project has active work. Wait for it to finish before removing the project.");
        return;
      }

      serveState.projectMutationInFlight = true;
      try {
        // Persist first: if config cannot be updated, the live project stays
        // fully attached. Removing a project never deletes its directory.
        removeServeProject({ id: project.id, path: project.scopeRoot });

        const watcher = projectWatchers.get(project.id);
        if (watcher) {
          await watcher.close().catch(() => {});
          projectWatchers.delete(project.id);
          const watcherIndex = fileWatchers.indexOf(watcher);
          if (watcherIndex >= 0) fileWatchers.splice(watcherIndex, 1);
        }
        for (const schedule of scheduler.list().filter((item) => item.projectId === project.id)) {
          scheduler.removeByAgentPath(project.id, schedule.agentPath);
        }
        if (schedulerLocksHeld.has(project.id)) {
          releaseSchedulerLock(project.root);
          schedulerLocksHeld.delete(project.id);
        }
        worker?.shutdown();
        workers.delete(project.id);
        workerReadyAt.delete(project.id);
        const seedIndex = projectSeeds.findIndex((item) => item.id === project.id);
        if (seedIndex >= 0) projectSeeds.splice(seedIndex, 1);
        const projectIndex = projects.indexOf(project);
        if (projectIndex >= 0) projects.splice(projectIndex, 1);
        projectsById.delete(project.id);
        pausedSchedulesByProject.delete(project.id);
        scheduleStateErrors.delete(project.id);
        agentCounts.delete(project.id);
        pathSeen.delete(project.root);
        idSeen.delete(project.id);
        if (serveState.effectiveDefault === project.id || projects.length < 2) serveState.effectiveDefault = undefined;
        serveState.multiProject = projects.length > 1;
        updateRegistryCounts();
        orphanReconcileLoop.runNow();
        sendJSON(res, 200, { success: true });
      } catch (err) {
        sendError(res, 500, "PROJECT_REMOVE_FAILED", toErrorMessage(err));
      } finally {
        serveState.projectMutationInFlight = false;
      }
      return;
    }

    if (req.method === "POST" && routePath === "/projects/pick-folder") {
      if (!canUseHostFolderPicker(effectiveHost, req.socket.remoteAddress, req.headers.host)) {
        sendError(res, 403, "FOLDER_PICKER_LOCAL_ONLY", "The folder chooser is only available on a local AgentUse server");
        return;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) {
        sendError(res, 415, "JSON_REQUIRED", "The folder chooser requires a same-origin JSON request");
        return;
      }
      try {
        const path = await pickLocalProjectFolder();
        sendJSON(res, 200, { success: true, path });
      } catch (err) {
        sendError(res, 500, "FOLDER_PICKER_FAILED", toErrorMessage(err));
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
