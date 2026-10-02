import { describe, expect, it } from 'bun:test';
import type { SessionRow } from '../src/cli/serve/web/lib/api';
import { loadSessionTail, rowKey } from '../src/cli/serve/web/routes/sessions-list';

function row(n: number): SessionRow {
  return { project: 'p', sessionId: `s${n}`, createdAt: n } as SessionRow;
}

/** The server's cursor contract: a cursor names the last row of a page, and
 *  the next page starts right after that row in the current ordering. */
function server(rows: SessionRow[]) {
  const calls: Array<{ cursor: string | undefined; limit: number }> = [];
  const page = (cursor: string | undefined, limit: number) => {
    calls.push({ cursor, limit });
    const start = cursor ? rows.findIndex((r) => rowKey(r) === cursor) + 1 : 0;
    const items = rows.slice(start, start + limit);
    const last = items.at(-1);
    return {
      sessions: items,
      ...(last && start + items.length < rows.length && { nextCursor: rowKey(last) }),
    };
  };
  return { page, calls };
}

describe('loadSessionTail', () => {
  it('keeps the row a new session pushes out of the first page', async () => {
    const before = Array.from({ length: 120 }, (_, i) => row(i));
    const first = server(before);
    const head = first.page(undefined, 50);
    const tail = await loadSessionTail(async (cursor, limit) => first.page(cursor, limit), head.nextCursor!, 50);

    // A new run starts: it leads the list and the old 50th row leaves the head.
    const after = [row(1000), ...before];
    const second = server(after);
    const newHead = second.page(undefined, 50);
    expect(newHead.nextCursor).not.toBe(tail.from);

    const stale = new Set([...newHead.sessions, ...tail.rows].map(rowKey));
    expect(stale.has(rowKey(before[49]!))).toBe(false);

    const rebuilt = await loadSessionTail(async (cursor, limit) => second.page(cursor, limit), newHead.nextCursor!, tail.rows.length);
    const shown = [...newHead.sessions, ...rebuilt.rows].map(rowKey);
    expect(shown).toEqual(after.slice(0, 100).map(rowKey));
    expect(rebuilt.cursor).toBe(rowKey(after[99]!));
  });

  it('reloads a long tail in pages the server accepts', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(i));
    const { page, calls } = server(rows);
    const tail = await loadSessionTail(async (cursor, limit) => page(cursor, limit), rowKey(rows[49]!), 150);
    expect(calls.map((call) => call.limit)).toEqual([100, 50]);
    expect(tail.rows.map(rowKey)).toEqual(rows.slice(50, 200).map(rowKey));
  });

  it('stops at the end of the list', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const { page } = server(rows);
    const tail = await loadSessionTail(async (cursor, limit) => page(cursor, limit), rowKey(rows[49]!), 50);
    expect(tail.rows).toHaveLength(10);
    expect(tail.cursor).toBeUndefined();
  });
});
