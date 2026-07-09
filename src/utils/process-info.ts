import { execFileSync } from 'child_process';
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
 * Read an opaque, comparable process-start-time token for a PID, or null when it
 * can't be determined (process gone, or `ps`/proc unavailable). Tokens are only
 * meaningful for equality comparison, not parsing.
 */
export function getProcessStartTime(pid: number): string | null {
  const linuxStartTime = getLinuxProcessStartTime(pid);
  if (linuxStartTime) return linuxStartTime;

  try {
    const startTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return startTime ? `ps:${startTime}` : null;
  } catch {
    return null;
  }
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
