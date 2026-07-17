/**
 * Markdown / JSON content rendering for log entries and approval cards.
 *
 * These produce HTML strings rather than vnodes on purpose: every dynamic
 * value flows through escapeHtml() before markup is added, which is the same
 * escape-first pipeline the server renderers used. Components inject the
 * result via dangerouslySetInnerHTML, so this module is the only place that
 * is allowed to build markup from strings.
 */
import { CHART_FENCE_LANGUAGE, renderChartBlock } from "./chart-svg";
import { isJsonLikeContent, looksLikeMarkdown } from "./format";
import { highlightJson, highlightJsonSource } from "./json-highlight";

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineMarkdown(value: string): string {
  const codeSpans: string[] = [];
  const codePlaceholder = (index: number) => `\u0000CODE${index}\u0000`;
  const escaped = escapeHtml(value).replace(/`([^`]+)`/g, (_, code) => {
    const index = codeSpans.push(`<code>${code}</code>`) - 1;
    return codePlaceholder(index);
  });
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s([{>])\*([^*\n]+?)\*(?=[\s.,;:!?)}\]]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSpans[Number(index)] ?? '');
}

type MarkdownListItem = { indent: number; type: 'ul' | 'ol'; text: string };

/** Builds (possibly nested) list markup from indent-annotated items. */
function renderNestedList(items: MarkdownListItem[]): string {
  const out: string[] = [];
  const stack: Array<{ indent: number; type: 'ul' | 'ol' }> = [];
  const openList = (item: MarkdownListItem) => {
    stack.push({ indent: item.indent, type: item.type });
    out.push(`<${item.type}><li>${renderInlineMarkdown(item.text)}`);
  };
  const closeList = () => {
    const level = stack.pop();
    if (level) out.push(`</li></${level.type}>`);
  };
  for (const item of items) {
    if (stack.length === 0 || item.indent > stack[stack.length - 1].indent) {
      openList(item);
      continue;
    }
    while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) closeList();
    if (item.type !== stack[stack.length - 1].type) {
      closeList();
      openList(item);
    } else {
      out.push(`</li><li>${renderInlineMarkdown(item.text)}`);
    }
  }
  while (stack.length > 0) closeList();
  return out.join('');
}

function renderMarkdownTextBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let listItems: MarkdownListItem[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    html.push(renderNestedList(listItems));
    listItems = [];
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

  const isRule = (line: string) => /^([-*_])(?:\s*\1){2,}$/.test(line.trim());
  const isTableSeparator = (line: string) => {
    const cells = markdownTableCells(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
  };
  const renderTable = (startIndex: number): number => {
    const header = markdownTableCells(lines[startIndex]);
    const rows: string[][] = [];
    let cursor = startIndex + 2;
    while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
      rows.push(markdownTableCells(lines[cursor]));
      cursor += 1;
    }
    const tableRows = rows.map(row => `<tr>${header.map((_, index) => `<td>${renderInlineMarkdown(row[index] ?? '')}</td>`).join('')}</tr>`).join('');
    html.push(`<div class="content-table-scroll" tabindex="0" role="group" aria-label="Table"><table><thead><tr>${header.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>${tableRows ? `<tbody>${tableRows}</tbody>` : ''}</table></div>`);
    return cursor;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    if (index + 1 < lines.length && trimmed.includes('|') && isTableSeparator(lines[index + 1])) {
      flushAll();
      index = renderTable(index) - 1;
      continue;
    }
    if (isRule(trimmed)) {
      flushAll();
      html.push('<hr>');
      continue;
    }
    if (index + 1 < lines.length && /^(=+|-+)$/.test(lines[index + 1].trim()) && !trimmed.startsWith('|')) {
      flushAll();
      const level = lines[index + 1].trim().startsWith('=') ? 2 : 3;
      html.push(`<h${level}>${renderInlineMarkdown(trimmed)}</h${level}>`);
      index += 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const listMatch = line.match(/^(\s*)(?:([-*+])|(\d+\.))\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      listItems.push({
        indent: listMatch[1].replace(/\t/g, '  ').length,
        type: listMatch[3] ? 'ol' : 'ul',
        text: listMatch[4],
      });
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

function markdownTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('|')) return [];
  return trimmed.split('|').map(cell => cell.trim());
}

export function renderMarkdownBlock(value: string): string {
  const html: string[] = [];
  let cursor = 0;
  const fencePattern = /```([A-Za-z0-9_:-]+)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(value)) !== null) {
    const before = value.slice(cursor, match.index);
    if (before.trim()) html.push(renderMarkdownTextBlock(before));
    const code = match[2].trim();
    const chart = match[1]?.toLowerCase() === CHART_FENCE_LANGUAGE ? renderChartBlock(code) : null;
    if (chart) {
      html.push(chart);
    } else {
      const language = match[1] ? ` data-language="${escapeHtml(match[1])}"` : '';
      html.push(`<pre class="content-code"${language}><code>${renderFencedCode(match[1], code)}</code></pre>`);
    }
    cursor = match.index + match[0].length;
  }
  const rest = value.slice(cursor);
  if (rest.trim()) html.push(renderMarkdownTextBlock(rest));
  return `<div class="content-markdown">${html.join('')}</div>`;
}

/** Fenced code bodies are plain-escaped except known-valid JSON, which gets token spans. */
function renderFencedCode(language: string | undefined, code: string): string {
  if (language && /^json[5c]?$/i.test(language)) {
    try {
      JSON.parse(code);
      return highlightJsonSource(code);
    } catch { /* not strict JSON (comments, trailing commas): render plain */ }
  }
  return escapeHtml(code);
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
  return `<pre class="content-code json"><code>${highlightJson(value)}</code></pre>`;
}

function renderSmartJsonBlock(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `<pre class="content-code json"><code>${highlightJson(parsed)}</code></pre>`;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.some(([, value]) => typeof value === 'string' && isReadableJsonString(value))) {
    return `<pre class="content-code json"><code>${highlightJson(parsed)}</code></pre>`;
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
