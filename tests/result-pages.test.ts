import { describe, expect, it } from 'bun:test';
import { resultPage } from '../src/tools/result-pages';

describe('numbered result pages', () => {
  for (const text of ['', 'hello', 'a'.repeat(58_382), '\u0000\n"\\😀漢'.repeat(2000)]) {
    it(`roundtrips ${Buffer.byteLength(text)} bytes with bounded responses`, () => {
      let page = resultPage(text, { action: 'jq', resultId: 'original', expression: '.', pageSizeBytes: 600 }, 1024);
      const total = page.pagination.totalPages;
      let joined = '', count = 0;
      while (true) {
        joined += page.content; count++;
        expect(page.pagination.page).toBe(count);
        expect(page.pagination.totalPages).toBe(total);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024);
        if (!page.next) break;
        expect(page.next.resultId).toBe('original');
        page = resultPage(text, page.next, 1024);
      }
      expect(joined).toBe(text);
      expect(count).toBe(total);
    });
  }
  it('keeps initial inline page boundaries when subsequent reads have a larger budget', () => {
    const text = '\u0000😀text'.repeat(5000);
    const first = resultPage(text, { action: 'read', resultId: 'original' }, 9000);
    let next = first.next;
    let joined = first.content;
    while (next) {
      const page = resultPage(text, next, 20480);
      expect(page.pagination.totalPages).toBe(first.pagination.totalPages);
      joined += page.content;
      next = page.next;
    }
    expect(joined).toBe(text);
  });
  it('rejects invalid pages and insufficient metadata budgets', () => {
    expect(() => resultPage('x', { action: 'read', resultId: 'x', page: 2 }, 1024)).toThrow('RESULT_PAGE_RANGE');
    expect(() => resultPage('x', { action: 'read', resultId: 'x', page: 0 }, 1024)).toThrow('RESULT_PAGE_INPUT');
    expect(() => resultPage('x', { action: 'jq', resultId: 'x', expression: 'x'.repeat(1000) }, 256)).toThrow('RESULT_PAGE_METADATA');
  });
  it('continues using the original result ID and query without a content hash', () => {
    const first = resultPage('a'.repeat(2000), { action: 'jq', resultId: 'original', expression: '.' }, 1024);
    expect(first).not.toHaveProperty('contentHash');
    expect(first.next).toEqual({ action: 'jq', resultId: 'original', expression: '.',
      page: 2, pageSizeBytes: first.pagination.pageSizeBytes });
    const second = resultPage('a'.repeat(2000), first.next!, 1024);
    expect(second.pagination.page).toBe(2);
    expect(second).not.toHaveProperty('contentHash');
  });
  it('does not emit empty pages at the minimum page size with escaped characters', () => {
    const text = '\u0000😀\u0000';
    let page = resultPage(text, { action: 'read', resultId: 'x', pageSizeBytes: 4 }, 1024);
    let joined = '';
    while (true) {
      expect(page.content.length).toBeGreaterThan(0);
      joined += page.content;
      if (!page.next) break;
      page = resultPage(text, page.next, 1024);
    }
    expect(joined).toBe(text);
  });
});
