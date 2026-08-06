import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';

/**
 * Get XDG data directory (using Linux XDG conventions on all platforms)
 * Returns ~/.local/share or $XDG_DATA_HOME if set
 */
export function getXdgDataDir(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

/**
 * Memoized per resolved directory. `git rev-parse` forks a process, and a
 * long-lived serve daemon resolves the same handful of roots on every run,
 * every learnings read and every session write. A repository's toplevel does
 * not move while a process is alive, so the one fork per root is enough.
 */
const gitRootCache = new Map<string, string | null>();

/**
 * Get git root directory if in a git repo.
 *
 * Synchronous because it always was: the async variant below only ever awaited
 * a dynamic `import('child_process')` around a blocking `execSync`.
 */
export function getGitRootSync(cwd: string): string | null {
  const key = path.resolve(cwd);
  const cached = gitRootCache.get(key);
  if (cached !== undefined) return cached;

  let gitRoot: string | null;
  try {
    gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: key,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
  } catch (error) {
    // Only "git ran and said no" is a durable answer worth caching. A fork that
    // never got off the ground (EAGAIN, EMFILE under fleet pressure) has no
    // `status`, and caching its null would move the project's ENTIRE state
    // directory — sessions, corrections, snapshots — to the non-git digest for
    // the rest of the process. In a serve daemon that is the rest of the day,
    // and every fresh CLI process would keep reading the git-rooted directory
    // and report nothing there. Return null for this call, remember nothing.
    if (typeof (error as { status?: unknown }).status !== 'number') return null;
    gitRoot = null;
  }
  gitRootCache.set(key, gitRoot);
  return gitRoot;
}

/**
 * Async wrapper kept for the existing callers. Delegates rather than
 * duplicating, so the two can never disagree about a root.
 */
export async function getGitRoot(cwd: string): Promise<string | null> {
  return getGitRootSync(cwd);
}

/**
 * Get project directory based on git root or project-root hash.
 * Returns: {xdgData}/agentuse/project/{hash}
 * Hash source: git root when available, otherwise the absolute project root.
 * The non-git branch previously returned `project/global`, which collided across
 * multiple non-git projects served by the same process.
 */
export function getProjectDirSync(projectRoot: string): string {
  const baseDir = path.join(getXdgDataDir(), 'agentuse', 'project');

  const gitRoot = getGitRootSync(projectRoot);
  const source = gitRoot ?? path.resolve(projectRoot);

  const hash = crypto.createHash('sha256')
    .update(source)
    .digest('hex')
    .substring(0, 16);
  return path.join(baseDir, hash);
}

/**
 * Async wrapper over {@link getProjectDirSync}. Sessions resolve their storage
 * through here and learnings resolve it synchronously; both must land in the
 * same directory, so there is exactly one implementation of the digest.
 */
export async function getProjectDir(projectRoot: string): Promise<string> {
  return getProjectDirSync(projectRoot);
}

/**
 * Get session storage directory
 * Returns: {xdgData}/agentuse/project/{git-hash}/session
 */
export async function getSessionStorageDir(projectRoot: string): Promise<string> {
  const projectDir = await getProjectDir(projectRoot);
  return path.join(projectDir, 'session');
}

/**
 * Sanitize agent name for use in filesystem paths
 * Converts to lowercase and replaces invalid characters with hyphens
 */
export function sanitizeAgentName(name: string): string {
  if (!name || name.trim() === '') {
    return 'default';
  }

  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')  // Replace invalid chars with hyphen
    .replace(/-+/g, '-')            // Collapse multiple hyphens
    .replace(/^-|-$/g, '')          // Remove leading/trailing hyphens
    || 'default';                   // Fallback if result is empty
}
