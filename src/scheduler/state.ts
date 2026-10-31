import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix } from 'node:path';
import { getProjectDirSync } from '../storage/paths.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withSerializedOwnershipLock } from '../utils/ownership-lock.js';

/** A pause the daemon made on its own (see cli/serve/auto-pause.ts). */
export interface ScheduleAutoPause {
  at: number;
  reason: string;
  sessionId: string;
}

interface ScheduleStateFile {
  version: 1;
  pausedSchedules: string[];
  /** Why the daemon paused a schedule, by agent path. Absent for a pause a
   *  person made. Optional, so a file written before it existed still reads. */
  autoPaused?: Record<string, ScheduleAutoPause>;
}

export interface ScheduleState {
  paused: Set<string>;
  autoPaused: Map<string, ScheduleAutoPause>;
}

function withScheduleStateLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withSerializedOwnershipLock(`${file}.lock`, operation, {
    staleMs: 30_000,
    retryMs: 20,
    maxWaitMs: 5_000,
    label: 'schedule-state',
  });
}

export function scheduleStatePath(projectRoot: string): string {
  return `${getProjectDirSync(projectRoot)}/schedule-state.json`;
}

export function normalizeScheduleAgentPath(agentPath: string): string {
  const normalized = posix.normalize(agentPath.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid project-relative agent path: ${agentPath}`);
  }
  return normalized;
}

function isAutoPause(value: unknown): value is ScheduleAutoPause {
  const v = value as Partial<ScheduleAutoPause> | null;
  return !!v && typeof v === 'object' && typeof v.at === 'number' && typeof v.reason === 'string' && typeof v.sessionId === 'string';
}

export async function loadScheduleState(projectRoot: string): Promise<ScheduleState> {
  const file = scheduleStatePath(projectRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paused: new Set(), autoPaused: new Map() };
    throw new Error(`Could not read schedule state at ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as any).version !== 1 || !Array.isArray((parsed as any).pausedSchedules)) {
    throw new Error(`Invalid schedule state at ${file}`);
  }
  const paused = new Set<string>();
  for (const value of (parsed as any).pausedSchedules) {
    if (typeof value !== 'string') throw new Error(`Invalid schedule state at ${file}`);
    paused.add(normalizeScheduleAgentPath(value));
  }
  const autoPaused = new Map<string, ScheduleAutoPause>();
  const rawAuto: unknown = (parsed as any).autoPaused;
  if (rawAuto !== undefined) {
    if (!rawAuto || typeof rawAuto !== 'object' || Array.isArray(rawAuto)) throw new Error(`Invalid schedule state at ${file}`);
    for (const [path, value] of Object.entries(rawAuto)) {
      if (!isAutoPause(value)) throw new Error(`Invalid schedule state at ${file}`);
      const normalized = normalizeScheduleAgentPath(path);
      // A reason only means something while the schedule is still paused.
      if (paused.has(normalized)) autoPaused.set(normalized, value);
    }
  }
  return { paused, autoPaused };
}

export async function loadPausedSchedules(projectRoot: string): Promise<Set<string>> {
  return (await loadScheduleState(projectRoot)).paused;
}

/**
 * Pause or resume one schedule. `autoPause` marks a pause the daemon made and
 * why; any other change (a person pausing, or resuming) clears that reason.
 */
export async function setSchedulePaused(
  projectRoot: string,
  agentPath: string,
  paused: boolean,
  autoPause?: ScheduleAutoPause,
): Promise<Set<string>> {
  const normalized = normalizeScheduleAgentPath(agentPath);
  const file = scheduleStatePath(projectRoot);
  return withScheduleStateLock(file, async () => {
    const current = await loadScheduleState(projectRoot);
    if (paused) current.paused.add(normalized);
    else current.paused.delete(normalized);
    if (paused && autoPause) current.autoPaused.set(normalized, autoPause);
    else current.autoPaused.delete(normalized);
    await mkdir(dirname(file), { recursive: true });
    const state: ScheduleStateFile = {
      version: 1,
      pausedSchedules: [...current.paused].sort(),
      ...(current.autoPaused.size > 0 && {
        autoPaused: Object.fromEntries([...current.autoPaused].sort(([a], [b]) => a.localeCompare(b))),
      }),
    };
    await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
    return current.paused;
  });
}

export async function isSchedulePaused(projectRoot: string, agentPath: string): Promise<boolean> {
  return (await loadPausedSchedules(projectRoot)).has(normalizeScheduleAgentPath(agentPath));
}
