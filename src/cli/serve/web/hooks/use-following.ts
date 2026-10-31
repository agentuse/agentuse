import { useEffect, useState } from 'preact/hooks';
import { addFollowing, fetchFollowing, setFollowing } from '../lib/api';

/**
 * The agents the person follows, shared by every view on the page: the
 * Agents page stars them and lists them first, Sessions narrows to them. The
 * list lives on the daemon so the phone and the desktop agree.
 *
 * Keys are `${projectId}::${path}`. Pins from before following existed were
 * kept in this browser's localStorage under the same keys; the first load
 * moves them to the daemon and clears the local copy.
 */
const LEGACY_PINS_KEY = 'agentuse-pinned-agents';

interface FollowableAgent {
  projectId: string;
  path: string;
}

interface FollowingState {
  keys: string[];
  loaded: boolean;
  error: Error | null;
}

let state: FollowingState = { keys: [], loaded: false, error: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function update(next: Partial<FollowingState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function followKey(a: FollowableAgent): string {
  return `${a.projectId}::${a.path}`;
}

function readLegacyPins(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_PINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.includes('::')) : [];
  } catch {
    return [];
  }
}

function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const legacy = readLegacyPins();
      const { agents } = legacy.length > 0 ? await addFollowing(legacy) : await fetchFollowing();
      if (legacy.length > 0) {
        try { localStorage.removeItem(LEGACY_PINS_KEY); } catch { /* storage unavailable */ }
      }
      update({ keys: agents, loaded: true, error: null });
    } catch (error) {
      // Leave `loading` cleared so the next view to mount tries again.
      loading = null;
      update({ loaded: true, error: error instanceof Error ? error : new Error(String(error)) });
    }
  })();
  return loading;
}

async function toggle(a: FollowableAgent): Promise<void> {
  const key = followKey(a);
  const before = state.keys;
  const follow = !before.includes(key);
  // Optimistic, so the star flips on the click; the daemon's answer wins.
  update({ keys: follow ? [...before, key] : before.filter((k) => k !== key), error: null });
  try {
    const { agents } = await setFollowing(key, follow);
    update({ keys: agents });
  } catch (error) {
    update({ keys: before, error: error instanceof Error ? error : new Error(String(error)) });
  }
}

export function useFollowing(): FollowingState & {
  isFollowing: (a: FollowableAgent) => boolean;
  toggle: (a: FollowableAgent) => Promise<void>;
} {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    void load();
    return () => { listeners.delete(listener); };
  }, []);
  return {
    ...state,
    isFollowing: (a) => state.keys.includes(followKey(a)),
    toggle,
  };
}
