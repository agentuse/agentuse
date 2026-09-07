/**
 * HTTP/1.1 connection limits are shared across tabs, not per page. Reserve at
 * most four connections for dashboard streams so API reads and actions can
 * still run. Web Locks provide an origin-wide budget and release on tab exit.
 * If a slot is unavailable (or Web Locks are unsupported), report CLOSED so
 * the existing stream hooks use polling, or a static fallback for live tails.
 */
const STREAM_SLOTS = 4;
const EVENTS = ['open', 'error', 'status', 'log', 'stream-error', 'sessions', 'approvals'];

export class DashboardEventSource extends EventTarget {
  private source: EventSource | null = null;
  private closed = false;
  private release: (() => void) | undefined;

  constructor(private readonly url: string | URL) {
    super();
    // Callers register handlers synchronously, before acquisition can fail.
    queueMicrotask(() => void this.connect().catch(() => this.fail()));
  }

  get readyState(): number {
    return this.closed ? EventSource.CLOSED : (this.source?.readyState ?? EventSource.CONNECTING);
  }

  close(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
    this.release?.();
    this.release = undefined;
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.dispatchEvent(new Event('error'));
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      this.fail();
      return;
    }

    for (let slot = 0; slot < STREAM_SLOTS; slot += 1) {
      const acquired = await new Promise<boolean>((resolve, reject) => {
        void locks.request(`agentuse-dashboard-stream-${slot}`, { ifAvailable: true }, async (lock) => {
          if (!lock || this.closed) {
            resolve(false);
            return;
          }
          const released = new Promise<void>((release) => { this.release = release; });
          resolve(true);
          await released;
        }).catch(reject);
      });
      if (this.closed) return;
      if (!acquired) continue;

      const source = new EventSource(this.url);
      this.source = source;
      for (const type of EVENTS) {
        source.addEventListener(type, (event) => {
          if (this.closed) return;
          this.dispatchEvent(event instanceof MessageEvent
            ? new MessageEvent(type, { data: event.data, lastEventId: event.lastEventId, origin: event.origin })
            : new Event(type));
        });
      }
      return;
    }
    this.fail();
  }
}
