import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __testing } from '../src/cli/serve';
import { readSessionResults } from '../src/cli/serve/stores';
import { Store } from '../src/store/store';
import { METRICS_STORE_NAME } from '../src/tools/metrics';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { isUnseenResultsRow, resultLabel, resultsHeadline } from '../src/cli/serve/web/components/session-results';

describe('readSessionResults', () => {
  it('groups record_metric facts by the session that wrote them, newest first', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-results-'));
    try {
      const store = new Store(projectRoot, METRICS_STORE_NAME, 'agents/poster');
      await store.create({ type: 'metric', data: { metric: 'posts_scheduled', count: 3, sessionId: 's1', note: '  Candidate A queued  ' } });
      await store.create({ type: 'metric', data: { metric: 'replies_posted', count: 1, value: 1, unit: 'count', sessionId: 's1' } });
      await store.create({ type: 'metric', data: { metric: 'posts_scheduled', count: 2, sessionId: 's2' } });
      // Not a metric, and a metric with no session: both ignored.
      await store.create({ type: 'note', data: { metric: 'posts_scheduled', sessionId: 's1' } });
      await store.create({ type: 'metric', data: { metric: 'orphan', count: 1 } });
      await store.releaseLock();

      const bySession = await readSessionResults(projectRoot);
      expect([...bySession.keys()].sort()).toEqual(['s1', 's2']);
      const s1 = bySession.get('s1')!;
      expect(s1.map((r) => r.metric)).toEqual(['replies_posted', 'posts_scheduled']);
      expect(s1[1]).toMatchObject({ metric: 'posts_scheduled', count: 3, note: 'Candidate A queued' });
      // count-as-value duplicates are normalized away, like the Home tiles do.
      expect(s1[0]).toMatchObject({ metric: 'replies_posted', count: 1 });
      expect(s1[0].value).toBeUndefined();
      expect(bySession.get('s2')![0].note).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty map when the project has no metrics store or an unreadable one', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-results-'));
    try {
      expect((await readSessionResults(projectRoot)).size).toBe(0);
      const dir = join(projectRoot, '.agentuse', 'store', METRICS_STORE_NAME);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'items.json'), '{ not json');
      expect((await readSessionResults(projectRoot)).size).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('re-reads only when the store file changes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-results-'));
    try {
      const store = new Store(projectRoot, METRICS_STORE_NAME, 'agents/poster');
      await store.create({ type: 'metric', data: { metric: 'a', count: 1, sessionId: 's1' } });
      const first = await readSessionResults(projectRoot);
      expect(await readSessionResults(projectRoot)).toBe(first);
      await store.create({ type: 'metric', data: { metric: 'b', count: 1, sessionId: 's2' } });
      await store.releaseLock();
      // Same-millisecond writes can leave mtime unchanged; force it forward.
      const itemsPath = join(projectRoot, '.agentuse', 'store', METRICS_STORE_NAME, 'items.json');
      const later = new Date(Date.now() + 5_000);
      await utimes(itemsPath, later, later);
      const second = await readSessionResults(projectRoot);
      expect(second).not.toBe(first);
      expect(second.has('s2')).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('sessions list results filters', () => {
  const base = { status: 'completed', results: [{ metric: 'posts_scheduled', count: 1, at: 1 }] };

  it('parses only the unseen results view', () => {
    expect(__testing.parseSessionResultsFilter('unseen')).toBe('unseen');
    expect(__testing.parseSessionResultsFilter('seen')).toBeUndefined();
    expect(__testing.parseSessionResultsFilter(undefined)).toBeUndefined();
  });

  it('matches a metric name only against rows that recorded it', () => {
    expect(__testing.sessionMatchesMetricFilter(base, undefined)).toBe(true);
    expect(__testing.sessionMatchesMetricFilter(base, 'posts_scheduled')).toBe(true);
    expect(__testing.sessionMatchesMetricFilter(base, 'replies_posted')).toBe(false);
    expect(__testing.sessionMatchesMetricFilter({}, 'posts_scheduled')).toBe(false);
  });

  it('unseen = finished, has results, not opened, not waved off', () => {
    expect(__testing.sessionMatchesResultsFilter(base, 'unseen')).toBe(true);
    expect(__testing.sessionMatchesResultsFilter({ ...base, reviewedAt: 5 }, 'unseen')).toBe(false);
    expect(__testing.sessionMatchesResultsFilter({ ...base, dismissedAt: 5 }, 'unseen')).toBe(false);
    expect(__testing.sessionMatchesResultsFilter({ ...base, status: 'error' }, 'unseen')).toBe(false);
    expect(__testing.sessionMatchesResultsFilter({ status: 'completed', results: [] }, 'unseen')).toBe(false);
    expect(__testing.sessionMatchesResultsFilter({ status: 'completed' }, undefined)).toBe(true);
  });

  it('keys the live list stream on the results filters too', () => {
    const plain = __testing.sessionListStreamKey(new URL('http://localhost/sessions/events'));
    const metric = __testing.sessionListStreamKey(new URL('http://localhost/sessions/events?metric=posts_scheduled'));
    const unseen = __testing.sessionListStreamKey(new URL('http://localhost/sessions/events?results=unseen'));
    expect(new Set([plain, metric, unseen]).size).toBe(3);
  });
});

describe('SessionManager.markSessionReviewed', () => {
  it('stamps once, never moves, and does not count as activity', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-reviewed-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const agentId = 'agents/poster';
      const sessionId = await manager.createSession({
        agent: { id: agentId, name: 'poster', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const before = (await manager.getSession(sessionId, agentId))!;

      const first = await manager.markSessionReviewed(sessionId);
      expect(first).not.toBeNull();
      expect(first!.alreadyReviewed).toBe(false);
      const after = (await manager.getSession(sessionId, agentId))!;
      expect(after.reviewedAt).toBe(first!.reviewedAt);
      expect(after.time.updated).toBe(before.time.updated);

      const second = await manager.markSessionReviewed(sessionId);
      expect(second).toEqual({ reviewedAt: first!.reviewedAt, alreadyReviewed: true });

      expect(await manager.markSessionReviewed('nope')).toBeNull();
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('result chips helpers', () => {
  it('labels a result from its count or amount', () => {
    expect(resultLabel({ metric: 'posts_scheduled', count: 3, at: 1 })).toBe('3 posts scheduled');
    expect(resultLabel({ metric: 'invoices_chased', value: 1200, unit: 'usd', at: 1 })).toBe('$1,200 invoices chased');
    expect(resultLabel({ metric: 'calls_made', value: 15, unit: 'minutes', at: 1 })).toBe('15 minutes calls made');
    expect(resultLabel({ metric: 'ran', at: 1 })).toBe('ran');
  });

  it('headlines with the first note, else the results themselves', () => {
    expect(resultsHeadline(undefined)).toBeUndefined();
    expect(resultsHeadline([])).toBeUndefined();
    expect(resultsHeadline([
      { metric: 'a', count: 1, at: 2 },
      { metric: 'b', count: 2, at: 1, note: 'Campaign 72 scheduled' },
    ])).toBe('Campaign 72 scheduled');
    expect(resultsHeadline([{ metric: 'posts_scheduled', count: 1, at: 2 }, { metric: 'replies_posted', count: 2, at: 1 }]))
      .toBe('1 posts scheduled · 2 replies posted');
  });

  it('marks unseen only for finished runs with results nobody opened', () => {
    const results = [{ metric: 'a', count: 1, at: 1 }];
    expect(isUnseenResultsRow({ status: 'completed', results })).toBe(true);
    expect(isUnseenResultsRow({ status: 'completed', results, reviewedAt: 1 })).toBe(false);
    expect(isUnseenResultsRow({ status: 'completed', results, dismissedAt: 1 })).toBe(false);
    expect(isUnseenResultsRow({ status: 'completed' })).toBe(false);
    expect(isUnseenResultsRow({ status: 'running', results })).toBe(false);
  });
});
