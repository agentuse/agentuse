import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { httpDaemonClient } from "../../../mcp-server/daemon";
import { createAgentUseMcpServer } from "../../../mcp-server/server";
import { cloudDashboardLink, requestActor } from "../../../cloud/relay";
import { serverBaseUrl } from "../../../utils/server-registry";
import { toErrorMessage } from "../../../utils/error-message";
import { logger } from "../../../utils/logger";
import { sendError, sendJSON } from "../http";
import { readCloudConnection } from "../../../cloud/config";
import { activeTunnel } from "../../../cloud/tunnel";
import type { ServeContext, ServeRequest } from "../context";

/**
 * `/mcp`: AgentUse as a remote MCP server (Streamable HTTP, stateless), for
 * Claude Code and other clients that can reach this daemon. It sits behind the
 * same API-key header gate as the rest of the operator surface.
 *
 * The tools call this daemon's own `/api` over loopback with the operator key,
 * so they see exactly what the dashboard sees and pass the same checks. The
 * relay will forward to this same handler.
 */
export async function mcpServerRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, routePath, isApi } = rq;
  // GET /api/cloud: this daemon's line to AgentUse Cloud, for `agentuse status` and the Mac app.
  if (isApi && req.method === "GET" && routePath === "/cloud") {
    const connection = (() => { try { return readCloudConnection(); } catch { return undefined; } })();
    sendJSON(res, 200, {
      success: true,
      ...(activeTunnel.current?.state ?? { status: "not connected" }),
      ...(connection && { account: connection.account, name: connection.name, mcpUrl: connection.mcpUrl, url: connection.url }),
    });
    return true;
  }
  if (routePath !== "/mcp") return false;

  const { serverUrl, apiKey } = ctx;
  const self = new URL(serverUrl);
  const baseUrl = serverBaseUrl({ host: self.hostname.replace(/^\[|\]$/g, ""), port: Number(self.port) });
  const daemon = httpDaemonClient(() => baseUrl, (extra: Record<string, string>) => ({
    Accept: "application/json",
    ...extra,
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
  }));

  // Stateless: a fresh server and transport per request. No sessionIdGenerator
  // means no Mcp-Session-Id, which the relay relies on.
  const connection = requestActor(req.headers).via === "cloud"
    ? (() => { try { return readCloudConnection(); } catch { return undefined; } })()
    : undefined;
  const server = createAgentUseMcpServer(daemon, connection ? { link: (url) => cloudDashboardLink(url, connection) } : {});
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    // The SDK declares onclose optional on the class but required on Transport
    // under exactOptionalPropertyTypes; the runtime contract is the same.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    logger.warn(`MCP request failed: ${toErrorMessage(error)}`);
    if (!res.headersSent) sendError(res, 500, "MCP_FAILED", "The MCP request failed");
  }
  return true;
}
