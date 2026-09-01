/**
 * Quiet, package-manager-aware update checks for the CLI and serve dashboard.
 *
 * Registry I/O is deliberately detached from command completion: commands only
 * read a tiny local cache, while an unref'd HTTPS request refreshes that cache
 * for a later command (or a long-lived serve process).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { get as httpsGet } from 'https';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getAgentuseDataDir } from './utils/data-dir';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PACKAGE_NAME = 'agentuse';

interface UpdateCache {
  checkedAt: number;
  latestVersion?: string;
}

interface NoticeCache {
  latestVersion: string;
  shownAt: number;
}

export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn';

export interface AvailableUpdate {
  currentVersion: string;
  latestVersion: string;
  packageManager: PackageManager;
  command: string;
}

function stateDir(): string {
  return getAgentuseDataDir();
}

function updateCachePath(): string {
  return join(stateDir(), 'update-check.json');
}

function noticeCachePath(): string {
  return join(stateDir(), 'update-notice.json');
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  } catch {
    // Update checks must never affect product behavior.
  }
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(.+))?$/.exec(value.trim());
  if (!match) return null;
  if ([match[1], match[2], match[3]].some(identifier => (
    identifier.length > 1 && identifier.startsWith('0')
  ))) return null;
  const prerelease = match[4]?.split('.') ?? null;
  const build = match[5]?.split('.') ?? null;
  if (prerelease?.some(identifier => (
    !/^[0-9A-Za-z-]+$/.test(identifier)
    || (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))
  ))) return null;
  if (build?.some(identifier => !/^[0-9A-Za-z-]+$/.test(identifier))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrereleaseIdentifiers(candidate: string[], current: string[]): number {
  const length = Math.max(candidate.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const next = candidate[index];
    const installed = current[index];
    if (next === undefined) return -1;
    if (installed === undefined) return 1;
    if (next === installed) continue;
    const nextNumeric = /^\d+$/.test(next);
    const installedNumeric = /^\d+$/.test(installed);
    if (nextNumeric && installedNumeric) return Number(next) > Number(installed) ? 1 : -1;
    if (nextNumeric !== installedNumeric) return nextNumeric ? -1 : 1;
    return next > installed ? 1 : -1;
  }
  return 0;
}

/** Stable releases sort after prereleases with the same numeric version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (next[key] !== installed[key]) return next[key] > installed[key];
  }
  if (next.prerelease === null && installed.prerelease === null) return false;
  if (next.prerelease === null) return true;
  if (installed.prerelease === null) return false;
  return comparePrereleaseIdentifiers(next.prerelease, installed.prerelease) > 0;
}

export function detectPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  scriptPath = process.argv[1] ?? '',
): PackageManager {
  const userAgent = env.npm_config_user_agent?.toLowerCase() ?? '';
  const normalizedPath = scriptPath.replaceAll('\\', '/').toLowerCase();
  if (userAgent.startsWith('pnpm/') || normalizedPath.includes('/.pnpm/')) return 'pnpm';
  if (userAgent.startsWith('bun/') || normalizedPath.includes('/.bun/')) return 'bun';
  if (userAgent.startsWith('yarn/') || normalizedPath.includes('/yarn/')) return 'yarn';
  return 'npm';
}

export function updateCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'pnpm': return `pnpm add -g ${PACKAGE_NAME}@latest`;
    case 'bun': return `bun add -g ${PACKAGE_NAME}@latest`;
    case 'yarn': return `yarn global add ${PACKAGE_NAME}@latest`;
    default: return `npm install -g ${PACKAGE_NAME}@latest`;
  }
}

function isNpxRun(scriptPath = process.argv[1] ?? ''): boolean {
  const normalized = scriptPath.replaceAll('\\', '/');
  return normalized.includes('/_npx/') || normalized.includes('/.npx-cache/');
}

function isLocalDevelopmentBuild(): boolean {
  try {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    return existsSync(join(packageRoot, '.git'));
  } catch {
    return false;
  }
}

function updateChecksDisabled(): boolean {
  const disabled = process.env.AGENTUSE_UPDATE_CHECK_DISABLED;
  return disabled === '1'
    || disabled === 'true'
    || Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || process.env.BUILDKITE);
}

function cachedUpdate(currentVersion: string): AvailableUpdate | null {
  const cache = readJson<UpdateCache>(updateCachePath());
  if (!cache?.latestVersion || !isNewerVersion(cache.latestVersion, currentVersion)) return null;
  const packageManager = detectPackageManager();
  return {
    currentVersion,
    latestVersion: cache.latestVersion,
    packageManager,
    command: updateCommand(packageManager),
  };
}

/** Update information for the Web UI; browser dismissal is kept per browser. */
export function getCachedAvailableUpdate(currentVersion: string): AvailableUpdate | null {
  if (updateChecksDisabled() || isNpxRun() || isLocalDevelopmentBuild()) return null;
  return cachedUpdate(currentVersion);
}

/** Update information for an interactive CLI, respecting the seven-day reminder. */
export function getCachedCliUpdate(currentVersion: string, now = Date.now()): AvailableUpdate | null {
  const update = getCachedAvailableUpdate(currentVersion);
  if (!update) return null;
  const notice = readJson<NoticeCache>(noticeCachePath());
  return shouldRemind(update.latestVersion, notice, now) ? update : null;
}

function shouldRemind(latestVersion: string, notice: NoticeCache | null, now: number): boolean {
  return notice?.latestVersion !== latestVersion || now - notice.shownAt >= UPDATE_REMINDER_INTERVAL_MS;
}

export function markUpdateNoticeShown(latestVersion: string, now = Date.now()): void {
  atomicWriteJson(noticeCachePath(), { latestVersion, shownAt: now } satisfies NoticeCache);
}

let refreshInFlight = false;

export function shouldRefreshUpdateCache(checkedAt: number | undefined, now = Date.now()): boolean {
  return checkedAt === undefined || now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Refresh npm's `latest` dist-tag without holding the process open. A failed
 * attempt still advances checkedAt when the process lives long enough to hear
 * the failure, preventing offline machines from retrying on every command.
 */
export function refreshUpdateCacheInBackground(currentVersion: string, now = Date.now()): void {
  if (refreshInFlight || updateChecksDisabled() || isNpxRun() || isLocalDevelopmentBuild()) return;
  const cache = readJson<UpdateCache>(updateCachePath());
  if (!shouldRefreshUpdateCache(cache?.checkedAt, now)) return;

  refreshInFlight = true;
  let settled = false;
  const finish = (latestVersion?: string) => {
    if (settled) return;
    settled = true;
    refreshInFlight = false;
    atomicWriteJson(updateCachePath(), {
      checkedAt: now,
      ...(latestVersion ? { latestVersion } : cache?.latestVersion ? { latestVersion: cache.latestVersion } : {}),
    } satisfies UpdateCache);
  };

  const request = httpsGet(
    'https://registry.npmjs.org/agentuse/latest',
    { headers: { Accept: 'application/json', 'User-Agent': `agentuse/${currentVersion}` } },
    response => {
      response.socket.unref();
      if (response.statusCode !== 200) {
        response.resume();
        finish();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Registry response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: unknown };
          finish(typeof value.version === 'string' && parseVersion(value.version) ? value.version : undefined);
        } catch {
          finish();
        }
      });
      response.on('aborted', () => finish());
      response.on('error', () => finish());
    },
  );
  request.on('socket', socket => socket.unref());
  request.setTimeout(REGISTRY_TIMEOUT_MS, () => request.destroy(new Error('Registry request timed out')));
  request.on('error', () => finish());
}

export const __testing = {
  updateCachePath,
  noticeCachePath,
  cachedUpdate,
  shouldRemind,
};
