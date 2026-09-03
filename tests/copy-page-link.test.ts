import { describe, expect, it } from 'bun:test';
import { isCopyPageLinkShortcut, pageLinkFor } from '../src/cli/serve/web/lib/copy-page-link';

describe('copy page link', () => {
  it('recognizes ⌘⇧C / Ctrl+Shift+C without matching plain copy or typing', () => {
    expect(isCopyPageLinkShortcut({ key: 'C', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(true);
    expect(isCopyPageLinkShortcut({ key: 'c', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe(true);
    expect(isCopyPageLinkShortcut({ key: 'c', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isCopyPageLinkShortcut({ key: 'C', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false);
    expect(isCopyPageLinkShortcut({ key: 'c', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true })).toBe(false);
  });

  it('swaps the page origin for the daemon public URL and keeps path, query and hash', () => {
    const href = 'http://127.0.0.1:3000/sessions/abc?project=p1#log';
    expect(pageLinkFor('https://agentuse-m5.example.ts.net', href)).toBe('https://agentuse-m5.example.ts.net/sessions/abc?project=p1#log');
    expect(pageLinkFor('https://host.example/agentuse/', href)).toBe('https://host.example/agentuse/sessions/abc?project=p1#log');
  });

  it('falls back to the page origin when no public URL is known', () => {
    const href = 'http://localhost:3000/agents?project=p1';
    expect(pageLinkFor(undefined, href)).toBe(href);
    expect(pageLinkFor('', href)).toBe(href);
  });
});
