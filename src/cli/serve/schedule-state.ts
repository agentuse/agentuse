import { loadPausedSchedules } from "../../scheduler/state.js";
import { toErrorMessage } from "../../utils/error-message.js";
import { logger } from "../../utils/logger";
import type { Scheduler } from "../../scheduler/scheduler.js";

/**
 * Serve's view of each project's persisted schedule pauses.
 *
 * A schedule-state file that exists but cannot be read leaves the project's
 * pauses unknown. Treating that as "nothing paused" would silently re-arm
 * schedules the operator paused, so the project fails closed instead: its
 * schedules are listed but not armed, and the error is kept for /schedules.
 * A missing file is not an error (the loader returns an empty set). The load
 * is retried when the state is next needed (see retryProjectScheduleState), so
 * fixing or removing the file recovers the project without a serve restart.
 */
export interface ProjectScheduleState {
  paused: Map<string, Set<string>>;
  errors: Map<string, string>;
}

export function createProjectScheduleState(): ProjectScheduleState {
  return { paused: new Map(), errors: new Map() };
}

export async function loadProjectScheduleState(
  state: ProjectScheduleState,
  projectId: string,
  projectRoot: string,
): Promise<void> {
  try {
    recordProjectScheduleState(state, projectId, await loadPausedSchedules(projectRoot));
  } catch (error) {
    const message = toErrorMessage(error);
    // Retries hit the same broken file repeatedly; warn once per distinct error.
    if (state.errors.get(projectId) !== message) {
      logger.warn(`Could not load schedule state for ${projectId}; its schedules stay disarmed until the file is fixed or removed: ${message}`);
    }
    state.paused.set(projectId, new Set());
    state.errors.set(projectId, message);
  }
}

/**
 * Re-read the state of a project whose last load failed. Returns true when it
 * now loads, meaning the caller should re-arm the project's schedules.
 */
export async function retryProjectScheduleState(
  state: ProjectScheduleState,
  projectId: string,
  projectRoot: string,
): Promise<boolean> {
  if (!state.errors.has(projectId)) return false;
  await loadProjectScheduleState(state, projectId, projectRoot);
  if (state.errors.has(projectId)) return false;
  logger.info(`Schedule state for ${projectId} loaded; its schedules are armed again`);
  return true;
}

/**
 * Record pauses that were just read or written. A successful read or write
 * proves the file is usable again, so any earlier load error is cleared.
 */
export function recordProjectScheduleState(state: ProjectScheduleState, projectId: string, paused: Set<string>): void {
  state.paused.set(projectId, paused);
  state.errors.delete(projectId);
}

/** Bring every armed-or-disarmed schedule of a project in line with `isEnabled`. */
export function armProjectSchedules<P extends { id: string }>(
  scheduler: Pick<Scheduler, 'list' | 'setEnabled'>,
  project: P,
  isEnabled: (project: P, agentPath: string) => boolean,
): void {
  for (const schedule of scheduler.list()) {
    if (schedule.projectId === project.id) {
      scheduler.setEnabled(project.id, schedule.agentPath, isEnabled(project, schedule.agentPath));
    }
  }
}

/** `statePath` is the normalized project-relative agent path. */
export function projectScheduleEnabled(state: ProjectScheduleState, projectId: string, statePath: string): boolean {
  return !state.errors.has(projectId) && !state.paused.get(projectId)?.has(statePath);
}
