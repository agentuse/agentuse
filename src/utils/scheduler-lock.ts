/**
 * Per-project scheduler lock.
 *
 * The serve registry (server-registry.ts) already refuses to start a second
 * daemon, but its PID files live under $XDG_DATA_HOME: a daemon launched with
 * a different data dir (the standard recipe for isolated test daemons) is
 * invisible to it while still able to load the real project config and fire
 * its schedules, double-running every scheduled agent with real side effects.
 *
 * This lock lives inside the project itself ({projectRoot}/.agentuse/
 * scheduler.lock), the one path every daemon serving the project resolves
 * identically regardless of environment, so at most one daemon arms schedules
 * per project no matter how the processes were launched.
 *
 * Liveness is a PID probe plus the process-start-time token (see
 * process-info.ts), so a stale lock from a crashed daemon or a recycled PID is
 * taken over automatically. Single-machine only by design: schedules run where
 * the project checkout lives.
 */
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { getCurrentProcessStartTime, processRefState } from './process-info';

export interface SchedulerLockHolder {
  pid: number;
  /** Process-start-time token guarding against a recycled PID. */
  procStartedAt?: string;
  acquiredAt: number;
}

export type SchedulerLockResult =
  | { acquired: true }
  | { acquired: false; holder?: SchedulerLockHolder; error?: string };

export function schedulerLockPath(projectRoot: string): string {
  return join(projectRoot, '.agentuse', 'scheduler.lock');
}

export function schedulerLockReclaimPath(projectRoot: string): string {
  return `${schedulerLockPath(projectRoot)}.reclaim`;
}

const GIT_EXCLUDE_PATTERNS = [
  '.agentuse/scheduler.lock',
  '.agentuse/scheduler.lock.reclaim',
  '.agentuse/scheduler.lock.*.tmp',
];

/**
 * Keep the lock out of git status without touching the repo's committed
 * .gitignore: .git/info/exclude is the per-clone ignore list. Best-effort and
 * only for the common layout (a .git directory at the project root); worktrees
 * and nested roots just show an untracked file, which is harmless.
 */
function ensureLocalGitExclude(projectRoot: string): void {
  try {
    const gitDir = join(projectRoot, '.git');
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
    const excludePath = join(gitDir, 'info', 'exclude');
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    const existing = new Set(current.split('\n').map((line) => line.trim()));
    const missing = GIT_EXCLUDE_PATTERNS.filter((pattern) => !existing.has(pattern));
    if (missing.length === 0) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(
      excludePath,
      `${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`
    );
  } catch {
    // Ignore: purely cosmetic.
  }
}

function readHolder(path: string): SchedulerLockHolder | undefined {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf-8')) as SchedulerLockHolder;
    return typeof holder.pid === 'number' && typeof holder.acquiredAt === 'number'
      ? holder
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a lock whose holder is running but cannot be confirmed as the process
 * that recorded it.
 *
 * Fail closed, matching the rest of this module: a scheduler that will not start
 * is one deleted file away from working and says so, while two schedulers that
 * both believe they hold the lock fire every cron twice and nothing says
 * anything. The asymmetry is the whole argument.
 */
function ambiguousHolder(path: string, holder: SchedulerLockHolder): SchedulerLockResult {
  return {
    acquired: false,
    holder,
    error:
      `scheduler lock holder pid ${holder.pid} is running but its identity cannot be confirmed, ` +
      `so it is not safe to take the lock from it. If that process is not an agentuse scheduler, remove ${path}`,
  };
}

function denied(path: string, error?: string): SchedulerLockResult {
  const holder = readHolder(path);
  return {
    acquired: false,
    ...(holder && { holder }),
    ...(error && { error }),
  };
}

/**
 * Publish a fully-written lock payload without ever exposing a partially
 * written canonical file. Hard-link creation is atomic and fails with EEXIST
 * when another owner already published the same path.
 */
function writeLockExclusive(path: string, payload: string): void {
  const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(candidate, payload, { flag: 'wx' });
  try {
    linkSync(candidate, path);
  } finally {
    try {
      rmSync(candidate);
    } catch {
      // A leaked candidate grants no authority; only the canonical link does.
    }
  }
}

/**
 * Try to take the scheduler lock for a project. Returns the live holder when
 * another daemon owns it; a lock held by a dead process (or a recycled PID) is
 * removed and taken over under an exclusive reclamation guard. Re-acquiring a
 * lock this process already holds succeeds. Filesystem and ambiguous ownership
 * failures fail closed: skipping schedules is safer than double-running their
 * side effects.
 *
 * The reclaim guard deliberately is not auto-swept. It exists only across a
 * short synchronous critical section and is removed in `finally`; if a process
 * is killed inside that section, a future daemon refuses to guess at ownership
 * until an operator removes the orphaned `.reclaim` file.
 */
export function acquireSchedulerLock(projectRoot: string): SchedulerLockResult {
  const path = schedulerLockPath(projectRoot);
  const reclaimPath = schedulerLockReclaimPath(projectRoot);
  const procStartedAt = getCurrentProcessStartTime();
  const entry: SchedulerLockHolder = {
    pid: process.pid,
    ...(procStartedAt && { procStartedAt }),
    acquiredAt: Date.now(),
  };
  const payload = JSON.stringify(entry, null, 2);

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return denied(path, `cannot create scheduler lock directory: ${(error as Error).message}`);
  }

  // Nobody may create or reclaim the canonical lock while another process is
  // inside stale-lock reclamation. A contender that passed this check just
  // before the guard was created is still safe: the reclaimer re-reads the
  // canonical holder after acquiring the guard and never removes a live one.
  if (existsSync(reclaimPath)) {
    return denied(
      reclaimPath,
      `scheduler lock reclamation is already in progress; if no daemon is reclaiming, remove ${reclaimPath}`
    );
  }

  try {
    writeLockExclusive(path, payload);
    ensureLocalGitExclude(projectRoot);
    return { acquired: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return denied(path, `cannot create scheduler lock: ${(error as Error).message}`);
    }
  }

  const initialHolder = readHolder(path);
  if (initialHolder?.pid === process.pid) return { acquired: true };
  if (initialHolder) {
    const state = processRefState(initialHolder);
    if (state === 'alive') return { acquired: false, holder: initialHolder };
    if (state === 'ambiguous') return ambiguousHolder(path, initialHolder);
  }

  // Serialize the stale check + removal. The canonical holder is re-read only
  // after this exclusive guard is held, closing the check-then-unlink race.
  try {
    writeLockExclusive(reclaimPath, payload);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return denied(
        reclaimPath,
        `scheduler lock reclamation is already in progress; if no daemon is reclaiming, remove ${reclaimPath}`
      );
    }
    return denied(path, `cannot claim scheduler lock reclamation: ${(error as Error).message}`);
  }

  try {
    const currentHolder = readHolder(path);
    if (currentHolder?.pid === process.pid) return { acquired: true };
    if (currentHolder) {
      const state = processRefState(currentHolder);
      if (state === 'alive') return { acquired: false, holder: currentHolder };
      if (state === 'ambiguous') return ambiguousHolder(path, currentHolder);
    }

    try {
      rmSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return denied(path, `cannot remove stale scheduler lock: ${(error as Error).message}`);
      }
    }

    try {
      writeLockExclusive(path, payload);
      ensureLocalGitExclude(projectRoot);
      return { acquired: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return denied(path, 'another daemon acquired the scheduler lock during reclamation');
      }
      return denied(path, `cannot create scheduler lock after reclamation: ${(error as Error).message}`);
    }
  } finally {
    try {
      if (readFileSync(reclaimPath, 'utf-8') === payload) rmSync(reclaimPath);
    } catch {
      // Fail closed on the next acquisition if cleanup did not complete.
    }
  }
}

/** Remove the lock if this process owns it. */
export function releaseSchedulerLock(projectRoot: string): void {
  const path = schedulerLockPath(projectRoot);
  try {
    const holder = JSON.parse(readFileSync(path, 'utf-8')) as SchedulerLockHolder;
    if (holder.pid === process.pid) rmSync(path);
  } catch {
    // Missing or unreadable: nothing owned, nothing to release.
  }
}
