import { loadPausedSchedules } from "../../scheduler/state.js";
import { toErrorMessage } from "../../utils/error-message.js";
import { logger } from "../../utils/logger";

/**
 * Serve's view of each project's persisted schedule pauses.
 *
 * A schedule-state file that exists but cannot be read leaves the project's
 * pauses unknown. Treating that as "nothing paused" would silently re-arm
 * schedules the operator paused, so the project fails closed instead: its
 * schedules are listed but not armed, and the error is kept for /schedules.
 * A missing file is not an error (the loader returns an empty set).
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
    state.paused.set(projectId, await loadPausedSchedules(projectRoot));
    state.errors.delete(projectId);
  } catch (error) {
    const message = toErrorMessage(error);
    logger.warn(`Could not load schedule state for ${projectId}; its schedules stay disarmed until the file is fixed or removed and serve restarts: ${message}`);
    state.paused.set(projectId, new Set());
    state.errors.set(projectId, message);
  }
}

/** `statePath` is the normalized project-relative agent path. */
export function projectScheduleEnabled(state: ProjectScheduleState, projectId: string, statePath: string): boolean {
  return !state.errors.has(projectId) && !state.paused.get(projectId)?.has(statePath);
}
