import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { version as packageVersion } from '../../package.json';
import type { AgentDetail, AgentSummary } from '../cli/serve/agents-data.js';
import type { SessionsPayload } from '../cli/serve/list-payloads.js';
import type { SessionSummary } from '../cli/serve/types.js';
import type { ChangesetFile } from '../agents/changeset-types.js';
import { getApprovalBaseUrl, getSessionUrl } from '../tools/await-human.js';
import { toErrorMessage } from '../utils/error-message.js';
import { McpToolError, type DaemonClient } from './daemon.js';
import { registerAgentUsePrompts } from './prompts.js';

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

/**
 * Every daemon route an MCP tool may call. Apply, discard, approve, schedule
 * and delete routes are not here, so no tool can reach them even by mistake;
 * the operator key the tools carry would otherwise allow it.
 */
const ALLOWED_DAEMON_ROUTES: ReadonlyArray<readonly ['GET' | 'POST', RegExp]> = [
  ['GET', /^$/u],
  ['GET', /^\/agents$/u],
  ['GET', /^\/agents\/detail$/u],
  ['GET', /^\/sessions$/u],
  ['GET', /^\/sessions\/[^/]+$/u],
  ['GET', /^\/projects\/[^/]+\/context$/u],
  ['GET', /^\/projects\/[^/]+\/files$/u],
  ['POST', /^\/run$/u],
  ['POST', /^\/projects\/[^/]+\/changesets$/u],
  // mock-test only: never test-run, which runs non-gated tools for real.
  ['POST', /^\/projects\/[^/]+\/changesets\/[^/]+\/mock-test$/u],
];

function allowlisted(daemon: DaemonClient): DaemonClient {
  const check = (method: 'GET' | 'POST', path: string) => {
    if (!ALLOWED_DAEMON_ROUTES.some(([m, pattern]) => m === method && pattern.test(path))) {
      throw new McpToolError('NOT_ALLOWED', `MCP tools cannot call ${method} /api${path}`);
    }
  };
  return {
    get: (path, query) => { check('GET', path); return daemon.get(path, query); },
    post: (path, body) => { check('POST', path); return daemon.post(path, body); },
  };
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

interface ChatChangesetResponse {
  changeset: {
    sessionId: string;
    status: string;
    proposals: Array<{ index: number; entry?: string; files: Array<Omit<ChangesetFile, 'content' | 'patch'>> }>;
  };
  reviewHref: string;
}

const fileInput = z.array(z.object({
  path: z.string().min(1).max(400).describe('Project-relative, e.g. agents/weekly-digest.agentuse'),
  content: z.string().max(64_000).describe('The whole file'),
})).min(1).max(12);

export function createAgentUseMcpServer(rawDaemon: DaemonClient): McpServer {
  const daemon = allowlisted(rawDaemon);
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

  server.registerTool('get_project', {
    title: 'Get project',
    description: 'What one project already has, so a new agent only uses what exists: its agents, the MCP servers those agents use '
      + '(with login status), installed skills, and the models AgentUse can run. Add "files" to `include` for file names '
      + '(no contents; secrets and ignored files are left out). Call before draft_agent.',
    inputSchema: {
      project: z.string().describe('Project id from list_projects'),
      include: z.array(z.enum(['agents', 'mcp', 'skills', 'models', 'files'])).optional()
        .describe('Default: agents, mcp, skills, models'),
      path: z.string().max(400).optional().describe('With files: list inside this folder only'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ project, include, path }) => {
    const { success: _success, ...context } = await daemon.get<Record<string, unknown>>(
      `/projects/${encodeURIComponent(project)}/context`,
      { include: include?.join(','), path },
    );
    const counts = ['agents', 'mcpServers', 'skills'].flatMap((key) => {
      const value = context[key];
      return Array.isArray(value) ? [`${value.length} ${key === 'mcpServers' ? 'MCP servers' : key}`] : [];
    });
    return ok(`${project}: ${counts.join(', ') || 'context loaded'}`, context);
  }));

  server.registerTool('read_project_file', {
    title: 'Read project file',
    description: 'Read one text file in a project, up to 60 KB, for templates, data headers or script options a new agent must match. '
      + 'Secret-looking values come back redacted. Secret, ignored, binary and linked files are refused with NOT_READABLE. '
      + 'Read only what the task needs.',
    inputSchema: {
      project: z.string().describe('Project id'),
      path: z.string().min(1).max(512).describe('Project-relative path, e.g. reports/template.md'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ project, path }) => {
    const { success: _success, ...file } = await daemon.get<{ success: true; path: string; content: string; truncated: boolean; redacted: boolean }>(
      `/projects/${encodeURIComponent(project)}/files`,
      { path },
    );
    const notes = [file.truncated && 'cut at 60 KB', file.redacted && 'secret-looking values redacted'].filter(Boolean);
    return ok(`${file.content}${notes.length ? `\n\n[${notes.join('; ')}]` : ''}`, file);
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

  /** Save chat-written files as a change set and hand back its review link. */
  const submitChangeset = async (projectId: string, body: Record<string, unknown>) => {
    const client = server.server.getClientVersion()?.name;
    const [result, roots] = await Promise.all([
      daemon.post<ChatChangesetResponse>(`/projects/${encodeURIComponent(projectId)}/changesets`, {
        source: 'chat',
        author: client ? `${client} (chat)` : 'Chat',
        ...body,
      }),
      projectRoots(),
    ]);
    const proposal = result.changeset.proposals.at(-1);
    const reviewUrl = `${getApprovalBaseUrl(roots.get(projectId)).replace(/\/$/u, '')}${result.reviewHref}`;
    return {
      id: result.changeset.sessionId,
      status: result.changeset.status,
      review_url: reviewUrl,
      files: (proposal?.files ?? []).map((file) => ({
        path: file.path,
        op: file.op,
        ...(file.capabilityChanges?.length && { capability_changes: file.capabilityChanges }),
        ...(file.flags?.length && { flags: file.flags }),
      })),
    };
  };

  server.registerTool('draft_agent', {
    title: 'Draft agent',
    description: 'Save a new agent (its .agentuse file plus any helper files) as a draft for the user to review. '
      + 'Nothing runs and nothing goes live: the user opens review_url to test it and turn it on. '
      + 'Files are checked like any AgentUse agent; if they are rejected, fix them and call again. '
      + 'To change a draft after the user comments, call again with its draft_id.',
    inputSchema: {
      project: z.string().describe('Project id'),
      goal: z.string().min(1).max(12_000).describe('What the user wants automated, in their words'),
      summary: z.string().min(1).max(1_000).describe('One plain sentence for the reviewer: what the agent does'),
      entry: z.string().min(1).max(400).describe('Path of the .agentuse file among `files`'),
      files: fileInput,
      schedule: z.string().max(100).optional()
        .describe('When it should run, e.g. "0 8 * * 1-5" (cron) or "2h". Never put schedule: in the file; '
          + 'the review page shows this and Apply turns it on.'),
      draft_id: z.string().optional().describe('Update this draft instead of starting a new one'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async ({ project, goal, summary, entry, files, schedule, draft_id }) => {
    const draft = await submitChangeset(project, {
      mode: 'create', instruction: goal, summary, entry, files,
      ...(schedule && { schedule }),
      ...(draft_id && { changesetId: draft_id }),
    });
    const { id, ...rest } = draft;
    return ok(`Draft saved. The user reviews it and turns it on here:\n${draft.review_url}`, { draft_id: id, ...rest });
  }));

  server.registerTool('test_draft', {
    title: 'Test draft',
    description: 'Practice run of a draft or proposed fix: the agent really reasons through its steps, but every tool call '
      + '(commands, files, MCP, stores) is faked by a mock model and approvals are auto-approved, so nothing on the computer changes. '
      + 'Returns at once; call get_session with the session_id until it finishes, then fix what went wrong and call draft_agent '
      + 'or propose_fix again. A pass means the steps hold together, not that real output will be good. '
      + 'Drafts that start a local MCP server or send keys to one are refused: the user must test those on the review page.',
    inputSchema: {
      project: z.string().describe('Project id'),
      id: z.string().describe('draft_id from draft_agent or fix_id from propose_fix'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async ({ project, id }) => {
    const [{ testRun }, roots] = await Promise.all([
      daemon.post<{ testRun: { sessionId: string } }>(
        `/projects/${encodeURIComponent(project)}/changesets/${encodeURIComponent(id)}/mock-test`,
        {},
      ),
      projectRoots(),
    ]);
    const url = getSessionUrl(testRun.sessionId, roots.get(project));
    return ok(
      `Practice run started: ${testRun.sessionId}. Check it with get_session.${url ? `\n${url}` : ''}`,
      { session_id: testRun.sessionId, project, mock: true, url },
    );
  }));

  server.registerTool('propose_fix', {
    title: 'Propose fix',
    description: 'Propose a change to an existing agent, usually after list_problems and get_session found the cause. '
      + 'Send the whole new file for each file you change. Nothing changes until the user applies it at review_url. '
      + 'Call again with fix_id to revise the proposal.',
    inputSchema: {
      project: z.string().describe('Project id'),
      agent: z.string().describe('The `agent` value from list_agents'),
      problem: z.string().min(1).max(12_000).describe('What is wrong, in plain words'),
      summary: z.string().min(1).max(1_000).describe('One plain sentence: what the fix changes'),
      files: fileInput,
      from_session: z.string().optional().describe('The failed run this fixes'),
      fix_id: z.string().optional().describe('Update this proposal instead of starting a new one'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async ({ project, agent, problem, summary, files, from_session, fix_id }) => {
    const fix = await submitChangeset(project, {
      mode: 'revise',
      target: agent,
      instruction: problem,
      summary,
      entry: agent,
      files,
      ...(from_session && { originSessionId: from_session }),
      ...(fix_id && { changesetId: fix_id }),
    });
    const { id, ...rest } = fix;
    return ok(`Fix proposed. The user reviews and applies it here:\n${fix.review_url}`, { fix_id: id, ...rest });
  }));

  registerAgentUsePrompts(server);
  return server;
}
