/**
 * Agent summary + detail collection for the /agents endpoints.
 *
 * Moved verbatim out of serve.ts so the agents route module can build its
 * payloads without importing values back out of serve.ts.
 */
import { dirname, relative, resolve } from "path";
import { readFile, stat } from "fs/promises";
import { parseAgent } from "../../parser";
import { formatScheduleHuman } from "../../scheduler/parser";
import { mapLimit } from "../../utils/concurrency.js";
import { toErrorMessage } from "../../utils/error-message.js";
import { readAbout, type AboutInfo } from "./about";
import { resolveScopedAgentPath, toProjectRelativeAgentPath, type Project } from "./project";

export interface AgentSummary {
  projectId: string;
  /** Path relative to the project root (tree layout + `?agent=` filter). */
  path: string;
  /** Scope-relative path, the exact `agent` value POST /run accepts. */
  runPath: string;
  name: string;
  description?: string;
  model: string;
  /** Raw schedule expression when the agent declares one. */
  schedule?: string;
  /** Human-readable form of `schedule` (e.g. "At 09:00 AM, only on Monday"). */
  scheduleHuman?: string;
  /** Runtime state of the declared schedule; false when locally paused. */
  scheduleEnabled?: boolean;
  /** Free-form frontmatter `metadata:`, passed through untouched for the UI. */
  metadata?: Record<string, unknown>;
  /** Declared subagent targets, normalized project-relative (see serve/types). */
  subagents?: string[];
  /** Advisory `dependsOn` targets, normalized project-relative (never runtime). */
  dependsOn?: string[];
  /** Shared store name when `store:` is a string; isolated (`true`) omitted. */
  store?: string;
  /** Frontmatter `type:` when declared (currently only 'manager'). */
  type?: string;
  /** Server-computed relationship lint findings (dangling/self/cycle). */
  warnings?: string[];
}

export interface CollectAgentsResult {
  agents: AgentSummary[];
  errors: Array<{ projectId: string; path: string; message: string }>;
}

export type CachedAgentSummary =
  | { mtimeMs: number; size: number; summary: AgentSummary }
  | { mtimeMs: number; size: number; error: string };
export const agentSummaryCache = new Map<string, CachedAgentSummary>();

/**
 * Parse every loaded agent file and summarize it for the /agents endpoint.
 * Parse errors are collected per-agent rather than failing the whole request.
 */
export async function collectAgents(projects: Project[]): Promise<CollectAgentsResult> {
  const agents: AgentSummary[] = [];
  const errors: CollectAgentsResult['errors'] = [];
  // One stat + parse per agent file, and a cold cache parses every one of them.
  // Sequential awaits made that latency additive across the whole fleet, so fan
  // the per-file work out and fold the ordered results afterwards.
  const files = projects.flatMap((project) =>
    project.agentFiles.map((agentFile) => ({ project, agentFile })),
  );
  type CollectedAgent =
    | { ok: true; summary: AgentSummary }
    | { ok: false; projectId: string; path: string; message: string };
  const collected = await mapLimit(files, 16, async ({ project, agentFile }): Promise<CollectedAgent> => {
      try {
        const absPath = resolveScopedAgentPath(project, agentFile);
        const fileStat = await stat(absPath);
        const cached = agentSummaryCache.get(absPath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
          if ('error' in cached) return { ok: false, projectId: project.id, path: agentFile, message: cached.error };
          return { ok: true, summary: { ...cached.summary, projectId: project.id, path: toProjectRelativeAgentPath(project, agentFile), runPath: agentFile } };
        }
        const parsed = await parseAgent(absPath);
        // Relationship targets normalize to the same project-relative notation
        // as `path`, so the client can match edges by string equality. Targets
        // escaping the project root keep their `../` form and render as
        // external ghosts rather than resolving to another row.
        const agentDir = dirname(absPath);
        const toRel = (p: string) => relative(project.root, resolve(agentDir, p));
        const subagents = parsed.config.subagents?.map((s) => toRel(s.path));
        const dependsOn = parsed.config.dependsOn?.map(toRel);
        const summary: AgentSummary = {
          projectId: project.id,
          path: toProjectRelativeAgentPath(project, agentFile),
          runPath: agentFile,
          name: parsed.name,
          ...(parsed.config.description && { description: parsed.config.description }),
          model: parsed.config.model,
          ...(parsed.config.schedule && { schedule: parsed.config.schedule, scheduleHuman: formatScheduleHuman(parsed.config.schedule) }),
          ...(parsed.config.metadata && { metadata: parsed.config.metadata }),
          ...(subagents?.length && { subagents }),
          ...(dependsOn?.length && { dependsOn }),
          ...(typeof parsed.config.store === 'string' && { store: parsed.config.store }),
          ...(parsed.config.type && { type: parsed.config.type }),
        };
        agentSummaryCache.set(absPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary });
        return { ok: true, summary };
      } catch (err) {
        return { ok: false, projectId: project.id, path: agentFile, message: toErrorMessage(err) };
      }
  });
  for (const entry of collected) {
    if (entry.ok) agents.push(entry.summary);
    else errors.push({ projectId: entry.projectId, path: entry.path, message: entry.message });
  }
  agents.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.path.localeCompare(b.path));
  annotateRelationshipWarnings(agents);
  return { agents, errors };
}

/** Add local scheduler state at response time so cached file summaries never
 * freeze a pause/resume choice made after the agent was parsed. */
export function annotateAgentScheduleStates(
  agents: AgentSummary[],
  projects: Project[],
  scheduleIsEnabled: (project: Project, agentPath: string) => boolean,
): void {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const agent of agents) {
    if (!agent.schedule) continue;
    const project = projectsById.get(agent.projectId);
    if (project) agent.scheduleEnabled = scheduleIsEnabled(project, agent.runPath);
  }
}

/**
 * Cross-row lint for declared `dependsOn` edges: dangling targets, self
 * references, and cycles. Computed per request over the assembled list (cheap,
 * in-memory) rather than cached per file, because every finding depends on
 * OTHER rows existing — a cached warning would go stale when a neighbor is
 * added or deleted. Mutates rows in place; `warnings` is absent when clean.
 */
export function annotateRelationshipWarnings(agents: AgentSummary[]): void {
  const byProject = new Map<string, Map<string, AgentSummary>>();
  for (const agent of agents) {
    let rows = byProject.get(agent.projectId);
    if (!rows) byProject.set(agent.projectId, rows = new Map());
    rows.set(agent.path, agent);
    delete agent.warnings; // cached rows may carry findings from a previous pass
  }
  for (const agent of agents) {
    if (!agent.dependsOn) continue;
    const rows = byProject.get(agent.projectId)!;
    const warnings: string[] = [];
    for (const target of agent.dependsOn) {
      if (target === agent.path) warnings.push('dependsOn includes itself');
      else if (target.startsWith('..')) continue; // outside the project: rendered as external, not lintable
      else if (!rows.has(target)) warnings.push(`dependsOn target not found: ${target}`);
    }
    if (warnings.length) agent.warnings = warnings;
  }
  // Cycle pass: DFS over dependsOn edges within each project.
  for (const rows of byProject.values()) {
    const state = new Map<string, 'visiting' | 'done'>();
    const flagCycle = (path: string, stack: string[]): void => {
      const s = state.get(path);
      if (s === 'done') return;
      if (s === 'visiting') {
        for (const member of stack.slice(stack.indexOf(path))) {
          const row = rows.get(member)!;
          const note = 'dependsOn forms a cycle';
          if (!row.warnings?.includes(note)) (row.warnings ??= []).push(note);
        }
        return;
      }
      state.set(path, 'visiting');
      stack.push(path);
      for (const target of rows.get(path)?.dependsOn ?? []) {
        if (rows.has(target)) flagCycle(target, stack);
      }
      stack.pop();
      state.set(path, 'done');
    };
    for (const path of rows.keys()) flagCycle(path, []);
  }
}

/**
 * ABOUT.md files describing the directories the agents page renders (#156):
 * every project root (as path '.') plus each project-relative folder that
 * groups agents, ancestors included so nested groups can carry names too.
 * Only directories that actually have the file get an entry; the rest keep
 * rendering as ids and paths. Display identity only, never behavior.
 */
export async function collectDirAbouts(
  projects: Project[],
  agents: AgentSummary[]
): Promise<Array<{ projectId: string; path: string; about: AboutInfo }>> {
  // NOTE: keys use dirname() output, matched client-side against
  // agent.path.lastIndexOf('/'): both derive from the same relative() paths,
  // which are POSIX-separated everywhere serve runs today (mirrors the
  // pre-existing '/' assumption in agents.tsx agentDirectory()).
  const dirsByProject = new Map<string, Set<string>>(projects.map((p) => [p.id, new Set(['.'])]));
  for (const agent of agents) {
    let dir = dirname(agent.path);
    const dirs = dirsByProject.get(agent.projectId);
    if (!dirs) continue;
    while (dir && dir !== '.' && dir !== '/' && !dir.startsWith('..')) {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  const out: Array<{ projectId: string; path: string; about: AboutInfo }> = [];
  await Promise.all(projects.map(async (project) => {
    const dirs = dirsByProject.get(project.id) ?? new Set<string>();
    await Promise.all([...dirs].map(async (dir) => {
      const about = await readAbout(resolve(project.root, dir));
      if (about) out.push({ projectId: project.id, path: dir, about });
    }));
  }));
  out.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.path.localeCompare(b.path));
  return out;
}

/**
 * Curated, display-ready view of an agent's capabilities for the detail page.
 * A summary of the parsed config (NOT the raw config) so the UI can render
 * "what can this thing touch / how does it run" without re-deriving it.
 */
export interface AgentDetailMeta {
  filesystem?: string[];          // permissions in use: read | write | edit
  bashCommands?: number;          // count of auto-run bash command patterns (commands)
  gated?: string[];               // bash patterns that run only after human approval
  awaitHuman?: boolean;           // tools.await_human gate
  skills: { auto: boolean; trusted: boolean; explicit: string[] };
  mcpServers: string[];
  subagents: string[];
  approval?: boolean;             // declarative suspension gate present
  channels: string[];             // external surfaces, e.g. slack
  timeout?: number;
  maxSteps?: number;
  version?: string;
}

export interface AgentDetail {
  projectId: string;
  path: string;
  runPath: string;
  name: string;
  description?: string;
  model: string;
  schedule?: string;
  scheduleHuman?: string;
  metadata?: Record<string, unknown>;
  source: string;
  meta: AgentDetailMeta;
}

/** Parse one agent and build its detail payload (capabilities + raw source). */
export async function collectAgentDetail(project: Project, runPath: string): Promise<AgentDetail> {
  const absPath = resolveScopedAgentPath(project, runPath);
  const [parsed, source] = await Promise.all([parseAgent(absPath), readFile(absPath, 'utf8')]);
  const config = parsed.config;

  const fsPerms = new Set<string>();
  for (const entry of config.tools?.filesystem ?? []) {
    for (const perm of entry.permissions) fsPerms.add(perm);
  }
  const skills = config.skills ?? { auto: true, trusted: false, explicit: {} };

  const meta: AgentDetailMeta = {
    ...(fsPerms.size > 0 && { filesystem: ['read', 'write', 'edit'].filter((p) => fsPerms.has(p)) }),
    ...(config.tools?.bash && { bashCommands: config.tools.bash.commands.length }),
    ...(config.tools?.bash?.gated?.length && { gated: config.tools.bash.gated }),
    ...(config.tools?.await_human && { awaitHuman: true }),
    skills: { auto: skills.auto, trusted: skills.trusted, explicit: Object.keys(skills.explicit ?? {}) },
    mcpServers: Object.keys(config.mcpServers ?? {}),
    subagents: (config.subagents ?? []).map((s) => s.name || s.path),
    ...(config.approval && { approval: true }),
    channels: Object.keys(config.channels ?? {}),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.maxSteps !== undefined && { maxSteps: config.maxSteps }),
    ...(config.version && { version: config.version }),
  };

  return {
    projectId: project.id,
    path: toProjectRelativeAgentPath(project, runPath),
    runPath,
    name: parsed.name,
    ...(config.description && { description: config.description }),
    model: config.model,
    ...(config.schedule && {
      schedule: config.schedule,
      scheduleHuman: formatScheduleHuman(config.schedule),
    }),
    ...(config.metadata && { metadata: config.metadata }),
    source,
    meta,
  };
}

/**
 * Strip the raw `.agentuse` body from a detail payload (serve.hideAgentSource):
 * the capabilities summary stays, `source` is replaced by `sourceHidden: true`
 * so the web UI knows to drop the Source tab rather than render an empty one.
 */
export function redactAgentDetailSource(detail: AgentDetail): Omit<AgentDetail, 'source'> & { sourceHidden: true } {
  const { source: _source, ...rest } = detail;
  return { ...rest, sourceHidden: true };
}
