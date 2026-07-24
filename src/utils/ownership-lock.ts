import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPidAlive } from './process-info';

interface LockOwner {
  token: string;
  pid: number;
  acquiredAt: number;
  label?: string;
}

export interface OwnershipLockOptions {
  staleMs?: number;
  retryMs?: number;
  maxWaitMs?: number;
  label?: string;
}

export interface OwnershipLockHandle {
  token: string;
  release(): Promise<void>;
}

const OWNER_FILE = 'owner.json';
const RECLAIM_FILE = 'reclaim.json';
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 20;
const DEFAULT_MAX_WAIT_MS = 40_000;

function parseOwner(raw: string | null): LockOwner | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof parsed.token !== 'string'
      || typeof parsed.pid !== 'number'
      || typeof parsed.acquiredAt !== 'number'
    ) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  return parseOwner(
    await readFile(join(lockPath, OWNER_FILE), 'utf8').catch(() => null)
  );
}

async function lockAgeMs(lockPath: string): Promise<number> {
  const info = await stat(lockPath).catch(() => null);
  return info ? Math.max(0, Date.now() - info.mtimeMs) : 0;
}

async function ownerIsReclaimable(
  lockPath: string,
  owner: LockOwner | null,
  staleMs: number
): Promise<boolean> {
  const age = await lockAgeMs(owner ? join(lockPath, OWNER_FILE) : lockPath);
  // A newly-created directory may be observed before owner.json is written.
  if (!owner) return age >= staleMs;
  // Dead holders are immediately reclaimable. Live holders retain ownership
  // while their lease heartbeat is fresh.
  return !isPidAlive(owner.pid) || age >= staleMs;
}

async function claimReclamation(
  lockPath: string,
  expectedOwner: LockOwner | null,
  staleMs: number
): Promise<boolean> {
  const reclaimPath = join(lockPath, RECLAIM_FILE);
  const reclaimOwner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: Date.now(),
  };

  try {
    await writeFile(reclaimPath, JSON.stringify(reclaimOwner), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    const existing = parseOwner(await readFile(reclaimPath, 'utf8').catch(() => null));
    const reclaimAge = await lockAgeMs(reclaimPath);
    if (existing && isPidAlive(existing.pid) && reclaimAge < staleMs) return false;

    // This marker belongs to the already-abandoned lock directory. Compare its
    // identity before deleting so one recovery attempt cannot erase another.
    const before = await readFile(reclaimPath, 'utf8').catch(() => null);
    const current = await readFile(reclaimPath, 'utf8').catch(() => null);
    if (before === null || current !== before) return false;
    await unlink(reclaimPath).catch(() => undefined);
    try {
      await writeFile(reclaimPath, JSON.stringify(reclaimOwner), { flag: 'wx' });
    } catch {
      return false;
    }
  }

  const currentOwner = await readOwner(lockPath);
  const sameOwner = expectedOwner
    ? currentOwner?.token === expectedOwner.token
    : currentOwner === null;
  const stillOwnsReclaim = (await readOwnerFile(reclaimPath))?.token === reclaimOwner.token;
  // Creating reclaim.json necessarily refreshes the directory mtime. For the
  // ownerless crash window (mkdir succeeded, owner.json never landed), that
  // means re-checking lockPath's age here would make the stale directory look
  // new forever. The caller already established staleness immediately before
  // claiming this marker, and currentOwner === null proves no owner appeared
  // during the claim. Token-bearing owners still get a fresh lease re-check so
  // a resumed heartbeat can defeat reclamation.
  const stillReclaimable = currentOwner === null
    ? expectedOwner === null
    : await ownerIsReclaimable(lockPath, currentOwner, staleMs);
  if (
    !sameOwner
    || !stillOwnsReclaim
    || !stillReclaimable
  ) {
    if (stillOwnsReclaim) await unlink(reclaimPath).catch(() => undefined);
    return false;
  }

  // Only the recovery-token owner can move the directory. Once moved, new
  // contenders can atomically mkdir(lockPath); the abandoned directory has a
  // unique name and can be removed without touching any replacement lock.
  const quarantine = `${lockPath}.reclaimed-${reclaimOwner.token}`;
  try {
    await rename(lockPath, quarantine);
  } catch {
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function readOwnerFile(filePath: string): Promise<LockOwner | null> {
  return parseOwner(await readFile(filePath, 'utf8').catch(() => null));
}

async function reclaimLegacyFile(
  lockPath: string,
  staleMs: number
): Promise<boolean> {
  const raw = await readFile(lockPath, 'utf8').catch(() => null);
  if (raw === null) return true;
  let parsed: { pid?: unknown; timestamp?: unknown; token?: unknown } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt legacy locks are reclaimed only after their mtime lease expires.
  }
  const age = typeof parsed.timestamp === 'string'
    ? Date.now() - new Date(parsed.timestamp).getTime()
    : await lockAgeMs(lockPath);
  const live = typeof parsed.pid === 'number' && isPidAlive(parsed.pid);
  if (live && Number.isFinite(age) && age < staleMs) return false;

  // Serialize migration/recovery of the old single-file format. New-format
  // holders use lockPath as a directory, so they can never be mistaken for the
  // legacy file after this type check.
  const recoveryPath = `${lockPath}.legacy-recovery`;
  try {
    await mkdir(recoveryPath);
  } catch {
    return false;
  }
  try {
    const currentInfo = await lstat(lockPath).catch(() => null);
    if (!currentInfo?.isFile()) return false;
    const current = await readFile(lockPath, 'utf8').catch(() => null);
    if (current !== raw) return false;
    const quarantine = `${lockPath}.legacy-${randomUUID()}`;
    await rename(lockPath, quarantine);
    await unlink(quarantine).catch(() => undefined);
    return true;
  } finally {
    await rm(recoveryPath, { recursive: true, force: true });
  }
}

export async function acquireOwnershipLock(
  lockPath: string,
  options: OwnershipLockOptions = {}
): Promise<OwnershipLockHandle> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const deadline = Date.now() + maxWaitMs;

  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    const token = randomUUID();
    const owner: LockOwner = {
      token,
      pid: process.pid,
      acquiredAt: Date.now(),
      ...(options.label && { label: options.label }),
    };
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, OWNER_FILE), JSON.stringify(owner), { flag: 'wx' });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      const heartbeatMs = Math.max(10, Math.floor(staleMs / 3));
      const ownerPath = join(lockPath, OWNER_FILE);
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(ownerPath, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();

      return {
        token,
        async release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          const current = await readOwner(lockPath);
          if (current?.token !== token) return;

          // A live, heartbeating holder is never reclaimable, so this rename
          // cannot target a legitimate replacement. The token comparison is
          // the final guard against an old holder deleting a newer lock.
          const releasedPath = `${lockPath}.released-${token}`;
          try {
            await rename(lockPath, releasedPath);
          } catch {
            return;
          }
          const movedOwner = await readOwner(releasedPath);
          if (movedOwner?.token !== token) {
            await rename(releasedPath, lockPath).catch(() => undefined);
            return;
          }
          await rm(releasedPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const info = await lstat(lockPath).catch(() => null);
    if (!info) continue;
    if (info.isFile()) {
      if (await reclaimLegacyFile(lockPath, staleMs)) continue;
    } else if (info.isDirectory()) {
      const existing = await readOwner(lockPath);
      if (
        await ownerIsReclaimable(lockPath, existing, staleMs)
        && await claimReclamation(lockPath, existing, staleMs)
      ) continue;
    } else {
      throw new Error(`Unsupported lock node at ${lockPath}`);
    }

    if (Date.now() >= deadline) {
      const owner = info.isDirectory() ? await readOwner(lockPath) : null;
      throw new Error(
        `Timed out waiting for lock "${lockPath}"` +
        (owner ? ` held by PID ${owner.pid}${owner.label ? ` (${owner.label})` : ''}` : '')
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

export async function withOwnershipLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: OwnershipLockOptions = {}
): Promise<T> {
  const handle = await acquireOwnershipLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await handle.release();
  }
}
