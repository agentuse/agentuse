import { parseAgent } from "../../../parser";
import { setSchedulePaused } from "../../../scheduler/state.js";
import { toErrorMessage } from "../../../utils/error-message.js";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { resolveScopedAgentPath, toProjectRelativeAgentPath } from "../project";
import type { ServeContext, ServeRequest } from "../context";
import { armProjectSchedules, recordProjectScheduleState, retryProjectScheduleState } from "../schedule-state";

/**
 * Schedule listing and the per-agent pause/resume toggle.
 */
export async function scheduleRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  const {
    projectsById,
    scheduler,
    pausedSchedulesByProject,
    scheduleStateErrors,
    scheduleIsEnabled,
    wakeListHubs,
  } = ctx;
  const scheduleState = { paused: pausedSchedulesByProject, errors: scheduleStateErrors };
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {
    if (req.method === "GET" && routePath === '/schedules') {
      if (isApi) {
        // Retry projects whose state file failed to load, so a fixed or removed
        // file re-arms their schedules without a serve restart.
        for (const projectId of [...scheduleStateErrors.keys()]) {
          const project = projectsById.get(projectId);
          if (project && await retryProjectScheduleState(scheduleState, project.id, project.root)) {
            armProjectSchedules(scheduler, project, scheduleIsEnabled);
          }
        }
        const schedules = scheduler.listSerialized();
        sendJSON(res, 200, {
          success: true,
          schedules,
          ...(scheduleStateErrors.size > 0 && { stateErrors: Object.fromEntries(scheduleStateErrors) }),
        });
        return;
      }
    }

    if (isApi && req.method === 'POST' && routePath === '/schedules/state') {
      try {
        const body = await parseJSONBody(req);
        if (typeof body.project !== 'string' || typeof body.path !== 'string' || typeof body.paused !== 'boolean') {
          sendError(res, 400, 'INVALID_SCHEDULE_STATE', 'Project, agent path, and paused state are required');
          return;
        }
        const project = projectsById.get(body.project);
        if (!project || !project.agentFiles.includes(body.path)) {
          sendError(res, 404, 'AGENT_NOT_FOUND', 'Scheduled agent not found');
          return;
        }
        const parsed = await parseAgent(resolveScopedAgentPath(project, body.path));
        if (!parsed.config.schedule) {
          sendError(res, 409, 'SCHEDULE_NOT_FOUND', 'This agent does not declare a schedule');
          return;
        }
        const statePath = toProjectRelativeAgentPath(project, body.path);
        const paused = await setSchedulePaused(project.root, statePath, body.paused);
        recordProjectScheduleState(scheduleState, project.id, paused);
        armProjectSchedules(scheduler, project, scheduleIsEnabled);
        wakeListHubs();
        sendJSON(res, 200, { success: true, paused: body.paused, scheduleEnabled: !body.paused });
      } catch (error) {
        if (sendRequestParseError(res, error)) return;
        sendError(res, 500, 'SCHEDULE_STATE_FAILED', toErrorMessage(error));
      }
      return;
    }
    matched = false;
  };
  await run();
  return matched;
}
