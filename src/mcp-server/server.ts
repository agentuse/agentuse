import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { version as packageVersion } from '../../package.json';
import type { AgentDetail, AgentSummary } from '../cli/serve/agents-data.js';
import type { SessionsPayload } from '../cli/serve/list-payloads.js';
import type { SessionSummary } from '../cli/serve/types.js';
import { getSessionUrl } from '../tools/await-human.js';
import { toErrorMessage } from '../utils/error-message.js';
import { McpToolError, type DaemonClient } from './daemon.js';

/**
 * AgentUse as an MCP server: what Claude, ChatGPT and coding agents can call.
 *
 * Rule for every tool here: the chat proposes, a human clicks. Nothing in this
 * file turns an agent on, applies a change, approves a step, or deletes
 * anything. Adding a tool that does goes to Leon first (AGENTS.md).
 */

interface ServerInfoPayload {
  default: string | null;
  projects: Array<{
    id: string;
    path: string;
    agentCount: number;
    about?: { name?: string; description?: string };
  }>;
}

const LIST_LIMIT_MAX = 100;
const PROBLEM_WINDOW = '30d';
const FINAL_RESPONSE_PREVIEW_CHARS = 280;

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(error: unknown): CallToolResult {
  const code = error instanceof McpToolError ? error.code : 'INTERNAL';
  const message = toErrorMessage(error);
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: { code, message } },
  };
}

/** Wrap a handler so daemon failures come back as tool errors the chat can read. */
function guarded<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toolError(error);
    }
  };
}

const preview = (text: string | undefined): string | undefined =>
  text && text.length > FINAL_RESPONSE_PREVIEW_CHARS ? `${text.slice(0, FINAL_RESPONSE_PREVIEW_CHARS)}…` : text;

type SessionRow = SessionSummary & { project: string };

/** A session row cut down to what a chat needs, with a link a person can open.
 *  `agent` is the scope-relative run path (what run_agent takes), never the
 *  absolute file path, which would tell a remote chat the computer's layout. */
function sessionView(row: SessionRow, projectRoots: Map<string, string>) {
  return {
    session_id: row.sessionId,
    project: row.project,
    agent: row.agent.runPath ?? row.agent.id,
    agent_name: row.agent.name,
    status: row.status,
    ...(row.outcome && { outcome: row.outcome }),
    trigger: row.trigger,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
    ...(row.errorCode && { error_code: row.errorCode }),
    ...(row.errorCause && { error_cause: row.errorCause }),
    ...(row.errorMessage && { error_message: row.errorMessage }),
    ...(row.finalResponse && { final_response: preview(row.finalResponse) }),
    url: getSessionUrl(row.sessionId, projectRoots.get(row.project)),
  };
}

export function createAgentUseMcpServer(daemon: DaemonClient): McpServer {
  const server = new McpServer(
    { name: 'agentuse', version: packageVersion },
    {
      instructions:
        'AgentUse runs agents on the user\'s own computer. Use these tools to look at projects, agents and runs, '
        + 'and to start a run the user asked for. Nothing here can turn an agent on, approve a step or change a live '
        + 'agent: those happen when the user clicks a link this server returns.',
    },
  );

  const serverInfo = () => daemon.get<ServerInfoPayload>('');
  const projectRoots = async () => new Map((await serverInfo()).projects.map((p) => [p.id, p.path]));

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'Projects AgentUse serves on this computer: id, name, one-line description, and how many agents each has. Call this first, then work inside one project.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async () => {
    const info = await serverInfo();
    const projects = info.projects.map((p) => ({
      id: p.id,
      name: p.about?.name ?? p.id,
      ...(p.about?.description && { description: p.about.description }),
      agent_count: p.agentCount,
    }));
    const lines = projects.map((p) => `${p.id}: ${p.name}, ${p.agent_count} agent${p.agent_count === 1 ? '' : 's'}`);
    return ok(lines.join('\n') || 'No projects yet.', { projects, ...(info.default && { default: info.default }) });
  }));

  server.registerTool('list_agents', {
    title: 'List agents',
    description: 'Agents in one project or all projects, with schedule and whether the schedule is on. Use the returned `agent` value with get_agent and run_agent.',
    inputSchema: { project: z.string().optional().describe('Project id from list_projects. Omit for all projects.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ project }) => {
    const { agents } = await daemon.get<{ agents: AgentSummary[] }>('/agents');
    const rows = agents
      .filter((agent) => !project || agent.projectId === project)
      .map((agent) => ({
        project: agent.projectId,
        agent: agent.runPath,
        name: agent.name,
        ...(agent.description && { description: agent.description }),
        model: agent.model,
        ...(agent.schedule && { schedule: agent.scheduleHuman ?? agent.schedule }),
        ...(agent.schedule && { schedule_on: agent.scheduleEnabled !== false }),
      }));
    const lines = rows.map((r) => `${r.project}/${r.agent}${r.schedule ? ` (${r.schedule}${r.schedule_on ? '' : ', paused'})` : ''}`);
    return ok(lines.join('\n') || 'No agents found.', { agents: rows });
  }));

  server.registerTool('get_agent', {
    title: 'Get agent',
    description: 'One agent\'s file and what it is allowed to do (tools, approvals, MCP servers, skills). Read this before suggesting a change to it.',
    inputSchema: {
      project: z.string().describe('Project id'),
      agent: z.string().describe('The `agent` value from list_agents'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ project, agent }) => {
    const detail = await daemon.get<AgentDetail & { scheduleEnabled?: boolean }>('/agents/detail', { project, path: agent });
    const structured = {
      project: detail.projectId,
      agent: detail.runPath,
      name: detail.name,
      ...(detail.description && { description: detail.description }),
      model: detail.model,
      ...(detail.schedule && { schedule: detail.scheduleHuman ?? detail.schedule, schedule_on: detail.scheduleEnabled !== false }),
      capabilities: detail.meta,
      ...(detail.source && { source: detail.source }),
    };
    return ok(detail.source || `${detail.name} (source hidden by this server's settings)`, structured);
  }));

  const sessionFilter = {
    project: z.string().optional().describe('Project id. Omit for all projects.'),
    agent: z.string().optional().describe('Only runs of this agent'),
    status: z.enum(['running', 'suspended', 'completed', 'idle', 'error', 'incomplete']).optional()
      .describe('suspended = waiting for a person; error = crashed; incomplete = the agent said it could not finish'),
    window: z.enum(['1h', '6h', '24h', '7d', '30d']).optional().describe('How far back. Default 24h.'),
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional().describe('Default 20'),
  };

  server.registerTool('list_sessions', {
    title: 'List runs',
    description: 'Recent runs, newest first, with status, a short preview of the answer, and a link to each run.',
    inputSchema: sessionFilter,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ project, agent, status, window, limit }) => {
    const [payload, roots] = await Promise.all([
      daemon.get<SessionsPayload>('/sessions', {
        // The daemon matches a substring of the agent id (the path without
        // `.agentuse`); the exact run-path check below drops near misses.
        agent: agent?.replace(/\.agentuse$/u, ''),
        status,
        window: window ?? '24h',
        limit: String(limit ?? 20),
      }),
      projectRoots(),
    ]);
    const sessions = (payload.sessions as SessionRow[])
      .filter((row) => !project || row.project === project)
      .map((row) => sessionView(row, roots))
      .filter((view) => !agent || view.agent === agent);
    const lines = sessions.map((s) => `${s.created_at} ${s.project}/${s.agent} ${s.status} ${s.session_id}`);
    return ok(lines.join('\n') || 'No runs in this window.', { sessions, counts: payload.counts });
  }));

  server.registerTool('get_session', {
    title: 'Get run',
    description: 'One run: status, error, and the full final answer, plus a link to the run page.',
    inputSchema: {
      session_id: z.string().describe('From list_sessions, list_problems or run_agent'),
      project: z.string().optional().describe('Project id, if known'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ session_id, project }) => {
    const [{ session }, roots] = await Promise.all([
      daemon.get<{ session: Record<string, unknown> & { project: string } }>(`/sessions/${encodeURIComponent(session_id)}`, { project }),
      projectRoots(),
    ]);
    const url = getSessionUrl(session_id, roots.get(session.project));
    const structured = { ...session, session_id, url };
    return ok(`Run ${session_id}: ${String(session.status)}${url ? `\n${url}` : ''}`, structured);
  }));

  server.registerTool('list_problems', {
    title: 'List problems',
    description: `Failed and incomplete runs from the last ${PROBLEM_WINDOW} that nobody has dismissed, grouped by agent and cause. Start /triage here.`,
    inputSchema: { project: z.string().optional().describe('Project id. Omit for all projects.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ project }) => {
    const query = (status: string) => ({ status, triage: 'undismissed', window: PROBLEM_WINDOW, limit: String(LIST_LIMIT_MAX) });
    const [errors, incompletes, roots] = await Promise.all([
      daemon.get<SessionsPayload>('/sessions', query('error')),
      daemon.get<SessionsPayload>('/sessions', query('incomplete')),
      projectRoots(),
    ]);
    const groups = new Map<string, { project: string; agent: string; cause: string; count: number; last_at: string; latest: ReturnType<typeof sessionView> }>();
    for (const row of [...errors.sessions, ...incompletes.sessions] as SessionRow[]) {
      if (project && row.project !== project) continue;
      const view = sessionView(row, roots);
      const cause = row.errorCause ?? row.errorCode ?? (row.status === 'error' ? 'error' : 'incomplete');
      const key = `${row.project}\0${view.agent}\0${cause}`;
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { project: row.project, agent: view.agent, cause, count: 1, last_at: view.updated_at, latest: view });
        continue;
      }
      group.count += 1;
      if (view.updated_at > group.last_at) {
        group.last_at = view.updated_at;
        group.latest = view;
      }
    }
    const problems = [...groups.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
    const lines = problems.map((p) => `${p.project}/${p.agent}: ${p.cause} ×${p.count}, latest ${p.latest.session_id}`);
    return ok(lines.join('\n') || `No open problems in the last ${PROBLEM_WINDOW}.`, { problems, window: PROBLEM_WINDOW });
  }));

  server.registerTool('run_agent', {
    title: 'Run agent',
    description: 'Start one run of an existing agent now, the same as pressing Run in the dashboard. Returns at once with the run id and a link; use get_session to check on it. Steps that need approval still wait for a person.',
    inputSchema: {
      project: z.string().describe('Project id'),
      agent: z.string().describe('The `agent` value from list_agents'),
      prompt: z.string().max(12_000).optional().describe('Extra input for this run. Most agents need none.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async ({ project, agent, prompt }) => {
    const [result, roots] = await Promise.all([
      daemon.post<{ sessionId: string }>('/run', { project, agent, ...(prompt && { prompt }), detach: true }),
      projectRoots(),
    ]);
    const url = getSessionUrl(result.sessionId, roots.get(project));
    return ok(`Started ${project}/${agent}: ${result.sessionId}${url ? `\n${url}` : ''}`, { session_id: result.sessionId, project, agent, url });
  }));

  return server;
}
