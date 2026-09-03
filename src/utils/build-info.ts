import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { version as packageVersion } from '../../package.json';

export interface BuildInfo {
  /** Full version string. Release: `0.20.0`. Dev checkout: `0.20.0-dev.22+cf0ce07`. */
  version: string;
  /** package.json version, always plain semver. */
  baseVersion: string;
  /** True when running from a git checkout (npm link / local build), not a published package. */
  dev: boolean;
  /** Short commit hash of the checkout, when git could tell us. */
  commit?: string;
  /** Commits on top of the last release tag, when git could tell us. */
  commitsSinceTag?: number;
  /** True when the checkout had uncommitted changes. */
  dirty?: boolean;
}

/** Walk up from this module until we find the package root, whether bundled into dist/ or run from src/. */
function findPackageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'agentuse') return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const DESCRIBE_RE = /^v?(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/;

/** Parse `git describe --tags --long --dirty` output into the dev-suffix parts. */
export function parseDescribe(output: string): Pick<BuildInfo, 'commit' | 'commitsSinceTag' | 'dirty'> | null {
  const m = DESCRIBE_RE.exec(output.trim());
  if (!m) return null;
  return { commit: m[3], commitsSinceTag: Number(m[2]), dirty: Boolean(m[4]) };
}

/** Compose the semver-style dev version so the suffix is machine-sortable. */
export function formatDevVersion(base: string, git: ReturnType<typeof parseDescribe>): string {
  if (!git) return `${base}-dev`;
  const dirty = git.dirty ? '.dirty' : '';
  return `${base}-dev.${git.commitsSinceTag}+${git.commit}${dirty}`;
}

function describeCheckout(root: string): ReturnType<typeof parseDescribe> {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--long', '--dirty', '--always'], {
      cwd: root, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseDescribe(out) ?? (/^[0-9a-f]{7,}$/.test(out.trim()) ? { commit: out.trim().slice(0, 7) } : null);
  } catch {
    return null;
  }
}

let cached: BuildInfo | null = null;
let checkoutRoot: string | null | undefined;

/** Package root when running from a git checkout, null for a published install. */
function devCheckoutRoot(): string | null {
  if (checkoutRoot === undefined) {
    const root = findPackageRoot();
    checkoutRoot = root !== null && existsSync(join(root, '.git')) ? root : null;
  }
  return checkoutRoot;
}

/**
 * Whether this is a dev checkout, from two stat calls. Use this on hot paths
 * (every CLI start, every worker spawn) instead of getBuildInfo(), whose
 * synchronous `git describe` costs ~45ms and is only needed to print a version.
 */
export function isDevCheckout(): boolean {
  return devCheckoutRoot() !== null;
}

/** Version plus whether this is an unreleased checkout. Computed once per process. */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const root = devCheckoutRoot();
  const dev = root !== null;
  if (!dev) {
    cached = { version: packageVersion, baseVersion: packageVersion, dev: false };
    return cached;
  }
  const git = describeCheckout(root);
  cached = { version: formatDevVersion(packageVersion, git), baseVersion: packageVersion, dev: true, ...git };
  return cached;
}

/** Human line for `--version`: `0.20.0-dev.22+cf0ce07 (local, 22 commits after v0.20.0)`. */
export function formatVersionLine(info: BuildInfo = getBuildInfo()): string {
  if (!info.dev) return info.version;
  const parts = ['local'];
  if (info.commitsSinceTag !== undefined) parts.push(`${info.commitsSinceTag} commits after v${info.baseVersion}`);
  if (info.dirty) parts.push('uncommitted changes');
  return `${info.version} (${parts.join(', ')})`;
}
