import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { reloadOnChunkError } from '../src/cli/serve/web/lib/lazy-route';

// reloadOnChunkError runs in the browser and touches sessionStorage +
// location.reload. Stub both so the pure recovery logic can be exercised
// under bun. A resolved import must pass through untouched; a rejected one
// (a route chunk 404'd by a redeploy) must trigger exactly one reload and
// then suspend, with a time-boxed guard preventing a reload loop.

let reloadCount = 0;
const store = new Map<string, string>();

beforeEach(() => {
  reloadCount = 0;
  store.clear();
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).location = { reload: () => { reloadCount++; } };
});

afterEach(() => {
  delete (globalThis as any).sessionStorage;
  delete (globalThis as any).location;
});

/** Resolves if `p` settles first, rejects if `timeoutMs` elapses first. */
function settlesWithin<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('did not settle')), timeoutMs)),
  ]);
}

describe('reloadOnChunkError', () => {
  it('passes a successful import through unchanged and never reloads', async () => {
    const mod = { default: 'AgentDetail' };
    const wrapped = reloadOnChunkError(() => Promise.resolve(mod));
    await expect(wrapped()).resolves.toBe(mod);
    expect(reloadCount).toBe(0);
  });

  it('reloads once and suspends (never settles) when a chunk import fails', async () => {
    const wrapped = reloadOnChunkError(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module'))
    );
    const p = wrapped();
    // The returned promise must stay pending so the route keeps suspending
    // until the reload swaps the document.
    await expect(settlesWithin(p, 50)).rejects.toThrow('did not settle');
    expect(reloadCount).toBe(1);
    expect(sessionStorage.getItem('agentuse-chunk-reload-at')).not.toBeNull();
  });

  it('does not reload a second time within the guard window (no loop)', async () => {
    // Pretend a reload just happened (guard freshly stamped).
    sessionStorage.setItem('agentuse-chunk-reload-at', String(Date.now()));
    const wrapped = reloadOnChunkError(() => Promise.reject(new Error('chunk 404')));
    await expect(wrapped()).rejects.toThrow('chunk 404');
    expect(reloadCount).toBe(0);
  });

  it('reloads again once the guard window has elapsed (a later deploy)', async () => {
    // A stale stamp from well over the window ago must not block recovery.
    sessionStorage.setItem('agentuse-chunk-reload-at', String(Date.now() - 60_000));
    const wrapped = reloadOnChunkError(() => Promise.reject(new Error('chunk 404')));
    await expect(settlesWithin(wrapped(), 50)).rejects.toThrow('did not settle');
    expect(reloadCount).toBe(1);
  });
});
