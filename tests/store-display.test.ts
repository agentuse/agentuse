import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mergeStoreSummaries,
  shortAgentName,
  storeItemPreview,
  storeNeedsAttention,
  storeStatusBucket,
  summarizeStoreItems,
} from '../src/store/display';
import { statusBar, statusSlices, statusChipClass, typeSummary } from '../src/cli/serve/web/lib/store-view';
import { findStoreItemRelations, listProjectStores, listStoreRows } from '../src/cli/serve/stores';
import type { StoreItem } from '../src/store/types';

const HOUR = 60 * 60 * 1000;

function item(partial: Partial<StoreItem> & { id: string }): StoreItem {
  const created = partial.createdAt ?? new Date(Date.now() - 4 * HOUR).toISOString();
  return {
    createdAt: created,
    updatedAt: partial.updatedAt ?? created,
    data: {},
    ...partial,
  } as StoreItem;
}

/** An item that was created and later moved on, as pipeline items are. */
function moved(partial: Partial<StoreItem> & { id: string }): StoreItem {
  const created = new Date(Date.now() - 4 * HOUR).toISOString();
  return item({ ...partial, createdAt: created, updatedAt: new Date(Date.now() - HOUR).toISOString() });
}

describe('storeStatusBucket', () => {
  it('reads failures as blocked, whatever the wording', () => {
    for (const status of ['blocked', 'auth_blocked', 'auth blocked', 'failed', 'error']) {
      expect(storeStatusBucket(status)).toBe('blocked');
    }
  });

  it('reads waiting-on-a-human statuses as attention', () => {
    for (const status of ['awaiting approval', 'pending', 'in_review', 'measuring', 'draft', 'ready']) {
      expect(storeStatusBucket(status)).toBe('attention');
    }
  });

  it('reads finished statuses as done', () => {
    for (const status of ['done', 'completed', 'published', 'posted', 'sent', 'consumed', 'skipped', 'success', 'ok']) {
      expect(storeStatusBucket(status)).toBe('done');
    }
  });

  // An item that was considered and dropped is finished, not a problem. When
  // these counted as failures every pipeline claimed to need attention.
  it('reads dropped outcomes as done, not as failures', () => {
    for (const status of ['rejected', 'expired', 'abandoned', 'cleared', 'skipped']) {
      expect(storeStatusBucket(status)).toBe('done');
    }
  });

  it('treats everything else as in flight', () => {
    for (const status of ['active', 'in_progress', 'scheduled', 'fresh']) {
      expect(storeStatusBucket(status)).toBe('active');
    }
  });

  it('checks failure first, so a failed review is not a review', () => {
    expect(storeStatusBucket('review_failed')).toBe('blocked');
  });

  it('maps buckets onto the chip classes the table renders', () => {
    expect(statusChipClass('blocked')).toBe('chip bad');
    expect(statusChipClass('awaiting approval')).toBe('chip warn');
    expect(statusChipClass('published')).toBe('chip status');
  });

  it('flags a mix holding anything waiting or failed', () => {
    expect(storeNeedsAttention({ done: 10, published: 4 })).toBe(false);
    expect(storeNeedsAttention({ done: 10, measuring: 1 })).toBe(true);
    expect(storeNeedsAttention({ done: 10, blocked: 2 })).toBe(true);
    expect(storeNeedsAttention({ blocked: 0 })).toBe(false);
    expect(storeNeedsAttention({ done: 10, rejected: 3, expired: 1 })).toBe(false);
  });
});

describe('summarizeStoreItems', () => {
  it('counts statuses, types and writers', () => {
    const summary = summarizeStoreItems([
      moved({ id: 'a', status: 'done', type: 'seo_post', createdBy: 'agents/blog/write' }),
      moved({ id: 'b', status: 'done', type: 'task', createdBy: 'agents/blog/write' }),
      moved({ id: 'c', status: 'blocked', type: 'task', createdBy: 'agents/blog/manage' }),
    ]);
    expect(summary.statusCounts).toEqual({ done: 2, blocked: 1 });
    expect(summary.typeCounts).toEqual({ seo_post: 1, task: 2 });
    expect(summary.agents).toEqual(['agents/blog/manage', 'agents/blog/write']);
  });

  it('calls a store a pipeline when items carry a status and move through it', () => {
    const items = Array.from({ length: 20 }, (_, i) => moved({ id: `i${i}`, status: i % 2 ? 'done' : 'measuring' }));
    expect(summarizeStoreItems(items).display).toBe('pipeline');
  });

  it('is a plain table when items never move after they are written', () => {
    const items = Array.from({ length: 20 }, (_, i) => item({ id: `i${i}`, status: 'done' }));
    expect(summarizeStoreItems(items).display).toBe('table');
  });

  it('is a plain table when more than a few items carry no status', () => {
    const items = Array.from({ length: 20 }, (_, i) => moved({ id: `i${i}`, ...(i < 18 ? { status: 'done' } : {}) }));
    expect(summarizeStoreItems(items).display).toBe('table');
  });

  it('is a plain table when the store is empty', () => {
    expect(summarizeStoreItems([]).display).toBe('table');
  });

  it('merges per-project summaries, and one pipeline makes the store one', () => {
    const merged = mergeStoreSummaries([
      { display: 'table', statusCounts: { done: 2 }, typeCounts: { task: 2 }, agents: ['b'] },
      { display: 'pipeline', statusCounts: { done: 3, blocked: 1 }, typeCounts: { note: 1 }, agents: ['a', 'b'] },
    ]);
    expect(merged.display).toBe('pipeline');
    expect(merged.statusCounts).toEqual({ done: 5, blocked: 1 });
    expect(merged.typeCounts).toEqual({ task: 2, note: 1 });
    expect(merged.agents).toEqual(['a', 'b']);
  });
});

describe('storeItemPreview', () => {
  it('shows the item’s own scalar fields rather than a shape summary', () => {
    const preview = storeItemPreview(item({
      id: 'x',
      title: 'Leaving a Legacy',
      data: { queue_item_id: 'sq_079', resolved_icp: 'encore-seeker', viability_score: 8.9, recommendation: 'PROCEED' },
    }));
    expect(preview).toBe('sq_079 · encore-seeker · viability score 8.9 · PROCEED');
  });

  it('skips ids, long prose and nested payloads', () => {
    const preview = storeItemPreview(item({
      id: 'x',
      data: {
        manager_task_id: '01M1EVCYVAHY5KRH1MN1DTNNXV',
        body: 'a'.repeat(400),
        outline: { h1: 'x' },
        keyword: 'leaving a legacy',
      },
    }));
    expect(preview).toBe('leaving a legacy');
  });

  it('does not repeat the title it sits under', () => {
    expect(storeItemPreview(item({ id: 'x', title: 'Deploy', data: { title: 'Deploy' } }))).toBe('');
  });

  it('drops what the row already shows: the title, the writer, timestamps', () => {
    const preview = storeItemPreview(item({
      id: 'x',
      createdBy: 'agents/substack/substack-note',
      title: 'substack_original_notes_published · 1',
      data: {
        metric: 'substack_original_notes_published',
        count: 1,
        source: 'agents/substack/substack-note',
        recorded_at: '2026-09-03T18:20:00Z',
      },
    }));
    expect(preview).toBe('count 1');
  });

  it('falls back to a timestamp when nothing else survives', () => {
    const preview = storeItemPreview(item({
      id: 'x',
      title: 'run',
      data: { name: 'run', started_at: '2026-09-03T18:20:00Z' },
    }));
    expect(preview).toBe('2026-09-03T18:20:00Z');
  });

  it('truncates to the requested width', () => {
    const preview = storeItemPreview(item({ id: 'x', data: { a: 'x'.repeat(30), b: 'y'.repeat(30) } }), 20);
    expect(preview.length).toBe(20);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('store view helpers', () => {
  it('paints the bar finished → in flight → waiting → failed', () => {
    const bar = statusBar({ blocked: 1, done: 5, measuring: 2, active: 2 });
    expect(bar.map((segment) => segment.bucket)).toEqual(['done', 'active', 'attention', 'blocked']);
    expect(bar[0]!.pct).toBe(50);
  });

  it('drops buckets with nothing in them', () => {
    expect(statusBar({ done: 3 }).map((segment) => segment.bucket)).toEqual(['done']);
    expect(statusBar({})).toEqual([]);
  });

  it('orders statuses by count, largest first', () => {
    expect(statusSlices({ a: 1, b: 9, c: 4 }).map((slice) => slice.status)).toEqual(['b', 'c', 'a']);
  });

  it('lists up to three types and counts the rest', () => {
    expect(typeSummary(['a', 'b', 'c'])).toBe('a · b · c');
    expect(typeSummary(['a', 'b', 'c', 'd'])).toBe('a · b · 2 more');
    expect(typeSummary([])).toBe('');
  });

  it('shortens an agent path to its leaf', () => {
    expect(shortAgentName('agents/blog/blog-write')).toBe('blog-write');
    expect(shortAgentName('email-alerts')).toBe('email-alerts');
  });
});

describe('store item relations', () => {
  async function writeStore(items: StoreItem[]): Promise<{ id: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-store-'));
    await mkdir(join(root, '.agentuse', 'store', 'pipeline'), { recursive: true });
    await writeFile(join(root, '.agentuse', 'store', 'pipeline', 'items.json'), JSON.stringify({ version: 1, items }));
    return { id: 'proj', root };
  }

  const items = [
    moved({ id: 'parent1', title: 'Advance one article', type: 'task', status: 'completed' }),
    moved({ id: 'child1', title: 'Leaving a Legacy', type: 'seo_post', status: 'published', parentId: 'parent1' }),
    moved({ id: 'child2', title: 'Deploy post', type: 'task', status: 'blocked', parentId: 'parent1' }),
    moved({ id: 'loner', title: 'Unrelated', type: 'metric', status: 'done' }),
  ];

  it('resolves the parent and every child inside the same store', async () => {
    const project = await writeStore(items);
    const found = await findStoreItemRelations(project, 'pipeline', 'parent1');
    expect(found?.parent).toBeNull();
    expect(found?.children.map((child) => child.id)).toEqual(['child1', 'child2']);
    expect(found?.children[0]).toEqual({ id: 'child1', title: 'Leaving a Legacy', type: 'seo_post', status: 'published' });
  });

  it('resolves a child back to its parent', async () => {
    const project = await writeStore(items);
    const found = await findStoreItemRelations(project, 'pipeline', 'child1');
    expect(found?.parent).toEqual({ id: 'parent1', title: 'Advance one article', type: 'task', status: 'completed' });
    expect(found?.children).toEqual([]);
  });

  it('returns null for an item that is not in the store', async () => {
    const project = await writeStore(items);
    expect(await findStoreItemRelations(project, 'pipeline', 'nope')).toBeNull();
  });

  it('carries the display guess and counts onto the rows and index payloads', async () => {
    const project = await writeStore(items);
    const rows = await listStoreRows(project, 'pipeline');
    expect(rows.display).toBe('pipeline');
    expect(rows.statusCounts).toEqual({ completed: 1, published: 1, blocked: 1, done: 1 });
    expect(rows.typeCounts).toEqual({ task: 2, seo_post: 1, metric: 1 });

    const index = await listProjectStores(project);
    expect(index.stores).toHaveLength(1);
    expect(index.stores[0]!.display).toBe('pipeline');
    expect(index.stores[0]!.statusCounts).toEqual(rows.statusCounts);
  });
});
