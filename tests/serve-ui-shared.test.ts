import { describe, expect, it } from 'bun:test';
import { renderMarkdownBlock as renderServerMarkdown } from '../src/cli/serve/ui';
import { renderMarkdownBlock as renderBrowserMarkdown } from '../src/cli/serve/web/lib/content-html';

describe('shared server and browser content rendering', () => {
  it('uses the same implementation and feature set on both surfaces', () => {
    expect(renderServerMarkdown).toBe(renderBrowserMarkdown);
    const source = '| Item | Value |\n| --- | --- |\n| nested | **yes** |';
    expect(renderServerMarkdown(source)).toBe(renderBrowserMarkdown(source));
    expect(renderServerMarkdown(source)).toContain('<table>');
  });
});
