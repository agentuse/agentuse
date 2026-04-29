import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join, isAbsolute, resolve as resolvePath } from 'path';
import { mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { getPluginCacheDir } from '../storage/paths';
import { logger } from '../utils/logger';
import type { PluginSpec } from './types';

const execFileP = promisify(execFile);

/**
 * Resolve a plugin spec to a local directory containing the plugin.
 * For git specs, clones into the user-level cache (idempotent).
 */
export async function resolvePluginSpec(spec: PluginSpec, baseDir: string): Promise<string> {
  if (spec.kind === 'local') {
    return resolveLocalPath(spec.path, baseDir);
  }

  const repoDir = await ensureGitRepo(spec);
  return spec.subpath ? join(repoDir, spec.subpath) : repoDir;
}

function resolveLocalPath(p: string, baseDir: string): string {
  let expanded = p;
  if (expanded.startsWith('~')) {
    expanded = join(homedir(), expanded.slice(1));
  }
  if (isAbsolute(expanded)) return expanded;
  return resolvePath(baseDir, expanded);
}

async function ensureGitRepo(spec: PluginSpec & { kind: 'git' }): Promise<string> {
  const cacheRoot = await getPluginCacheDir();
  const host = spec.host === 'github' ? 'github.com' : safeHost(spec.url ?? 'git');
  const refDir = sanitizeRefForFs(spec.ref ?? 'HEAD');
  const target = join(cacheRoot, host, spec.owner, `${spec.repo}@${refDir}`);

  if (existsSync(target) && (await isNonEmptyDir(target))) {
    logger.debug(`[plugin-bundle] cache hit: ${spec.raw} → ${target}`);
    return target;
  }

  await mkdir(join(cacheRoot, host, spec.owner), { recursive: true });
  const url = spec.url ?? `https://github.com/${spec.owner}/${spec.repo}.git`;

  logger.debug(`[plugin-bundle] cloning ${url} (ref=${spec.ref ?? 'default'}) → ${target}`);

  // Shallow clone, then optionally checkout ref.
  const cloneArgs = ['clone', '--depth', '1'];
  if (spec.ref && isLikelyBranchOrTag(spec.ref)) {
    cloneArgs.push('--branch', spec.ref);
  }
  cloneArgs.push(url, target);

  try {
    await execFileP('git', cloneArgs, { timeout: 120_000 });
  } catch (e) {
    // Retry without --branch (could be a SHA).
    if (spec.ref) {
      try {
        await execFileP('git', ['clone', url, target], { timeout: 120_000 });
        await execFileP('git', ['checkout', spec.ref], { cwd: target, timeout: 60_000 });
      } catch (e2) {
        throw new Error(`Failed to clone plugin ${spec.raw}: ${(e2 as Error).message}`);
      }
    } else {
      throw new Error(`Failed to clone plugin ${spec.raw}: ${(e as Error).message}`);
    }
  }

  return target;
}

async function isNonEmptyDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return false;
    const { readdir } = await import('fs/promises');
    const entries = await readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function sanitizeRefForFs(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]/g, '_');
}

function safeHost(url: string): string {
  try {
    if (url.startsWith('git@')) {
      const m = url.match(/^git@([^:]+):/);
      return m ? m[1] : 'git';
    }
    return new URL(url).host || 'git';
  } catch {
    return 'git';
  }
}

function isLikelyBranchOrTag(ref: string): boolean {
  // Heuristic: 40-char hex looks like a SHA.
  return !/^[0-9a-f]{40}$/i.test(ref);
}
