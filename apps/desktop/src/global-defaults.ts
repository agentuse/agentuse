import { loadGlobalDefaults } from "../../../src/utils/global-config";

/** Load the user-global environment before Desktop registers any IPC handler,
 * probes a server, reports provider readiness, or constructs a CLI child. Kept
 * outside main.ts so Finder-style startup can be tested without importing
 * Electron's process-global application object. */
export function initializeDesktopGlobalDefaults(): ReturnType<typeof loadGlobalDefaults> {
  return loadGlobalDefaults();
}
