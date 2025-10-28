import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Get XDG data directory (using Linux XDG conventions on all platforms)
 * Returns ~/.local/share or $XDG_DATA_HOME if set
 */
export function getXdgDataDir(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

/**
 * Get git root directory if in a git repo
 */
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { execSync } = await import('child_process');
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return gitRoot;
  } catch {
    return null;
  }
}

/**
 * Get project directory based on git root or global
 * Returns: {xdgData}/agentuse/project/{git-hash} or {xdgData}/agentuse/project/global
 */
export async function getProjectDir(projectRoot: string): Promise<string> {
  const baseDir = path.join(getXdgDataDir(), 'agentuse', 'project');

  const gitRoot = await getGitRoot(projectRoot);

  if (gitRoot) {
    // Hash git root for directory name
    const hash = crypto.createHash('sha256')
      .update(gitRoot)
      .digest('hex')
      .substring(0, 16);
    return path.join(baseDir, hash);
  } else {
    // Use global for non-git projects
    return path.join(baseDir, 'global');
  }
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
