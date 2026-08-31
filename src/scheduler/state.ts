import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix } from 'node:path';
import { getProjectDirSync } from '../storage/paths.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

interface ScheduleStateFile {
  version: 1;
  pausedSchedules: string[];
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

export async function loadPausedSchedules(projectRoot: string): Promise<Set<string>> {
  const file = scheduleStatePath(projectRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
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
  return paused;
}

export async function setSchedulePaused(projectRoot: string, agentPath: string, paused: boolean): Promise<Set<string>> {
  const normalized = normalizeScheduleAgentPath(agentPath);
  const current = await loadPausedSchedules(projectRoot);
  if (paused) current.add(normalized);
  else current.delete(normalized);
  const file = scheduleStatePath(projectRoot);
  await mkdir(dirname(file), { recursive: true });
  const state: ScheduleStateFile = { version: 1, pausedSchedules: [...current].sort() };
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return current;
}

export async function isSchedulePaused(projectRoot: string, agentPath: string): Promise<boolean> {
  return (await loadPausedSchedules(projectRoot)).has(normalizeScheduleAgentPath(agentPath));
}
