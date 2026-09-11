/**
 * Project identity + path helpers for the serve daemon.
 *
 * Moved verbatim out of serve.ts so the route modules can resolve project
 * scopes without importing values back out of serve.ts.
 */
import { basename, relative, resolve } from "path";
import { existsSync } from "fs";
import { glob } from "glob";
import * as dotenv from "dotenv";
import { findProjectRoot } from "../../utils/project";
import { expandHome } from "../../utils/global-config";

export interface Project {
  id: string;
  /** Detected project/state root. Owns .agentuse/store, sessions, env, plugins. */
  root: string;
  /** Directory used for agent discovery and relative API agent paths. */
  scopeRoot: string;
  envFile: string;
  agentFiles: string[];
}

export function selectSessionProjects<T extends { id: string }>(
  projects: readonly T[],
  projectId?: string
):
  | { success: true; projects: T[] }
  | { success: false; status: 404; code: 'PROJECT_NOT_FOUND'; message: string } {
  const selected = projectId
    ? projects.filter((project) => project.id === projectId)
    : [...projects];
  if (selected.length > 0) return { success: true, projects: selected };
  return {
    success: false,
    status: 404,
    code: 'PROJECT_NOT_FOUND',
    message: projectId
      ? `Project not found: ${projectId}`
      : 'Project not found for session request',
  };
}

export function resolveScopedAgentPath(project: Project | Omit<Project, 'agentFiles'>, agentPath: string): string {
  return resolve(project.scopeRoot, agentPath);
}

export function toProjectRelativeAgentPath(project: Project | Omit<Project, 'agentFiles'>, agentPath: string): string {
  return relative(project.root, resolveScopedAgentPath(project, agentPath));
}

/**
 * The scope-relative path the agent detail hub addresses, for a session's
 * (absolute) agent file. Returns undefined when the file is not one of the
 * project's loaded agents, so the session page only links where a hub exists.
 */
export function toAgentRunPath(project: Project, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const runPath = relative(project.scopeRoot, filePath);
  return project.agentFiles.includes(runPath) ? runPath : undefined;
}

export function collectDir(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function resolveProjectFromPath(rawPath: string, idOverride?: string): Omit<Project, 'agentFiles'> {
  const scopeRoot = resolve(expandHome(rawPath));
  if (!existsSync(scopeRoot)) {
    throw new Error(`Directory not found: ${scopeRoot}`);
  }
  const root = findProjectRoot(scopeRoot);
  const envLocal = resolve(root, '.env.local');
  const envFile = existsSync(envLocal) ? envLocal : resolve(root, '.env');
  const id = idOverride ?? basename(scopeRoot);
  return { id, root, scopeRoot, envFile };
}

export async function bareServeMigrationWarning(cwd: string): Promise<string | undefined> {
  const [agentFile] = await glob("**/*.agentuse", {
    cwd,
    ignore: ["node_modules/**", "tmp/**", ".git/**"],
    nodir: true,
  });
  if (!agentFile) return undefined;

  return (
    `Warning: no project was loaded. v0.19 no longer adopts the current directory ` +
    `for a bare "agentuse serve" (found ${agentFile}). Restart with ` +
    `"agentuse serve -C ." or add this directory to serve.projects.`
  );
}

export function loadServeProjectEnvironment(projectSeeds: Array<Omit<Project, 'agentFiles'>>): string[] {
  const loaded: string[] = [];
  if (projectSeeds.length === 1 && existsSync(projectSeeds[0].envFile)) {
    dotenv.config({ path: projectSeeds[0].envFile, override: false, quiet: true });
    loaded.push(projectSeeds[0].envFile);
  }

  return loaded;
}
