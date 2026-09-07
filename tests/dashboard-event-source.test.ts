import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DashboardEventSource } from '../src/cli/serve/web/lib/dashboard-event-source';

class FakeEventSource extends EventTarget {
  static CONNECTING = 0;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  constructor(readonly url: string | URL) {
    super();
    FakeEventSource.instances.push(this);
  }
  close(): void { this.readyState = FakeEventSource.CLOSED; }
}

// Models the shared origin lock manager used by independent browser tabs.
class OriginLocks {
  held = new Set<string>();
  async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>): Promise<void> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { await callback({ name }); } finally { this.held.delete(name); }
  }
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
const streams: DashboardEventSource[] = [];
let locks: OriginLocks;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function stream(): DashboardEventSource {
  const source = new DashboardEventSource('http://localhost/sessions/smoke/events');
  streams.push(source);
  return source;
}

beforeEach(() => {
  locks = new OriginLocks();
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
});

afterEach(async () => {
  for (const source of streams.splice(0)) source.close();
  await settle();
  for (const [key, descriptor] of [['navigator', originalNavigator], ['EventSource', originalEventSource]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('dashboard stream connection budget', () => {
  it('leaves two HTTP/1.1 connections free across two pages and falls back without queueing a network connection', async () => {
    const firstPage = [stream(), stream(), stream()];
    const secondPage = [stream(), stream(), stream()];
    let fallbacks = 0;
    for (const source of [...firstPage, ...secondPage]) {
      source.addEventListener('error', () => {
        expect(source.readyState).toBe(FakeEventSource.CLOSED);
        fallbacks += 1;
      });
    }
    await settle();
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(locks.held.size).toBe(4);
    expect(fallbacks).toBe(2);
    const connected = [...firstPage, ...secondPage].find((source) => source.readyState !== FakeEventSource.CLOSED)!;
    connected.close();
    await settle();
    const replacement = stream();
    await settle();
    expect(replacement.readyState).toBe(1);
    expect(locks.held.size).toBe(4);
    expect(FakeEventSource.instances.filter((source) => source.readyState !== FakeEventSource.CLOSED)).toHaveLength(4);
  });

  it('forwards named message data and native connection state', async () => {
    const source = stream();
    const received: string[] = [];
    source.addEventListener('status', (event) => received.push((event as MessageEvent).data));
    await settle();
    FakeEventSource.instances[0]!.dispatchEvent(new MessageEvent('status', { data: '{"status":"completed"}' }));
    expect(received).toEqual(['{"status":"completed"}']);
    source.close();
    FakeEventSource.instances[0]!.dispatchEvent(new MessageEvent('status', { data: 'late' }));
    expect(received).toHaveLength(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('releases a lock when unmounted during acquisition', async () => {
    const source = stream();
    // Allow acquisition to start, then unmount before the native connection.
    await Promise.resolve();
    source.close();
    await settle();
    expect(locks.held.size).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('uses polling instead of unbounded streams when origin locks are unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const source = stream();
    let failed = false;
    source.addEventListener('error', () => { failed = true; });
    await settle();
    expect(failed).toBe(true);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('releases its reservation when native stream creation fails', async () => {
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class extends FakeEventSource {
      constructor(url: string | URL) { super(url); throw new Error('cannot connect'); }
    } });
    const source = stream();
    let failed = false;
    source.addEventListener('error', () => { failed = true; });
    await settle();
    expect(failed).toBe(true);
    expect(locks.held.size).toBe(0);
  });
});
