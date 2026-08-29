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

export async function deferDesktopQuitAfterDrain(
  stopOwnedServer: () => Promise<void>,
  requestQuit: () => void,
  defer: (callback: () => void) => unknown = (callback) => setImmediate(callback),
): Promise<void> {
  try {
    await stopOwnedServer();
  } finally {
    // `before-quit` is prevented while the server drains. Even when there is
    // no owned server and the promise resolves immediately, wait until the
    // current event dispatch has unwound before asking Electron to quit again.
    defer(requestQuit);
  }
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
