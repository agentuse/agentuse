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
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getCurrentProcessStartTime, getProcessStartTime, isPidAlive } from './process-info';

export interface SchedulerLockHolder {
  pid: number;
  /** Process-start-time token guarding against a recycled PID. */
  procStartedAt?: string;
  acquiredAt: number;
}

export type SchedulerLockResult =
  | { acquired: true }
  | { acquired: false; holder: SchedulerLockHolder };

export function schedulerLockPath(projectRoot: string): string {
  return join(projectRoot, '.agentuse', 'scheduler.lock');
}

const GIT_EXCLUDE_PATTERN = '.agentuse/scheduler.lock';

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
    if (current.split('\n').some((line) => line.trim() === GIT_EXCLUDE_PATTERN)) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${GIT_EXCLUDE_PATTERN}\n`);
  } catch {
    // Ignore: purely cosmetic.
  }
}

function isHolderAlive(holder: SchedulerLockHolder): boolean {
  if (typeof holder.pid !== 'number' || !isPidAlive(holder.pid)) return false;
  if (!holder.procStartedAt) return true;
  const current = getProcessStartTime(holder.pid);
  if (!current) return true;
  return current === holder.procStartedAt;
}

/**
 * Try to take the scheduler lock for a project. Returns the live holder when
 * another daemon owns it; a lock held by a dead process (or a recycled PID) is
 * removed and taken over. Re-acquiring a lock this process already holds
 * succeeds. Filesystem failures fail open (scheduling must not break on a
 * read-only or exotic checkout); the registry guard still applies there.
 */
export function acquireSchedulerLock(projectRoot: string): SchedulerLockResult {
  const path = schedulerLockPath(projectRoot);
  const procStartedAt = getCurrentProcessStartTime();
  const entry: SchedulerLockHolder = {
    pid: process.pid,
    ...(procStartedAt && { procStartedAt }),
    acquiredAt: Date.now(),
  };
  const payload = JSON.stringify(entry, null, 2);

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return { acquired: true };
  }

  // Two attempts: exclusive create, and on EEXIST evaluate the holder, sweep a
  // stale lock, then create exclusively again. The wx flag makes the create
  // atomic, so two daemons racing here cannot both win.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, payload, { flag: 'wx' });
      ensureLocalGitExclude(projectRoot);
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { acquired: true };
      }
    }

    let holder: SchedulerLockHolder | null = null;
    try {
      holder = JSON.parse(readFileSync(path, 'utf-8')) as SchedulerLockHolder;
    } catch {
      // Corrupt or vanished mid-read: treat as stale.
    }
    if (holder && holder.pid === process.pid) return { acquired: true };
    if (holder && isHolderAlive(holder)) return { acquired: false, holder };

    try {
      rmSync(path);
    } catch {
      // Lost a race to another sweeper; the retry's wx create decides.
    }
  }

  // Both creates lost to concurrent writers: report whoever holds it now.
  try {
    const holder = JSON.parse(readFileSync(path, 'utf-8')) as SchedulerLockHolder;
    if (holder.pid !== process.pid) return { acquired: false, holder };
  } catch {
    // Unreadable again: fail open rather than brick scheduling.
  }
  return { acquired: true };
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
