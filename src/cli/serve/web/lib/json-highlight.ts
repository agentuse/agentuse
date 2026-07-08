/**
 * Escape-and-highlight JSON source into HTML with token spans
 * (json-key / json-string / json-number / json-literal), styled in app.css
 * and the server artifact-document styles.
 *
 * Pure string module shared by the browser bundle (lib/content-html) and the
 * server renderers (serve/ui): no DOM, no node APIs.
 *
 * Only call with strings known to be valid JSON (JSON.stringify output, or
 * input JSON.parse accepted). The tokenizer leans on JSON's grammar — every
 * unconsumed quote opens a string token — so bare words inside strings can
 * never be misread as literals.
 */

const JSON_TOKEN = /"(?:\\.|[^"\\])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlightJsonSource(source: string): string {
  let html = '';
  let cursor = 0;
  for (const match of source.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    html += escapeHtml(source.slice(cursor, index));
    const token = match[0];
    if (token.startsWith('"')) {
      const colon = match[1];
      if (colon !== undefined) {
        html += `<span class="json-key">${escapeHtml(token.slice(0, token.length - colon.length))}</span>${escapeHtml(colon)}`;
      } else {
        html += `<span class="json-string">${escapeHtml(token)}</span>`;
      }
    } else if (token === 'true' || token === 'false' || token === 'null') {
      html += `<span class="json-literal">${token}</span>`;
    } else {
      html += `<span class="json-number">${token}</span>`;
    }
    cursor = index + token.length;
  }
  return html + escapeHtml(source.slice(cursor));
}

/** Pretty-print a parsed value and highlight it in one step. */
export function highlightJson(value: unknown): string {
  return highlightJsonSource(JSON.stringify(value, null, 2) ?? 'null');
}
