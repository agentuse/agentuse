/**
 * Markdown / JSON content rendering for log entries and approval cards.
 *
 * These produce HTML strings rather than vnodes on purpose: every dynamic
 * value flows through escapeHtml() before markup is added, which is the same
 * escape-first pipeline the server renderers used. Components inject the
 * result via dangerouslySetInnerHTML, so this module is the only place that
 * is allowed to build markup from strings.
 */
import { isJsonLikeContent, looksLikeMarkdown } from "./format";

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

function renderMarkdownTextBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    html.push(`<blockquote>${quote.map(line => `<p>${renderInlineMarkdown(line)}</p>`).join('')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    const blockquote = trimmed.match(/^>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }
  flushAll();
  return html.join('');
}

export function renderMarkdownBlock(value: string): string {
  const html: string[] = [];
  let cursor = 0;
  const fencePattern = /```([A-Za-z0-9_-]+)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(value)) !== null) {
    const before = value.slice(cursor, match.index);
    if (before.trim()) html.push(renderMarkdownTextBlock(before));
    const language = match[1] ? ` data-language="${escapeHtml(match[1])}"` : '';
    html.push(`<pre class="content-code"${language}><code>${escapeHtml(match[2].trim())}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  const rest = value.slice(cursor);
  if (rest.trim()) html.push(renderMarkdownTextBlock(rest));
  return `<div class="content-markdown">${html.join('')}</div>`;
}

function isReadableJsonString(value: string): boolean {
  return value.length > 120 || value.includes('\n') || value.includes('\t');
}

function renderJsonFieldValue(value: unknown): string {
  if (typeof value === 'string') {
    if (isReadableJsonString(value)) {
      return `<pre class="content-code text decoded-json-string"><code>${escapeHtml(value)}</code></pre>`;
    }
    return `<code class="json-inline-string">${escapeHtml(JSON.stringify(value))}</code>`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return `<code class="json-inline-literal">${escapeHtml(JSON.stringify(value))}</code>`;
  }
  return `<pre class="content-code json"><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`;
}

function renderSmartJsonBlock(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `<pre class="content-code json"><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>`;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.some(([, value]) => typeof value === 'string' && isReadableJsonString(value))) {
    return `<pre class="content-code json"><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>`;
  }
  return `<div class="json-object-block" role="group" aria-label="JSON object">${entries.map(([key, fieldValue]) => `
    <div class="json-field">
      <div class="json-field-key">${escapeHtml(key)}</div>
      <div class="json-field-value">${renderJsonFieldValue(fieldValue)}</div>
    </div>
  `).join('')}</div>`;
}

export function renderLogContentValue(value: string, options?: { forceMarkdown?: boolean }): string {
  if (isJsonLikeContent(value)) {
    return renderSmartJsonBlock(JSON.parse(value));
  }
  if (options?.forceMarkdown || looksLikeMarkdown(value)) {
    return renderMarkdownBlock(value);
  }
  return `<pre class="content-code text"><code>${escapeHtml(value)}</code></pre>`;
}
