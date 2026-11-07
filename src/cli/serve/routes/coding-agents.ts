import { codingAgentStatuses, codingAgentTarget, isCodingAgentId, setUpCodingAgent } from "../../../onboarding/coding-agents";
import { readCloudConnection } from "../../../cloud/config";
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
  // An unreadable cloud.json counts as not connected, as on /api/cloud.
  const cloud = (() => { try { return readCloudConnection(); } catch { return undefined; } })();
  const target = codingAgentTarget({ url: `${ctx.serverUrl.replace(/\/+$/, "")}/mcp`, ...(ctx.apiKey && { apiKey: ctx.apiKey }) }, cloud);
  const via = cloud ? "cloud" : "this-mac";

  if (req.method === "GET" && routePath === "/coding-agents") {
    sendJSON(res, 200, { success: true, via, agents: await codingAgentStatuses(target) });
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
      sendJSON(res, 200, { success: true, via, agent: await setUpCodingAgent(body.id, target) });
    } catch (err) {
      sendError(res, 500, "CODING_AGENT_SETUP_FAILED", toErrorMessage(err));
    }
    return true;
  }
  return false;
}
