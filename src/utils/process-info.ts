import { execFile, execFileSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Process identity helpers. A bare PID is not a stable identity: the OS recycles
 * PIDs, so a dead process's PID can later belong to an unrelated one. Pairing the
 * PID with the process start time distinguishes "still the same process" from
 * "PID reused", which both the sandbox orphan-cleanup and the serve registry rely
 * on to avoid acting on a recycled PID.
 */

let currentProcessStartTime: string | undefined;
let linuxBootId: string | undefined;

function getLinuxBootId(): string | null {
  if (linuxBootId === undefined) {
    try {
      linuxBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      linuxBootId = '';
    }
  }
  return linuxBootId || null;
}

function getLinuxProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    if (endOfCommand === -1) return null;

    // /proc/<pid>/stat field 22 is starttime. After the command field,
    // the remaining fields begin at field 3, so index 19 maps to field 22.
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) return null;

    const bootId = getLinuxBootId();
    return bootId ? `linux:${bootId}:${startTicks}` : `linux:${startTicks}`;
  } catch {
    return null;
  }
}

/**
 * A pid's start time never changes, so the only reason to re-read it is that the
 * pid may have been recycled onto a different process. The TTL bounds how long a
 * recycled pid can keep serving the previous occupant's token; nothing else here
 * depends on the cache being fresh. Without it, sweeps that probe many pids on a
 * schedule fork `ps` once per pid per pass (macOS has no /proc to read instead).
 */
const START_TIME_TTL_MS = 45_000;
const START_TIME_CACHE_LIMIT = 1_000;
const startTimeCache = new Map<number, { token: string; checkedAt: number }>();

function readCachedStartTime(pid: number): string | null {
  const hit = startTimeCache.get(pid);
  if (!hit) return null;
  if (Date.now() - hit.checkedAt >= START_TIME_TTL_MS) {
    startTimeCache.delete(pid);
    return null;
  }
  return hit.token;
}

function cacheStartTime(pid: number, token: string | null): string | null {
  // Only successes are cached: a null means "couldn't tell" (process gone, `ps`
  // unavailable), and callers degrade on it, so remembering it would pin the
  // degraded answer for the whole TTL.
  if (!token) return null;
  if (startTimeCache.size >= START_TIME_CACHE_LIMIT) {
    const now = Date.now();
    for (const [cachedPid, entry] of startTimeCache) {
      if (now - entry.checkedAt >= START_TIME_TTL_MS) startTimeCache.delete(cachedPid);
    }
    // Still full of live entries: drop the oldest insertion to stay bounded.
    if (startTimeCache.size >= START_TIME_CACHE_LIMIT) {
      const oldest = startTimeCache.keys().next();
      if (!oldest.done) startTimeCache.delete(oldest.value);
    }
  }
  startTimeCache.set(pid, { token, checkedAt: Date.now() });
  return token;
}

/**
 * Read an opaque, comparable process-start-time token for a PID, or null when it
 * can't be determined (process gone, or `ps`/proc unavailable). Tokens are only
 * meaningful for equality comparison, not parsing.
 */
export function getProcessStartTime(pid: number): string | null {
  const cached = readCachedStartTime(pid);
  if (cached) return cached;

  const linuxStartTime = getLinuxProcessStartTime(pid);
  if (linuxStartTime) return cacheStartTime(pid, linuxStartTime);

  try {
    const startTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return startTime ? cacheStartTime(pid, `ps:${startTime}`) : null;
  } catch {
    return null;
  }
}

/**
 * `getProcessStartTime` without the synchronous `ps` fork. Callers already on an
 * async path should prefer this: the sync version stalls the event loop for a
 * few milliseconds per uncached pid, which is enough to be felt when a periodic
 * sweep probes many of them.
 */
export function getProcessStartTimeAsync(pid: number): Promise<string | null> {
  const cached = readCachedStartTime(pid);
  if (cached) return Promise.resolve(cached);

  const linuxStartTime = getLinuxProcessStartTime(pid);
  if (linuxStartTime) return Promise.resolve(cacheStartTime(pid, linuxStartTime));

  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      const startTime = stdout.trim();
      resolve(startTime ? cacheStartTime(pid, `ps:${startTime}`) : null);
    });
  });
}

/** Memoized start-time token for the current process. */
export function getCurrentProcessStartTime(): string | null {
  if (currentProcessStartTime === undefined) {
    currentProcessStartTime = getProcessStartTime(process.pid) ?? '';
  }
  return currentProcessStartTime || null;
}

/**
 * Whether a process with this PID currently exists. Signal 0 probes without
 * killing; EPERM means it exists but belongs to another user.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A pid plus its start-time token: a comparable, recycle-safe process identity. */
export interface ProcessRef {
  pid: number;
  procStartedAt?: string;
}

/** Identity of the current process, for stamping into locks and session records. */
export function currentProcessRef(): ProcessRef {
  const procStartedAt = getCurrentProcessStartTime();
  return { pid: process.pid, ...(procStartedAt && { procStartedAt }) };
}

/** Boot id embedded in a `linux:<bootId>:<ticks>` token, when it has one. */
function bootIdOf(token: string): string | null {
  const parts = token.split(':');
  return parts[0] === 'linux' && parts.length === 3 ? (parts[1] ?? null) : null;
}

/**
 * Liveness with the uncertain case kept separate, for callers that must not
 * guess.
 *
 * `isProcessRefAlive` collapses "the start-time token does not match" into
 * "dead", which is right for orphan cleanup: a leftover record pointing at a
 * recycled pid should be swept. It is wrong for anything deciding whether it may
 * take something away from another process, because a token can disagree without
 * the holder being gone. A process reading its own `/proc/<pid>/stat` while it is
 * still starting up can see a partially-populated line and stamp a token that no
 * other process will ever read back, and the holder is very much alive.
 *
 * A mismatch across a reboot is not uncertain: the token carries the boot id, and
 * no process running now started under a previous one. That case stays `dead` so
 * a reboot still frees a lock without anyone intervening.
 */
export type ProcessRefState = 'dead' | 'alive' | 'ambiguous';

export function processRefState(ref: ProcessRef): ProcessRefState {
  if (typeof ref.pid !== 'number' || !isPidAlive(ref.pid)) return 'dead';
  if (!ref.procStartedAt) return 'alive';
  const current = getProcessStartTime(ref.pid);
  if (!current) return 'alive';
  if (current === ref.procStartedAt) return 'alive';
  const priorBoot = bootIdOf(ref.procStartedAt);
  const currentBoot = bootIdOf(current);
  if (priorBoot && currentBoot && priorBoot !== currentBoot) return 'dead';
  return 'ambiguous';
}

/**
 * Whether the process a ref points at is still the same live process. A missing
 * start token (unreadable /proc, `ps` failure) degrades to the bare pid probe.
 */
export function isProcessRefAlive(ref: ProcessRef): boolean {
  if (typeof ref.pid !== 'number' || !isPidAlive(ref.pid)) return false;
  if (!ref.procStartedAt) return true;
  const current = getProcessStartTime(ref.pid);
  if (!current) return true;
  return current === ref.procStartedAt;
}

/** `isProcessRefAlive` for async callers; see `getProcessStartTimeAsync`. */
export async function isProcessRefAliveAsync(ref: ProcessRef): Promise<boolean> {
  if (typeof ref.pid !== 'number' || !isPidAlive(ref.pid)) return false;
  if (!ref.procStartedAt) return true;
  const current = await getProcessStartTimeAsync(ref.pid);
  if (!current) return true;
  return current === ref.procStartedAt;
}
