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
 * Get project storage directory based on git root or global
 * Returns: {xdgData}/agentuse/project/{git-hash}/storage or {xdgData}/agentuse/project/global/storage
 */
export async function getProjectStorageDir(projectRoot: string): Promise<string> {
  const baseDir = path.join(getXdgDataDir(), 'agentuse', 'project');

  const gitRoot = await getGitRoot(projectRoot);

  if (gitRoot) {
    // Hash git root for directory name
    const hash = crypto.createHash('sha256')
      .update(gitRoot)
      .digest('hex')
      .substring(0, 16);
    return path.join(baseDir, hash, 'storage');
  } else {
    // Use global for non-git projects
    return path.join(baseDir, 'global', 'storage');
  }
}

/**
 * Get session storage directory
 */
export async function getSessionStorageDir(projectRoot: string): Promise<string> {
  const storageDir = await getProjectStorageDir(projectRoot);
  return path.join(storageDir, 'session');
}
