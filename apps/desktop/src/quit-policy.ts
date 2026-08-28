export interface DesktopQuitPolicy {
  requestFullQuit(): void;
  shouldTerminate(): boolean;
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
