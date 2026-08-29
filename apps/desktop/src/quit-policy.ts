export interface DesktopQuitPolicy {
  requestFullQuit(): void;
  shouldTerminate(): boolean;
}

export interface OwnedServerState {
  exitCode: number | null;
  killed: boolean;
}

export function shouldWarnBeforeFullQuit(server: OwnedServerState | undefined): boolean {
  return Boolean(server && server.exitCode === null && !server.killed);
}

/**
 * macOS sends the same before-quit event for Dock Quit, Command+Q, and an
 * application-initiated quit. Keep termination opt-in so only the menu-bar
 * item's Quit command can authorize tearing down the background agent.
 */
export function createDesktopQuitPolicy(): DesktopQuitPolicy {
  let fullQuitRequested = false;
  return {
    requestFullQuit: () => { fullQuitRequested = true; },
    shouldTerminate: () => fullQuitRequested,
  };
}
