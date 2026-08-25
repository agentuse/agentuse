/**
 * Anonymous ID generation and persistence for telemetry.
 *
 * Stores telemetry config in ~/.local/share/agentuse/telemetry.json. The file
 * is shared by CLI commands and serve daemons, so every mutation is protected
 * by a small cross-process lock and committed with an atomic rename.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getXdgDataDir } from '../storage/paths';

const TELEMETRY_FILE = 'telemetry.json';
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 10;

interface TelemetryConfig {
  id: string;
  identitySchemaVersion?: 2;
  alertedAt?: string;
  /** Immutable creation time for identities created by lifecycle schema v2. */
  createdAt?: string;
  /** Stable PostHog UUID. Retried launches are deduplicated server-side. */
  installationEventId?: string;
  firstExecutionAt?: string;
  /** Stable UUID for the explicit activation event. */
  activationEventId?: string;
}

export interface AnonymousIdentity {
  id: string;
  created: boolean;
  persisted: boolean;
  isFirstExecution: boolean;
  migrated: boolean;
  createdAt?: string;
  installationEventId?: string;
  firstExecutionAt?: string;
  activationEventId?: string;
}

export interface FirstExecutionClaim {
  firstExecutionAt: string;
  activationEventId: string;
}

function getTelemetryDir(): string {
  return path.join(getXdgDataDir(), 'agentuse');
}

function getConfigPath(): string {
  return path.join(getTelemetryDir(), TELEMETRY_FILE);
}

function getLockPath(): string {
  return `${getConfigPath()}.lock`;
}

async function readConfig(): Promise<TelemetryConfig | null> {
  try {
    const content = await fs.readFile(getConfigPath(), 'utf-8');
    return JSON.parse(content) as TelemetryConfig;
  } catch {
    return null;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

interface ConfigLock {
  handle: fs.FileHandle;
  path: string;
  token: string;
  dev: number;
  ino: number;
}

let staleReclaimHookForTest: (() => void | Promise<void>) | undefined;

async function removeConfigLockIfOwned(lock: ConfigLock): Promise<boolean> {
  try {
    const [currentStat, currentToken] = await Promise.all([
      fs.stat(lock.path),
      fs.readFile(lock.path, 'utf8'),
    ]);
    if (currentStat.dev !== lock.dev || currentStat.ino !== lock.ino || currentToken !== lock.token) {
      return false;
    }
    await fs.unlink(lock.path);
    return true;
  } catch {
    return false;
  }
}

async function inspectExistingLock(lockPath: string): Promise<ConfigLock | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockPath, 'r');
    const info = await handle.stat();
    const token = await handle.readFile('utf8');
    return { handle, path: lockPath, token, dev: info.dev, ino: info.ino };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function createOwnedLock(lockPath: string): Promise<ConfigLock> {
  const handle = await fs.open(lockPath, 'wx', 0o600);
  const token = crypto.randomUUID();
  try {
    await handle.writeFile(token, 'utf8');
    const info = await handle.stat();
    return { handle, path: lockPath, token, dev: info.dev, ino: info.ino };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
    throw error;
  }
}

async function acquireConfigLock(): Promise<ConfigLock> {
  const dir = getTelemetryDir();
  await fs.mkdir(dir, { recursive: true });
  const lockPath = getLockPath();

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      return await createOwnedLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await inspectExistingLock(lockPath);
      if (existing) {
        try {
          const info = await existing.handle.stat();
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            // Only one process may reclaim a stale main lock. The recovery
            // mutex is never stolen: if its owner dies, telemetry safely falls
            // back to an ephemeral identity instead of risking two writers.
            const recoveryPath = `${lockPath}.recovery`;
            let recovery: ConfigLock | null = null;
            try {
              recovery = await createOwnedLock(recoveryPath);
            } catch (recoveryError) {
              if ((recoveryError as NodeJS.ErrnoException).code !== 'EEXIST') throw recoveryError;
            }
            if (recovery) {
              let reclaimed: ConfigLock | null = null;
              try {
                await staleReclaimHookForTest?.();
                const staleCandidate = await inspectExistingLock(lockPath);
                if (staleCandidate) {
                  try {
                    const candidateInfo = await staleCandidate.handle.stat();
                    if (Date.now() - candidateInfo.mtimeMs > LOCK_STALE_MS) {
                      await staleCandidate.handle.close().catch(() => {});
                      if (await removeConfigLockIfOwned(staleCandidate)) {
                        try {
                          // Keep the recovery guard through reacquisition so a
                          // second stale observer can never validate the old
                          // inode and later unlink this new owner.
                          reclaimed = await createOwnedLock(lockPath);
                        } catch (reacquireError) {
                          if ((reacquireError as NodeJS.ErrnoException).code !== 'EEXIST') {
                            throw reacquireError;
                          }
                        }
                      }
                    }
                  } finally {
                    await staleCandidate.handle.close().catch(() => {});
                  }
                }
              } finally {
                await recovery.handle.close().catch(() => {});
                await removeConfigLockIfOwned(recovery);
              }
              if (reclaimed) return reclaimed;
            }
            await delay(LOCK_RETRY_MS);
            continue;
          }
        } finally {
          await existing.handle.close().catch(() => {});
        }
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error('Timed out waiting for telemetry identity lock');
}

async function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const lock = await acquireConfigLock();
  try {
    return await operation();
  } finally {
    await lock.handle.close().catch(() => {});
    await removeConfigLockIfOwned(lock);
  }
}

async function atomicWriteConfig(config: TelemetryConfig): Promise<void> {
  const dir = getTelemetryDir();
  await fs.mkdir(dir, { recursive: true });
  const target = getConfigPath();
  const temporary = path.join(dir, `${TELEMETRY_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function toIdentity(config: TelemetryConfig, overrides: Pick<AnonymousIdentity, 'created' | 'migrated'>): AnonymousIdentity {
  return {
    id: config.id,
    created: overrides.created,
    persisted: true,
    isFirstExecution: !config.firstExecutionAt,
    migrated: overrides.migrated,
    ...(config.createdAt && { createdAt: config.createdAt }),
    ...(config.installationEventId && { installationEventId: config.installationEventId }),
    ...(config.firstExecutionAt && { firstExecutionAt: config.firstExecutionAt }),
    ...(config.activationEventId && { activationEventId: config.activationEventId }),
  };
}

export async function getOrCreateAnonymousIdentity(): Promise<AnonymousIdentity> {
  const ephemeralId = crypto.randomUUID();
  try {
    return await withConfigLock(async () => {
      const config = await readConfig();
      if (config?.id) {
        if (config.identitySchemaVersion !== 2) {
          // Existing IDs predate explicit lifecycle tracking. Upgrade the file,
          // but never relabel their next run as a new install or activation.
          const migrated: TelemetryConfig = {
            ...config,
            identitySchemaVersion: 2,
            firstExecutionAt: config.firstExecutionAt ?? 'legacy',
          };
          await atomicWriteConfig(migrated);
          return toIdentity(migrated, { created: false, migrated: true });
        }
        return toIdentity(config, { created: false, migrated: false });
      }

      const createdAt = new Date().toISOString();
      const created: TelemetryConfig = {
        id: ephemeralId,
        identitySchemaVersion: 2,
        createdAt,
        installationEventId: crypto.randomUUID(),
      };
      await atomicWriteConfig(created);
      return toIdentity(created, { created: true, migrated: false });
    });
  } catch {
    // Best-effort fallback. It is explicitly non-persistent so cohort queries
    // can exclude it and it never emits an installation lifecycle event.
    return {
      id: ephemeralId,
      created: true,
      persisted: false,
      isFirstExecution: true,
      migrated: false,
    };
  }
}

/** Test seam for forcing a second stale observer to contend during recovery. */
export function setTelemetryStaleReclaimHookForTest(
  hook: (() => void | Promise<void>) | undefined
): void {
  staleReclaimHookForTest = hook;
}

/** Backwards-compatible ID-only accessor. */
export async function getOrCreateAnonymousId(): Promise<string> {
  return (await getOrCreateAnonymousIdentity()).id;
}

/** Atomically claims the installation's first execution across processes. */
export async function markFirstExecutionComplete(expectedIdentityId: string): Promise<FirstExecutionClaim | null> {
  try {
    return await withConfigLock(async () => {
      const config = await readConfig();
      if (!config?.id || config.id !== expectedIdentityId || config.firstExecutionAt) return null;
      const claim = {
        firstExecutionAt: new Date().toISOString(),
        activationEventId: crypto.randomUUID(),
      };
      await atomicWriteConfig({ ...config, ...claim });
      return claim;
    });
  } catch {
    return null;
  }
}

export async function isFirstRun(): Promise<boolean> {
  const config = await readConfig();
  return !config?.alertedAt;
}

export async function markFirstRunComplete(): Promise<void> {
  try {
    await withConfigLock(async () => {
      const config = await readConfig() ?? { id: crypto.randomUUID() };
      if (config.alertedAt) return;
      await atomicWriteConfig({ ...config, alertedAt: new Date().toISOString() });
    });
  } catch {
    // Non-critical: the disclosure will be offered again on a later visible run.
  }
}
