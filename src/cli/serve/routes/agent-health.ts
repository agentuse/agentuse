import { toErrorMessage } from "../../../utils/error-message.js";
import { agentPace, latestRunFailed, type AgentPace } from "../delivery-pace";
import { sendError, sendJSON } from "../http";
import { toAgentRunPath } from "../project";
import type { ServeContext, ServeRequest } from "../context";
import type { SessionSummary } from "../list-payloads";

/** Deliveries this far back set an agent's usual pace. */
const PACE_WINDOW_MS = 30 * 24 * 3_600_000;

/**
 * GET /api/agent-health: per agent that ran in the last 30 days, whether its
 * newest run failed, and, for agents on a running schedule, when it last
 * delivered against its usual pace (serve/delivery-pace.ts). Paused schedules
 * get no pace: a paused agent is not expected to deliver.
 */
export async function agentHealthRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  if (!isApi || req.method !== 'GET' || routePath !== '/agent-health') return false;
  const { projectsById, workers, scheduler } = ctx;
  try {
    const now = Date.now();
    const scheduled = new Set(
      scheduler.listSerialized()
        .filter((s) => s.enabled && s.nextRun)
        .map((s) => `${s.projectId}::${s.agentPath}`),
    );
    const agents: Array<{
      project: string;
      path: string;
      name: string;
      lastRun?: { at: number; failed: boolean };
      pace?: AgentPace;
    }> = [];
    const errors: Array<{ projectId: string; message: string }> = [];
    await Promise.all([...projectsById.values()].map(async (project) => {
      const worker = workers.get(project.id);
      if (!worker) {
        errors.push({ projectId: project.id, message: 'Worker unavailable' });
        return;
      }
      const listed = await worker.listSessions(project.root, { updatedAfter: now - PACE_WINDOW_MS });
      if (!listed.success) {
        errors.push({ projectId: project.id, message: listed.error.message });
        return;
      }
      const byAgent = new Map<string, SessionSummary[]>();
      for (const run of listed.sessions) {
        const path = toAgentRunPath(project, run.agent.filePath);
        if (!path) continue;
        byAgent.set(path, [...(byAgent.get(path) ?? []), run]);
      }
      for (const [path, runs] of byAgent) {
        const lastRun = latestRunFailed(runs);
        const pace = scheduled.has(`${project.id}::${path}`) ? agentPace(runs, now) : undefined;
        agents.push({ project: project.id, path, name: runs[0]!.agent.name, ...(lastRun && { lastRun }), ...(pace && { pace }) });
      }
    }));
    sendJSON(res, 200, { success: true, agents, errors });
  } catch (error) {
    sendError(res, 500, 'AGENT_HEALTH_FAILED', toErrorMessage(error));
  }
  return true;
}
