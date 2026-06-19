import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'http';
import { ApprovalEventHub, ApprovalListEventHub, type ApprovalListPoll, type SessionPoll, type SessionSnapshot } from '../src/cli/serve/sse';
import type { ApprovalLogEntry } from '../src/cli/serve/types';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
}

function log(id: string, status: string, title: string): ApprovalLogEntry {
  return { id, type: 'tool', status, title };
}

/** Read SSE chunks until `predicate(buffer)` is true or the timeout elapses. */
async function readUntil(res: Response, predicate: (buf: string) => boolean, ms = 2000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (predicate(buf)) break;
  }
  await reader.cancel().catch(() => {});
  return buf;
}

describe('ApprovalEventHub', () => {
  let hub: ApprovalEventHub;
  let server: Server;
  let port: number;
  let snapshot: SessionSnapshot;
  let failNext: { code: string; message: string } | null;

  beforeEach(async () => {
    hub = new ApprovalEventHub({ liveIntervalMs: 30, idleIntervalMs: 30, heartbeatIntervalMs: 10_000 });
    snapshot = { status: 'waiting', approval: { sessionId: 's1', sessionStatus: 'suspended', agent: { id: 'a', name: 'A' } }, logs: [log('1', 'pending', 'Approve me')] };
    failNext = null;
    const poll: SessionPoll = async () =>
      failNext ? { ok: false, error: failNext } : { ok: true, snapshot };
    server = createServer((req, res) => {
      hub.subscribe({ key: 's1', sessionId: 's1', poll, req, res });
    });
    port = await listen(server);
  });

  afterEach(() => {
    hub.shutdown();
    server.close();
  });

  it('replays status and log events to a new subscriber', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/s1/events`);
    const buf = await readUntil(res, (b) => b.includes('event: status') && b.includes('event: log'));
    expect(buf).toContain('event: status');
    expect(buf).toContain('"status":"waiting"');
    expect(buf).toContain('event: log');
    expect(buf).toContain('Approve me');
    // The status event must NOT carry the logs array (kept separate).
    const statusLine = buf.split('\n').find((l) => l.startsWith('data:') && l.includes('"approval"'))!;
    expect(statusLine).not.toContain('"logs"');
  });

  it('replays logs immediately when a new subscriber joins an idle session loop', async () => {
    const slowHub = new ApprovalEventHub({ liveIntervalMs: 30, idleIntervalMs: 1000, heartbeatIntervalMs: 10_000 });
    const poll: SessionPoll = async () => ({ ok: true, snapshot });
    const slowServer = createServer((req, res) => {
      slowHub.subscribe({ key: 's1', sessionId: 's1', poll, req, res });
    });
    const slowPort = await listen(slowServer);

    try {
      const first = await fetch(`http://127.0.0.1:${slowPort}/sessions/s1/events`);
      await readUntil(first, (b) => b.includes('event: log'), 500);

      const second = await fetch(`http://127.0.0.1:${slowPort}/sessions/s1/events`);
      const buf = await readUntil(second, (b) => b.includes('event: log'), 250);
      expect(buf).toContain('event: status');
      expect(buf).toContain('event: log');
      expect(buf).toContain('Approve me');

      await first.body?.cancel().catch(() => {});
      await second.body?.cancel().catch(() => {});
    } finally {
      slowHub.shutdown();
      slowServer.close();
    }
  });

  it('emits a log delta when an entry changes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/s1/events`);
    // Mutate the shared snapshot shortly after subscribing; a later poll tick
    // should broadcast the changed entry on the same stream.
    setTimeout(() => { snapshot = { ...snapshot, logs: [log('1', 'success', 'Approved')] }; }, 80);
    const buf = await readUntil(res, (b) => b.includes('Approved'));
    expect(buf).toContain('Approved');
  });

  it('surfaces a stream-error event on poll failure without closing', async () => {
    failNext = { code: 'SESSION_NOT_FOUND', message: 'gone' };
    const res = await fetch(`http://127.0.0.1:${port}/sessions/s1/events`);
    const buf = await readUntil(res, (b) => b.includes('event: stream-error'));
    expect(buf).toContain('stream-error');
    expect(buf).toContain('SESSION_NOT_FOUND');
  });

  it('stops the poll loop when the last subscriber disconnects', async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/sessions/s1/events`, { signal: controller.signal });
    await readUntil(res, (b) => b.includes('event: status'));
    expect(hub.activeLoopCount()).toBe(1);
    controller.abort();
    // Give the server a moment to fire the close handler.
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.activeLoopCount()).toBe(0);
  });
});

describe('ApprovalListEventHub', () => {
  let hub: ApprovalListEventHub<{ pending: number; label: string }>;
  let server: Server;
  let port: number;
  let snapshot: { pending: number; label: string };
  let failNext: { code: string; message: string } | null;

  beforeEach(async () => {
    hub = new ApprovalListEventHub({ intervalMs: 30, heartbeatIntervalMs: 10_000 });
    snapshot = { pending: 1, label: 'first approval' };
    failNext = null;
    const poll: ApprovalListPoll<typeof snapshot> = async () =>
      failNext ? { ok: false, error: failNext } : { ok: true, snapshot };
    server = createServer((req, res) => {
      hub.subscribe({ key: 'approvals::', poll, req, res });
    });
    port = await listen(server);
  });

  afterEach(() => {
    hub.shutdown();
    server.close();
  });

  it('streams approval list snapshots to subscribers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/events`);
    const buf = await readUntil(res, (b) => b.includes('event: approvals'));
    expect(buf).toContain('event: approvals');
    expect(buf).toContain('first approval');
  });

  it('emits a new snapshot when the approval list changes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/events`);
    setTimeout(() => { snapshot = { pending: 2, label: 'second approval' }; }, 80);
    const buf = await readUntil(res, (b) => b.includes('second approval'));
    expect(buf).toContain('"pending":2');
    expect(buf).toContain('second approval');
  });

  it('surfaces stream errors without closing the list stream', async () => {
    failNext = { code: 'LIST_APPROVALS_ERROR', message: 'temporary failure' };
    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/events`);
    const buf = await readUntil(res, (b) => b.includes('event: stream-error'));
    expect(buf).toContain('stream-error');
    expect(buf).toContain('LIST_APPROVALS_ERROR');
  });

  it('stops the list poll loop when the last subscriber disconnects', async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/events`, { signal: controller.signal });
    await readUntil(res, (b) => b.includes('event: approvals'));
    expect(hub.activeLoopCount()).toBe(1);
    controller.abort();
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.activeLoopCount()).toBe(0);
  });
});
