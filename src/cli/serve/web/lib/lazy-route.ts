/**
 * Wraps a route-chunk import thunk so it self-heals across deploys.
 *
 * Every `pnpm build` runs `rm -rf dist` and content-hashes each route chunk,
 * so a browser still running a previously-loaded build 404s the moment it
 * imports a route chunk it hadn't already cached (e.g. clicking into a brand-
 * new route). preact-iso's `lazy` throws the import promise to suspend, and the
 * Router only ever `.then()`s it — there is no reject path. A failed chunk
 * import therefore suspends the route *forever*: blank, non-interactive, and
 * (because <Topbar/>, which owns the theme effect, renders inside each route)
 * unthemed — falling back to the browser-default light look. The user's only
 * escape is a manual reload.
 *
 * Recover automatically: when a chunk import rejects, do a single full reload,
 * which fetches the current shell (served network-first by the service worker)
 * and its up-to-date chunk hashes. A short time-boxed guard in sessionStorage
 * prevents a reload loop if the failure is not deploy-related (a genuinely
 * broken build, an offline network): a second failure inside the window is
 * rethrown so it surfaces instead of spinning.
 *
 * Usage keeps preact-iso's own inference intact: `lazy(reloadOnChunkError(() => import('...')))`.
 */
const RELOAD_GUARD_KEY = 'agentuse-chunk-reload-at';
const RELOAD_GUARD_MS = 10_000;

export function reloadOnChunkError<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((err) => {
      let last = 0;
      try {
        last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
      } catch {
        // sessionStorage can throw in locked-down contexts; treat as no guard.
      }
      const now = Date.now();
      if (now - last > RELOAD_GUARD_MS) {
        try {
          sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
        } catch {
          // ignore — the reload below is still the right move.
        }
        location.reload();
        // Keep suspending until the reload takes over the document.
        return new Promise<T>(() => {});
      }
      // Already reloaded once recently and it still failed — don't loop.
      throw err;
    });
}
