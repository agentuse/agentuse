import { parseAgent } from "../../../parser";
import { MCPAuthStorage, mcpServerKey } from "../../../auth/mcp-oauth-storage";
import {
  finishMCPLogin,
  getMCPAuthState,
  oauthSettings,
  startMCPLogin,
  type MCPOAuthSettings,
} from "../../../mcp-oauth";
import { toErrorMessage } from "../../../utils/error-message.js";
import { escapeHtml } from "../../../utils/html";
import { collectAgents } from "../agents-data";
import { parseJSONBody, sendError, sendHTML, sendJSON } from "../http";
import { resolveScopedAgentPath } from "../project";
import type { ServeContext, ServeRequest } from "../context";

export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

/** Browser logins this daemon started, by OAuth state. Lost on restart: start again. */
const pendingLogins = new Map<string, { serverUrl: string; settings: MCPOAuthSettings; createdAt: number }>();
const PENDING_LOGIN_TTL_MS = 15 * 60 * 1000;

const callbackPage = (title: string, message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>AgentUse</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
  `<h1 style="font-size:1.25rem;font-weight:500">${escapeHtml(title)}</h1><p style="color:#666">${escapeHtml(message)}</p></body></html>`;

/**
 * Logins for an agent's OAuth MCP servers, so the dashboard (and the Mac app,
 * which shows it) can log in without a terminal. The login itself is keyed by
 * server URL and shared by every agent that uses the same server.
 */
export async function mcpAuthRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, requestUrl, isApi, routePath, requestOrigin, crossOrigin } = rq;
  const { projects, effectivePublicUrl } = ctx;

  const loadAgentServers = async (projectId: unknown, path: unknown) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project || typeof path !== 'string' || !project.agentFiles.includes(path)) return undefined;
    return (await parseAgent(resolveScopedAgentPath(project, path))).config.mcpServers ?? {};
  };

  // GET /api/agents/mcp?project=&path=: each server's login state.
  if (isApi && req.method === 'GET' && routePath === '/agents/mcp') {
    try {
      const servers = await loadAgentServers(requestUrl.searchParams.get('project'), requestUrl.searchParams.get('path'));
      if (!servers) {
        sendError(res, 404, 'AGENT_NOT_FOUND', 'Agent not loaded');
        return true;
      }
      const { agents } = await collectAgents(projects);
      const rows = await Promise.all(Object.entries(servers).map(async ([name, config]) => {
        const url = 'url' in config ? config.url : undefined;
        const key = url && oauthSettings(config) ? mcpServerKey(url) : undefined;
        return {
          name,
          transport: url ? 'http' : 'stdio',
          ...(url && { host: new URL(url).host }),
          auth: await getMCPAuthState(config),
          // Agents other than this one that share the login.
          ...(key && { sharedWith: Math.max(0, agents.filter((a) => a.mcpOAuthServers?.includes(key)).length - 1) }),
        };
      }));
      sendJSON(res, 200, { success: true, servers: rows });
    } catch (err) {
      sendError(res, 500, 'MCP_STATUS_FAILED', toErrorMessage(err));
    }
    return true;
  }

  // POST /api/agents/mcp/login|logout {project, path, server}
  const action = isApi && req.method === 'POST' && routePath.match(/^\/agents\/mcp\/(login|logout)$/)?.[1];
  if (action) {
    try {
      const body = await parseJSONBody(req);
      const servers = await loadAgentServers(body.project, body.path);
      const config = servers?.[String(body.server)];
      const settings = config && oauthSettings(config);
      if (!config || !settings || !('url' in config)) {
        sendError(res, 404, 'MCP_SERVER_NOT_FOUND', 'No OAuth MCP server by that name on this agent');
        return true;
      }
      if (action === 'logout') {
        await MCPAuthStorage.logout(config.url);
        sendJSON(res, 200, { success: true });
        return true;
      }
      // Send the browser back to the origin it loaded the dashboard from;
      // an API client without one gets the configured public URL.
      const origin = requestOrigin && requestOrigin !== 'null' && !crossOrigin ? requestOrigin : effectivePublicUrl;
      const started = await startMCPLogin({
        serverUrl: config.url,
        settings,
        redirectUrl: `${origin.replace(/\/$/, '')}${MCP_OAUTH_CALLBACK_PATH}`,
      });
      const cutoff = Date.now() - PENDING_LOGIN_TTL_MS;
      for (const [state, login] of pendingLogins) if (login.createdAt < cutoff) pendingLogins.delete(state);
      pendingLogins.set(started.state, { serverUrl: config.url, settings, createdAt: Date.now() });
      sendJSON(res, 200, { success: true, authorizationUrl: started.authorizationUrl });
    } catch (err) {
      sendError(res, 502, 'MCP_LOGIN_FAILED', toErrorMessage(err));
    }
    return true;
  }

  // GET /mcp/oauth/callback: where the authorization server sends the browser.
  // Exempt from the API-key gate (the system browser has no key); the
  // single-use state that this daemon issued is what authorizes it.
  if (!isApi && req.method === 'GET' && routePath === MCP_OAUTH_CALLBACK_PATH) {
    const state = requestUrl.searchParams.get('state') ?? '';
    const pending = pendingLogins.get(state);
    if (!pending) {
      sendHTML(res, 400, callbackPage('Login link expired', 'Go back to AgentUse and choose Log in again.'));
      return true;
    }
    pendingLogins.delete(state);
    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');
    try {
      if (error || !code) throw new Error(requestUrl.searchParams.get('error_description') ?? error ?? 'No code was returned');
      const issuer = requestUrl.searchParams.get('iss');
      await finishMCPLogin({ serverUrl: pending.serverUrl, settings: pending.settings, state, code, ...(issuer && { issuer }) });
      sendHTML(res, 200, callbackPage('Logged in', 'You can close this tab and go back to AgentUse.'));
    } catch (err) {
      sendHTML(res, 400, callbackPage("Couldn't log in", toErrorMessage(err)));
    }
    return true;
  }

  return false;
}
