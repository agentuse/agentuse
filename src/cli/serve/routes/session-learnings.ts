import { LearningStore, effectiveCap, saveManualLearning } from "../../../learning";
import type { LearningConfig } from "../../../learning";
import { parseAgent } from "../../../parser";
import { toErrorMessage } from "../../../utils/error-message.js";
import { resolveProjectContext } from "../../../utils/project";
import { isOperatorRequest } from "../auth";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import { learningListPayload, sessionTidyTarget } from "../learnings-payload";
import type { Project } from "../project";
import { buildRunTranscript, sessionLearningTargetAgent } from "../session-lists";
import { WorkerApprovalInfoResult } from "../session-types";
import { dirname } from "path";
import type { ServeContext, ServeRequest } from "../context";

/**
 * The learnings panel on a session page: what this run's agent has captured,
 * plus adding and discarding from that view.
 */
export async function sessionLearningRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath, sessionAuthorized } = rq;
  const {
    apiKey,
    findSessionInfo,
  } = ctx;
  // Verbatim slice of the original route chain. A `return` in here meant
  // "request answered", exactly as it did inside the server callback; falling
  // off the end means nothing matched and the next group gets its turn.
  let matched = true;
  const run = async (): Promise<void> => {

    // Learnings for a session's agent. Reading and editing follow the same
    // trust boundary as the session log (local, session token, or API key);
    // adding a manual rule is the reviewer's explicit opt-in.
    const resolveSessionLearningStore = async (
      info: WorkerApprovalInfoResult,
    ): Promise<{ store: LearningStore; config: LearningConfig | undefined; filePath: string } | null> => {
      const targetAgent = sessionLearningTargetAgent(info.approval);
      if (!targetAgent.filePath) return null;
      const agent = await parseAgent(targetAgent.filePath);
      // Same agent-file-derived state root the agent-level endpoints use, so
      // the session view and the agent view address one corrections file.
      const stateRoot = resolveProjectContext(dirname(targetAgent.filePath), {
        agentFilePath: targetAgent.filePath,
      }).stateRoot;
      return {
        store: LearningStore.fromAgentFile(targetAgent.filePath, stateRoot, agent.name),
        config: agent.config.learning,
        filePath: targetAgent.filePath,
      };
    };

    /**
     * The session-scoped list: this run's captures, plus the whole-store
     * counts and the offer to tidy it.
     *
     * The list is narrowed to the session but the tidy-up is not, and that
     * is deliberate. The reviewer who just left a correction is the person
     * who needs to know it will not reach the agent, and this is the page
     * they are on; sending them to find the agent hub to act on it is how
     * the warning went unread. The banner above the list already speaks
     * about the whole store, so the button belongs with it.
     */
    const sessionLearningPayload = (
      project: Project,
      resolved: NonNullable<Awaited<ReturnType<typeof resolveSessionLearningStore>>>,
      sessionId: string,
      allowTidy: boolean,
    ) =>
      learningListPayload(resolved.store, {
        forSessionId: sessionId,
        config: resolved.config,
        stateRoot: resolveProjectContext(dirname(resolved.filePath), { agentFilePath: resolved.filePath }).stateRoot,
        agentFilePath: resolved.filePath,
        ...(allowTidy ? { tidyTarget: sessionTidyTarget(project, resolved.filePath) } : {}),
      });

    // GET /sessions/:id/learnings: list the learnings captured in this session.
    const sessionLearningsMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/learnings$/) : null;
    if (sessionLearningsMatch) {
      try {
        const sessionId = decodeURIComponent(sessionLearningsMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const projectId = requestUrl.searchParams.get('project') ?? undefined;
        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }
        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const resolved = await resolveSessionLearningStore(found.info);
        const allowTidy = isOperatorRequest(req.headers.authorization, apiKey);
        sendJSON(res, 200, resolved
          ? await sessionLearningPayload(found.project, resolved, sessionId, allowTidy)
          : { success: true, learnings: [] });
      } catch (err) {
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/learnings: add a manual rule (standalone, no resume).
    const sessionAddLearningMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/learnings$/) : null;
    if (sessionAddLearningMatch) {
      try {
        const sessionId = decodeURIComponent(sessionAddLearningMatch[1]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }
        if (!isOperatorRequest(req.headers.authorization, apiKey)) {
          sendError(res, 403, "OPERATOR_REQUIRED", "Changing an agent's learnings needs the API key");
          return;
        }
        if (!instruction) {
          sendError(res, 400, "INSTRUCTION_REQUIRED", "A rule to remember is required");
          return;
        }
        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const targetAgent = found.info.approval.originAgent ?? found.info.approval.agent;
        if (!targetAgent.filePath) {
          sendError(res, 400, "NO_AGENT_FILE", "This session does not record an agent file path");
          return;
        }
        const agent = await parseAgent(targetAgent.filePath);
        const rememberStateRoot = resolveProjectContext(dirname(targetAgent.filePath), {
          agentFilePath: targetAgent.filePath,
        }).stateRoot;
        await saveManualLearning({ agentFilePath: targetAgent.filePath, stateRoot: rememberStateRoot, instruction, model: agent.config.model, agentInstructions: agent.instructions, sessionTranscript: buildRunTranscript(found.info.approval.logs), sessionId, cap: effectiveCap(agent.config.learning) });
        // Redraw through the same builder as the GET: a rule added by hand
        // can be the one that pushes the store past the cap, and a response
        // that dropped the tidy target would take the button away at the
        // moment it started to matter.
        const resolved = await resolveSessionLearningStore(found.info);
        const allowTidy = isOperatorRequest(req.headers.authorization, apiKey);
        sendJSON(res, 200, resolved
          ? await sessionLearningPayload(found.project, resolved, sessionId, allowTidy)
          : { success: true, learnings: [] });
      } catch (err) {
        if (sendRequestParseError(res, err)) return;
        sendError(res, 400, "INVALID_REQUEST", toErrorMessage(err));
      }
      return;
    }

    // POST /sessions/:id/learnings/:lid/discard: drop a stored learning.
    const sessionDiscardLearningMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/learnings\/([^/?#]+)\/discard$/) : null;
    if (sessionDiscardLearningMatch) {
      try {
        const sessionId = decodeURIComponent(sessionDiscardLearningMatch[1]);
        const learningId = decodeURIComponent(sessionDiscardLearningMatch[2]);
        const token = requestUrl.searchParams.get('token') ?? undefined;
        const body = await parseJSONBody(req);
        const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
        if (!sessionAuthorized(sessionId, token)) {
          sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
          return;
        }
        if (!isOperatorRequest(req.headers.authorization, apiKey)) {
          sendError(res, 403, "OPERATOR_REQUIRED", "Changing an agent's learnings needs the API key");
          return;
        }
        const found = await findSessionInfo(sessionId, projectId);
        if (!found.success) {
          sendError(res, found.status, found.code, found.message);
          return;
        }
        const resolved = await resolveSessionLearningStore(found.info);
        if (resolved) await resolved.store.remove(learningId);
        const allowTidy = isOperatorRequest(req.headers.authorization, apiKey);
        sendJSON(res, 200, resolved
          ? await sessionLearningPayload(found.project, resolved, sessionId, allowTidy)
          : { success: true, learnings: [] });
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
