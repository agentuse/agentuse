import matter from 'gray-matter';
import { WORDMARK_SVG } from "./brand";
import { safeHttpUrl } from "../../utils/url";

export { safeHttpUrl };

/**
 * Split an incoming request pathname into the `/api/*` data surface vs the
 * root-level HTML/page surface. `/api/agents` -> { isApi: true, routePath: '/agents' };
 * `/api` and `/api/` collapse to routePath '/'. Non-prefixed paths pass through
 * unchanged. Uses a slash-aware prefix test so `/apiary` is NOT treated as API.
 */
export function normalizeApiPath(pathname: string): { isApi: boolean; routePath: string } {
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const rest = pathname.slice('/api'.length);
    return { isApi: true, routePath: rest === '' ? '/' : rest };
  }
  return { isApi: false, routePath: pathname };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize a value as a JSON literal safe to embed inside an inline <script>.
 * JSON.stringify does not escape the closing-script sequence or comment opener,
 * so a string carrying either would terminate the script element early (breaking
 * the page) or inject markup (stored XSS). Escaping every '<' to its backslash-u
 * form keeps the JSON valid while making those sequences inert to the HTML parser.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function formatApprovalTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'Unknown';
}

export function formatLogTime(value?: number): string {
  return value ? new Date(value).toLocaleTimeString() : '';
}

export function isJsonLikeContent(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function looksLikeMarkdown(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /(^|\n)(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|```|\|.+\|)/.test(trimmed) ||
    /\[[^\]]+\]\([^)]+\)/.test(trimmed) ||
    /\*\*[^*]+\*\*/.test(trimmed) ||
    /https?:\/\/[^\s)]+/.test(trimmed) ||
    /`[^`]+`/.test(trimmed);
}

export function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

export function renderMarkdownTextBlock(value: string): string {
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

/** Render a single (non-array) frontmatter value: links stay clickable, dates
 *  normalize to ISO, nested objects fall back to compact JSON. */
function formatFrontmatterScalar(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '<span class="fm-empty">(empty)</span>';
  }
  if (value instanceof Date) return escapeHtml(value.toISOString());
  if (typeof value === 'object') {
    return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  }
  const text = String(value);
  if (/^https?:\/\/\S+$/.test(text)) {
    return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="fm-empty">(empty)</span>';
    return value.map(item => `<span class="fm-chip">${formatFrontmatterScalar(item)}</span>`).join(' ');
  }
  return formatFrontmatterScalar(value);
}

/** Render parsed YAML frontmatter as a compact metadata table. Returns an empty
 *  string when there is nothing to show so callers can omit it cleanly. */
export function renderFrontmatterTable(data: Record<string, unknown>): string {
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) return '';
  const rows = entries
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${formatFrontmatterValue(value)}</td></tr>`)
    .join('');
  return `<table class="content-frontmatter"><tbody>${rows}</tbody></table>`;
}

/**
 * Render a markdown document for artifact preview: split off any YAML
 * frontmatter into a metadata table, then render the remaining body. Malformed
 * frontmatter falls back to rendering the raw source so nothing is dropped.
 */
export function renderMarkdownArtifact(raw: string): string {
  let data: Record<string, unknown> = {};
  let content = raw;
  try {
    const parsed = matter(raw);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    content = parsed.content;
  } catch {
    data = {};
    content = raw;
  }
  return `${renderFrontmatterTable(data)}${renderMarkdownBlock(content)}`;
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

export function valueAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function approvalListThemeStyles(): string {
  return `
    :root {
      --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #000000; --fg: #ffffff;
      --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.18);
      --panel: rgba(255,255,255,0.03); --panel-hover: rgba(255,255,255,0.06);
      --muted: rgba(255,255,255,0.50); --muted-2: rgba(255,255,255,0.30); --muted-3: rgba(255,255,255,0.70);
      --cyan: #22d3ee; --cyan-soft: rgba(34,211,238,0.08); --cyan-border: rgba(34,211,238,0.35);
      --green: #4ade80; --green-soft: rgba(74,222,128,0.08); --green-border: rgba(74,222,128,0.35);
      --amber: #fbbf24; --amber-soft: rgba(251,191,36,0.08); --amber-border: rgba(251,191,36,0.35);
      --red: #f87171; --red-soft: rgba(248,113,113,0.10); --red-border: rgba(248,113,113,0.35);
      --glow-1: rgba(34,211,238,0.06); --glow-2: rgba(74,222,128,0.04);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #fafaf9; --fg: #0a0a0a;
      --line: rgba(0,0,0,0.08); --line-strong: rgba(0,0,0,0.16);
      --panel: rgba(0,0,0,0.025); --panel-hover: rgba(0,0,0,0.05);
      --muted: rgba(0,0,0,0.55); --muted-2: rgba(0,0,0,0.35); --muted-3: rgba(0,0,0,0.75);
      --cyan: #0891b2; --cyan-soft: rgba(8,145,178,0.08); --cyan-border: rgba(8,145,178,0.35);
      --green: #047857; --green-soft: rgba(4,120,87,0.08); --green-border: rgba(4,120,87,0.35);
      --amber: #b45309; --amber-soft: rgba(180,83,9,0.10); --amber-border: rgba(180,83,9,0.35);
      --red: #b91c1c; --red-soft: rgba(185,28,28,0.08); --red-border: rgba(185,28,28,0.35);
      --glow-1: rgba(8,145,178,0.06); --glow-2: rgba(4,120,87,0.04);
    }
  `;
}

export function approvalThemeBootScript(): string {
  return `(function() {
    try {
      var stored = localStorage.getItem('agentuse-theme');
      var resolved = stored === 'light' || stored === 'dark'
        ? stored
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.setAttribute('data-theme-pref', stored || 'system');
    } catch (e) {}
  })();`;
}

export function approvalsTopbarStyles(): string {
  return `
    .topbar {
      position: sticky;
      top: 0;
      z-index: 50;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--bg);
      font-size: 12px;
      color: var(--muted);
    }
    .topbar .brand { display: inline-flex; align-items: center; color: var(--fg); text-decoration: none; border-bottom: 0; }
    .topbar .brand svg { height: 18px; width: auto; display: block; }
    .topbar a.brand:hover { color: var(--fg); opacity: 0.8; }
    .topbar .brand-name { color: var(--fg); }
    .topbar .nav-wrap { justify-self: center; }
    .topbar .nav {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
    }
    .topbar .nav-item {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 10px;
      border: 0;
      border-radius: 999px;
      color: var(--muted-2);
      text-decoration: none;
      transition: color 120ms ease, background 120ms ease;
    }
    .topbar .nav a.nav-item:hover { opacity: 1; color: var(--muted-3); background: var(--panel-hover); }
    .topbar .nav-item.active { color: var(--fg); background: var(--bg); border: 1px solid var(--line); }
    .topbar .right { display: inline-flex; gap: 18px; align-items: center; justify-self: end; }
    .session-pill { color: var(--muted); }
    .session-pill code { color: var(--muted-3); }
    .pending-count { color: var(--cyan); }
    .theme-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
    }
    .theme-toggle button {
      min-height: 0;
      padding: 4px 8px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.04em;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .theme-toggle button:hover { background: transparent; color: var(--muted-3); border: 0; }
    .theme-toggle button[aria-pressed="true"] {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--line);
    }
    .theme-toggle svg { width: 12px; height: 12px; display: block; }
    @media (max-width: 640px) {
      .topbar { padding: 12px 16px; grid-template-columns: 1fr auto; gap: 10px; }
      .topbar .nav-wrap { grid-column: 1 / -1; grid-row: 2; justify-self: center; }
    }
  `;
}

export function approvalsThemeToggleHtml(): string {
  return `<span class="theme-toggle" role="group" aria-label="Theme">
      <button type="button" data-theme-pref="light" title="Light" aria-label="Light theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1.06 1.06M4.46 11.54L3.4 12.6M12.6 12.6l-1.06-1.06M4.46 4.46L3.4 3.4"/></svg>
      </button>
      <button type="button" data-theme-pref="system" title="System" aria-label="System theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5" stroke-linecap="round"/></svg>
      </button>
      <button type="button" data-theme-pref="dark" title="Dark" aria-label="Dark theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z"/></svg>
      </button>
    </span>`;
}

export function approvalsThemeToggleScript(): string {
  return `
    (function() {
      const themeMql = window.matchMedia('(prefers-color-scheme: light)');
      function applyTheme(pref) {
        const resolved = pref === 'light' || pref === 'dark'
          ? pref
          : (themeMql.matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', resolved);
        document.documentElement.setAttribute('data-theme-pref', pref);
        for (const btn of document.querySelectorAll('.theme-toggle button')) {
          btn.setAttribute('aria-pressed', String(btn.dataset.themePref === pref));
        }
      }
      function currentPref() {
        return localStorage.getItem('agentuse-theme') || 'system';
      }
      applyTheme(currentPref());
      for (const btn of document.querySelectorAll('.theme-toggle button')) {
        btn.addEventListener('click', () => {
          const pref = btn.dataset.themePref;
          if (pref === 'system') localStorage.removeItem('agentuse-theme');
          else localStorage.setItem('agentuse-theme', pref);
          applyTheme(pref);
        });
      }
      themeMql.addEventListener('change', () => {
        if (currentPref() === 'system') applyTheme('system');
      });
    })();
  `;
}

export type TopbarPage = 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

export function approvalsTopbarMarkup(opts: { right?: string; isCurrentPage?: boolean; currentPage?: TopbarPage }): string {
  const currentPage = opts.currentPage ?? (opts.isCurrentPage ? 'approvals' : undefined);
  const navItem = (page: TopbarPage, label: string): string => {
    const active = currentPage === page;
    return `<a class="nav-item${active ? ' active' : ''}" href="/${page}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
  };
  const nav = [
    navItem('agents', 'agents'),
    navItem('sessions', 'sessions'),
    navItem('schedules', 'schedules'),
    navItem('stores', 'stores'),
    navItem('approvals', 'approvals'),
  ].join('');
  return `<div class="topbar">
    <a class="brand" href="/" aria-label="AgentUse home">${WORDMARK_SVG}</a>
    <span class="nav-wrap"><span class="nav" role="navigation" aria-label="AgentUse serve">${nav}</span></span>
    <span class="right">${opts.right ?? ''}</span>
  </div>`;
}
