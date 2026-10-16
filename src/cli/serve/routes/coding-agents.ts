import { codingAgentStatuses, isCodingAgentId, setUpCodingAgent, type McpTarget } from "../../../onboarding/coding-agents";
import { toErrorMessage } from "../../../utils/error-message.js";
import { canUseHostFolderPicker } from "../../../utils/local-request";
import { parseJSONBody, sendError, sendJSON, sendRequestParseError } from "../http";
import type { ServeContext, ServeRequest } from "../context";

/**
 * `/api/coding-agents`: which coding agents on this computer have AgentUse,
 * and adding it to one. They write the person's own config files, so only a
 * local server answers, and only for a request from this computer.
 */
export async function codingAgentRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath } = rq;
  if (!isApi || (routePath !== "/coding-agents" && routePath !== "/coding-agents/setup")) return false;

  if (!canUseHostFolderPicker(ctx.effectiveHost, req.socket.remoteAddress, req.headers.host)) {
    sendError(res, 403, "CODING_AGENTS_LOCAL_ONLY", "Coding agents can only be set up from a local AgentUse server");
    return true;
  }
  const target: McpTarget = { url: `${ctx.serverUrl.replace(/\/+$/, "")}/mcp`, ...(ctx.apiKey && { apiKey: ctx.apiKey }) };

  if (req.method === "GET" && routePath === "/coding-agents") {
    sendJSON(res, 200, { success: true, agents: await codingAgentStatuses(target) });
    return true;
  }
  if (req.method === "POST" && routePath === "/coding-agents/setup") {
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      sendError(res, 415, "JSON_REQUIRED", "Setting up a coding agent requires a same-origin JSON request");
      return true;
    }
    let body: { id?: unknown };
    try {
      body = await parseJSONBody(req);
    } catch (err) {
      sendRequestParseError(res, err);
      return true;
    }
    if (!isCodingAgentId(body.id)) {
      sendError(res, 400, "UNKNOWN_CODING_AGENT", "Pick Claude Code or Codex");
      return true;
    }
    try {
      sendJSON(res, 200, { success: true, agent: await setUpCodingAgent(body.id, target) });
    } catch (err) {
      sendError(res, 500, "CODING_AGENT_SETUP_FAILED", toErrorMessage(err));
    }
    return true;
  }
  return false;
}
