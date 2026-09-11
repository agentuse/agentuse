import { listAgentRevisionRecords } from "../../../agents/revision";
import { toErrorMessage } from "../../../utils/error-message.js";
import { sessionViewToken } from "../../../utils/session-token";
import { annotateAgentScheduleStates, collectAgentDetail, collectAgents, collectDirAbouts, redactAgentDetailSource } from "../agents-data";
import { sendError, sendJSON } from "../http";
import { resolveScopedAgentPath } from "../project";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The agents surface: the fleet list, one agent's capability/source detail,
 * and that agent's revision history.
 */
export async function agentRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath } = rq;
  const {
    apiKey,
    effectiveHideAgentSource,
    projects,
    scheduleIsEnabled,
    reconcileAgentRevisionRecord,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {
    if (req.method === "GET" && routePath === '/agents') {
      const { agents, errors } = await collectAgents(projects);
      if (isApi) {
        annotateAgentScheduleStates(agents, projects, scheduleIsEnabled);
        const dirs = await collectDirAbouts(projects, agents);
        sendJSON(res, 200, { success: true, agents, errors, ...(dirs.length > 0 && { dirs }) });
        return;
      }
    }

    // GET /api/agents/detail?project=<id>&path=<runPath>: capabilities
    // summary + raw `.agentuse` source for the agent hub page. Behind the
    // same header gate as the rest of the operator surface (not a capability
    // route), so anyone who can list/run agents can read them, UNLESS
    // serve.hideAgentSource / --hide-agent-source strips the source from
    // the payload (capabilities summary still served). The file is
    // matched against the project's already-loaded `agentFiles` set, so an
    // arbitrary `path` cannot escape the served scope.
    if (req.method === "GET" && routePath === '/agents/detail') {
      const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
      const requestedPath = requestUrl.searchParams.get('path') ?? undefined;
      if (!requestedProject || !requestedPath) {
        sendError(res, 400, "MISSING_PARAMS", "Both project and path query params are required");
        return;
      }
      const project = projects.find((p) => p.id === requestedProject);
      if (!project) {
        sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
        return;
      }
      if (!project.agentFiles.includes(requestedPath)) {
        sendError(res, 404, "AGENT_NOT_FOUND", `Agent not loaded: ${requestedPath}`);
        return;
      }
      try {
        const detail = await collectAgentDetail(project, requestedPath);
        const visible = effectiveHideAgentSource ? redactAgentDetailSource(detail) : detail;
        sendJSON(res, 200, {
          success: true,
          ...visible,
          ...(detail.schedule && { scheduleEnabled: scheduleIsEnabled(project, requestedPath) }),
        });
      } catch (err) {
        sendError(res, 500, "AGENT_READ_FAILED", toErrorMessage(err));
      }
      return;
    }

    // The agent page lists this agent's revision history in its own tab, so
    // it needs the records keyed by agent rather than by originating run.
    if (req.method === "GET" && routePath === '/agents/revisions') {
      const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
      const requestedPath = requestUrl.searchParams.get('path') ?? undefined;
      if (!requestedProject || !requestedPath) {
        sendError(res, 400, "MISSING_PARAMS", "Both project and path query params are required");
        return;
      }
      const project = projects.find((p) => p.id === requestedProject);
      if (!project || !project.agentFiles.includes(requestedPath)) {
        sendError(res, 404, "AGENT_NOT_FOUND", `Agent not loaded: ${requestedPath}`);
        return;
      }
      try {
        const absPath = resolveScopedAgentPath(project, requestedPath);
        const records = (await Promise.all(
          (await listAgentRevisionRecords(project.root))
            .map((revision) => reconcileAgentRevisionRecord(project, revision))
        ))
          .filter((record) => record.targetAgentRunPath === requestedPath || record.targetAgentPath === absPath);
        sendJSON(res, 200, {
          success: true,
          revisions: records.map(({ proposedSource: _proposed, previousSource: _previous, ...record }) => {
            const params = new URLSearchParams({ project: project.id });
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
    matched = false;
  };
  await run();
  return matched;
}
