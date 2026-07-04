/**
 * Finishes push-notification deep links. The service worker cannot trust
 * clients.openWindow(url) on iOS — a cold home-screen app launches at
 * start_url and the requested URL is ignored — so on tap it parks the target
 * in the Cache API and (for warm windows) posts a navigate message. This
 * module runs at app boot: consume the parked target if it is fresh, and
 * listen for the warm-window message.
 */

const NAV_CACHE = 'agentuse-push-nav';
const PENDING_KEY = '/pending-navigation';
// Anything older than this is a stale leftover (e.g. a tap whose openWindow
// actually worked), not the launch we are currently handling.
const MAX_AGE_MS = 2 * 60 * 1000;

function sameOriginUrl(raw: string): URL | null {
  try {
    const url = new URL(raw, location.origin);
    return url.origin === location.origin ? url : null;
  } catch {
    return null;
  }
}

async function takePendingUrl(): Promise<string | null> {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(NAV_CACHE);
    const response = await cache.match(PENDING_KEY);
    if (!response) return null;
    await cache.delete(PENDING_KEY);
    const parsed = (await response.json()) as { url?: unknown; at?: unknown };
    if (typeof parsed.url !== 'string' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed.url;
  } catch {
    return null;
  }
}

export function initPushNavigation(): void {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== 'push-navigate' || typeof data.url !== 'string') return;
    void takePendingUrl(); // consumed via message; don't replay it on next boot
    const target = sameOriginUrl(data.url);
    if (target && target.pathname !== location.pathname) location.assign(target.href);
  });

  void (async () => {
    // On a cold launch the service worker's cache write races app boot, so
    // check a few times before concluding there is no parked target.
    for (const delay of [0, 400, 1200, 2400]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const raw = await takePendingUrl();
      if (!raw) continue;
      const target = sameOriginUrl(raw);
      if (target && target.pathname !== location.pathname) location.replace(target.href);
      return;
    }
  })();
}
