import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiRequestError, fetchPushPrefs, fetchPushPublicKey, postPushSubscription, type PushPrefs } from '../lib/api';

export type PushCategory = keyof PushPrefs;

/**
 * - unsupported: no push in this browser at all (bell hides)
 * - needs-install: iOS Safari tab — push only works from the home-screen app
 * - denied: user blocked notifications; only browser settings can undo it
 * - busy: probing current state or a toggle is in flight
 */
export type PushBellState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on' | 'busy';

function detectSupport(): 'ok' | 'needs-install' | 'unsupported' {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
  // iPadOS masquerades as macOS; the touch-points check catches it.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios && !standalone ? 'needs-install' : 'unsupported';
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

function subscriptionBody(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const json = sub.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) throw new Error('Push subscription missing encryption keys');
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** One line a human can act on; authorization failures name the real cause
 *  instead of a generic "failed". */
function toggleErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) {
    return 'The server refused: this browser has no operator access (API key required).';
  }
  return 'Could not update the setting on the server. Is the daemon reachable?';
}

/**
 * State machine behind a notification bell scoped to one category. First
 * enable does the whole chain (SW registration, permission prompt, push
 * subscribe, server registration) in the click's user gesture; subsequent
 * toggles just flip the server-side category pref. A failed toggle reverts
 * the state and reports why through `error` (cleared on the next attempt).
 */
export function usePushBell(category: PushCategory): { state: PushBellState; toggle: () => void; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<PushBellState>(() => {
    const support = detectSupport();
    return support === 'ok' ? 'busy' : support;
  });

  useEffect(() => {
    if (state !== 'busy') return;
    let cancelled = false;
    (async () => {
      if (Notification.permission === 'denied') return 'denied' as const;
      const sub = await currentSubscription();
      if (!sub) return 'off' as const;
      try {
        const { prefs } = await fetchPushPrefs(sub.endpoint);
        return prefs[category] ? ('on' as const) : ('off' as const);
      } catch {
        return 'off' as const; // 404: this device is unknown to the server
      }
    })()
      .then((next) => { if (!cancelled) setState(next); })
      .catch(() => { if (!cancelled) setState('off'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const toggle = useCallback(() => {
    if (state !== 'on' && state !== 'off') return;
    const wasOn = state === 'on';
    setState('busy');
    setError(null);
    (async () => {
      if (wasOn) {
        const sub = await currentSubscription();
        if (!sub) return 'off' as const;
        const result = await postPushSubscription({ subscription: subscriptionBody(sub), prefs: { [category]: false } });
        // Last category off → server dropped us; release the browser-side
        // subscription too so the push service can forget this device.
        if (!result.subscribed) await sub.unsubscribe().catch(() => {});
        return 'off' as const;
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return permission === 'denied' ? ('denied' as const) : ('off' as const);
      await navigator.serviceWorker.ready;
      let sub = await registration.pushManager.getSubscription();
      if (!sub) {
        const { publicKey } = await fetchPushPublicKey();
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        });
      }
      await postPushSubscription({ subscription: subscriptionBody(sub), prefs: { [category]: true } });
      return 'on' as const;
    })()
      .then(setState)
      .catch((err: unknown) => {
        setState(wasOn ? 'on' : 'off');
        setError(toggleErrorMessage(err));
      });
  }, [state, category]);

  return { state, toggle, error };
}
