import { agentCreationProviders } from "../../../agents/create";
import { discoverProjectSkillCatalog, listProjectFilesForChat, readProjectFileForChat } from "../../../agents/discover";
import { providerSetupSnapshot } from "../../../auth/provider-setup";
import { getMCPAuthState } from "../../../mcp-oauth";
import { parseAgent } from "../../../parser";
import { toErrorMessage } from "../../../utils/error-message.js";
import { logger } from "../../../utils/logger";
import { collectAgents } from "../agents-data";
import { sendError, sendJSON } from "../http";
import { resolveScopedAgentPath } from "../project";
import type { Project } from "../project";
import type { ServeContext, ServeRequest } from "../context";

/**
 * What a chat needs to know about one project before it writes an agent there,
 * and one sandboxed file read. Both sit behind the API-key header gate and are
 * what the MCP tools `get_project` and `read_project_file` call.
 */

const CONTEXT_PARTS = ['agents', 'mcp', 'skills', 'models', 'files'] as const;
type ContextPart = typeof CONTEXT_PARTS[number];
const DEFAULT_PARTS: readonly ContextPart[] = ['agents', 'mcp', 'skills', 'models'];

const READS_PER_MINUTE = 60;
const READ_BYTES_PER_HOUR = 5_000_000;
const readLog: Array<{ at: number; bytes: number }> = [];

/** A shared budget for file reads, so a looping chat cannot drain the project. */
function readBudgetExceeded(now: number): boolean {
  while (readLog.length > 0 && now - readLog[0]!.at > 3_600_000) readLog.shift();
  const lastMinute = readLog.filter((read) => now - read.at <= 60_000).length;
  const lastHourBytes = readLog.reduce((sum, read) => sum + read.bytes, 0);
  return lastMinute >= READS_PER_MINUTE || lastHourBytes >= READ_BYTES_PER_HOUR;
}

async function projectMcpServers(project: Project) {
  const servers = new Map<string, { name: string; transport: 'http' | 'stdio'; host?: string; status: string; usedBy: string[] }>();
  for (const agentFile of project.agentFiles) {
    let config;
    try {
      config = (await parseAgent(resolveScopedAgentPath(project, agentFile))).config;
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      const existing = servers.get(name);
      if (existing) {
        existing.usedBy.push(agentFile);
        continue;
      }
      const url = 'url' in server ? server.url : undefined;
      servers.set(name, {
        name,
        transport: url ? 'http' : 'stdio',
        ...(url && { host: new URL(url).host }),
        status: await getMCPAuthState(server),
        usedBy: [agentFile],
      });
    }
  }
  return [...servers.values()];
}

export async function projectContextRoutes(ctx: ServeContext, rq: ServeRequest): Promise<boolean> {
  const { req, res, isApi, routePath, requestUrl } = rq;
  const match = isApi && req.method === 'GET' ? routePath.match(/^\/projects\/([^/?#]+)\/(context|files)$/) : null;
  if (!match) return false;
  const project = ctx.projectsById.get(decodeURIComponent(match[1]!));
  if (!project) {
    sendError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    return true;
  }

  if (match[2] === 'files') {
    // GET /api/projects/:id/files?path=<file>: one file, through the sandbox.
    const path = requestUrl.searchParams.get('path') ?? '';
    const now = Date.now();
    if (readBudgetExceeded(now)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many file reads. Wait a minute and read only what the task needs.');
      return true;
    }
    const result = await readProjectFileForChat(project.scopeRoot, path);
    if (!result.ok) {
      // One answer for missing, secret, ignored, linked and binary files alike.
      sendError(res, 404, 'NOT_READABLE', 'That file is not readable: it does not exist, or it is skipped for safety');
      return true;
    }
    readLog.push({ at: now, bytes: result.bytes });
    logger.info(`[chat read] ${project.id}/${path} ${result.bytes} bytes${result.redacted ? ', redacted' : ''}`);
    sendJSON(res, 200, { success: true, path, ...result });
    return true;
  }

  // GET /api/projects/:id/context?include=agents,mcp,skills,models,files&path=
  try {
    const requested = (requestUrl.searchParams.get('include') ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    const parts = new Set<ContextPart>(requested.length > 0
      ? requested.filter((part): part is ContextPart => (CONTEXT_PARTS as readonly string[]).includes(part))
      : DEFAULT_PARTS);
    const payload: Record<string, unknown> = { success: true, project: project.id };
    if (parts.has('agents')) {
      const { agents } = await collectAgents([project]);
      payload.agents = agents.map((agent) => ({
        agent: agent.runPath,
        name: agent.name,
        ...(agent.description && { description: agent.description }),
        ...(agent.schedule && { schedule: agent.scheduleHuman ?? agent.schedule }),
      }));
    }
    if (parts.has('mcp')) payload.mcpServers = await projectMcpServers(project);
    if (parts.has('skills')) {
      payload.skills = (await discoverProjectSkillCatalog(project.root)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        ...(skill.allowedTools.length > 0 && { allowedTools: skill.allowedTools }),
        ...(skill.ambiguous && { ambiguous: true }),
      }));
    }
    if (parts.has('models')) {
      const snapshot = await providerSetupSnapshot();
      const providers = await agentCreationProviders(snapshot.status, ctx.preferredAgentCreationModel);
      const available = [...new Set(providers.flatMap((provider) => provider.models))];
      payload.models = { ...(available[0] && { default: providers[0]?.defaultModel ?? available[0] }), available };
    }
    if (parts.has('files')) {
      payload.files = await listProjectFilesForChat(project.scopeRoot, requestUrl.searchParams.get('path') ?? undefined);
    }
    sendJSON(res, 200, payload);
  } catch (error) {
    sendError(res, 500, 'PROJECT_CONTEXT_FAILED', toErrorMessage(error));
  }
  return true;
}
