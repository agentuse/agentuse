declare global {
  /**
   * Developer-only surfaces in the dashboard: Settings > Developer and the
   * session page fixtures it links to. The web build defines this (true under
   * `build:web --watch` or `AGENTUSE_WEB_DEV=1`, false in a release build);
   * outside the bundle (tests, the server) it is undefined.
   *
   * Read it inline as `typeof __AGENTUSE_WEB_DEV__ !== 'undefined' && __AGENTUSE_WEB_DEV__`
   * at each use site, never through a shared constant: the bundler folds the
   * literal in place and drops the dead branch (and the fixtures chunk with
   * it) only when the identifier is in the same file as the branch.
   */
  const __AGENTUSE_WEB_DEV__: boolean | undefined;
}

/** Session ids under this prefix are served from fixtures, not the daemon. */
export const FIXTURE_SESSION_PREFIX = 'fixture-';
