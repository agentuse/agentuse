// Cloud mode: the same dashboard served by AgentUse Cloud (cloud.agentuse.io)
// for a signed-in account, reaching one of its computers at a time. The Cloud
// Worker marks its shell with `window.__AGENTUSE_CLOUD__` (as static.ts does
// the brand), so the first render already knows. Locally nothing here
// changes a URL.
//
// Every daemon request goes through `daemonUrl`: locally the path is used as
// is; in cloud mode it is prefixed with `/api/m/<machine>`, and Cloud relays
// the rest of the path, unchanged, to that computer.

declare global {
  interface Window {
    __AGENTUSE_CLOUD__?: { account?: string };
  }
}

export interface CloudMachine {
  id: string;
  name: string;
  platform?: string;
  online: boolean;
  lastSeen?: number;
  version?: string;
  apiVersion?: number;
  features: string[];
  /** Relays the dashboard: says `http` and meets Cloud's minimum API version. */
  compatible: boolean;
}

export interface CloudMachinesPayload {
  machines: CloudMachine[];
  minApiVersion: number;
  /** For a `?m=` id that is no longer connected: the newest connected computer with its name. */
  resolved?: string;
}

const STORAGE_KEY = 'agentuse-cloud-machine';

/**
 * Web Push belongs to the account in cloud mode: Cloud keeps the devices and
 * sends what the computers hand it, so these stay on Cloud's own origin.
 */
const CLOUD_OWNED_PATHS = new Set(['/api/push/public-key', '/api/push/subscription', '/api/push/unsubscribe']);

let selected: string | undefined;

export function isCloudMode(): boolean {
  return typeof window !== 'undefined' && window.__AGENTUSE_CLOUD__ !== undefined;
}

export function cloudAccount(): string | undefined {
  return typeof window !== 'undefined' ? window.__AGENTUSE_CLOUD__?.account : undefined;
}

export function selectedMachineId(): string | undefined {
  return selected;
}

export function selectMachine(id: string): void {
  selected = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private windows: the choice lasts for this page only.
  }
}

export function rememberedMachineId(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The browser path for a daemon path such as `/api/agents` or `/sessions/s1/status`. */
export function daemonUrl(path: string): string {
  if (!isCloudMode() || CLOUD_OWNED_PATHS.has(path.split('?')[0]!)) return path;
  if (!selected) throw new Error('No computer is selected.');
  return `/api/m/${encodeURIComponent(selected)}${path}`;
}

/**
 * Which computer this page shows. A deep link's `?m=` wins; a computer that
 * was disconnected and connected again (a new id, the same name) is followed
 * through Cloud's `resolved`. Without a link, the computer this browser used
 * last, else the only one. Undefined means the person picks.
 */
export function chooseMachine(
  payload: CloudMachinesPayload,
  requested: string | undefined,
  remembered: string | undefined,
): string | undefined {
  const known = (id: string | undefined) => (id && payload.machines.some((machine) => machine.id === id) ? id : undefined);
  if (requested) return known(requested) ?? known(payload.resolved);
  return known(remembered) ?? (payload.machines.length === 1 ? payload.machines[0]!.id : undefined);
}

/** A dashboard link that opens on the same computer, for copying or sharing. */
export function withMachine(url: string): string {
  if (!isCloudMode() || !selected) return url;
  const parsed = new URL(url, location.origin);
  parsed.searchParams.set('m', selected);
  return parsed.toString();
}

export async function fetchCloudMachines(requested?: string): Promise<CloudMachinesPayload> {
  const url = new URL('/api/machines', location.origin);
  if (requested) url.searchParams.set('m', requested);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
    throw new Error('Signed out');
  }
  if (!response.ok) throw new Error(`Could not list your computers (${response.status})`);
  return response.json() as Promise<CloudMachinesPayload>;
}

export async function requestMachineUpdate(id: string): Promise<void> {
  const response = await fetch(`/api/machines/${encodeURIComponent(id)}/update`, { method: 'POST', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Could not ask this computer to update (${response.status})`);
  }
}
