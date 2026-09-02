import type { VNode } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { AgentRow, ApprovalRow, SessionRow } from '../lib/api';
import { fetchAgents, fetchSessions } from '../lib/api';
import { useGlobalApprovals } from '../hooks/use-global-approvals';
import { useTheme } from '../hooks/use-theme';
import { displayAgentName, formatRelativeTime, isRunningStatus } from '../lib/format';
import { Loading } from './loading';
import { agentDetailHref } from '../lib/links';

/** Window event the topbar dispatches to open the palette (touch devices have no ⌘K). */
export const PALETTE_OPEN_EVENT = 'agentuse:open-palette';

/** Open the command palette from anywhere (e.g. a tappable button). */
export function openAgentPalette() {
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
}

/** How many sessions the palette searches over. Recent-run lookups dominate,
 *  so a shallow window keeps the open cheap without missing the useful rows. */
const SESSION_LIMIT = 50;
/** Sessions shown under "Recent" on an empty query. */
const RECENT_COUNT = 5;

/**
 * Case-insensitive subsequence scorer. Returns null when `query` is not a
 * subsequence of `text`; otherwise a score (higher is better) plus the matched
 * character indices so the caller can highlight them. Bonuses reward matches at
 * word boundaries and contiguous runs; gaps and longer text are penalised so
 * tight, prefix-y hits rank first.
 */
function fuzzyScore(text: string, query: string): { score: number; indices: number[] } | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const indices: number[] = [];
  let from = 0;
  let prev = -2;
  let score = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    indices.push(at);
    if (at === prev + 1) score += 6; // contiguous run
    if (at === 0 || /[^a-z0-9]/.test(t[at - 1])) score += 9; // word boundary
    score += 1 - (at - from) * 0.1; // base + gap penalty
    prev = at;
    from = at + 1;
  }
  return { score: score - text.length * 0.02, indices };
}

type PaletteGroup = 'Needs you' | 'Recent' | 'Agents' | 'Sessions' | 'Pages' | 'Actions';

interface PaletteItem {
  key: string;
  group: PaletteGroup;
  /** Fuzzy-matched and highlighted; the row's headline. */
  title: string;
  desc?: string;
  /** Right-aligned status/time hint. */
  meta?: string;
  /** Secondary fuzzy target (path, session id, status) — matches here rank below title hits. */
  search?: string;
  /** Floats the item above equally-scoring ones; pending gates get the boost. */
  boost?: number;
  href?: string;
  act?: () => void;
}

interface Ranked {
  item: PaletteItem;
  /** Matched indices into the title, for highlighting (empty if matched elsewhere). */
  titleHits: number[];
}

/** Rank items against the query. Empty query keeps the caller's order. */
function rank(items: PaletteItem[], query: string): Ranked[] {
  if (!query) return items.map((item) => ({ item, titleHits: [] }));
  const scored: Array<Ranked & { score: number }> = [];
  for (const item of items) {
    const onTitle = fuzzyScore(item.title, query);
    const onSearch = item.search ? fuzzyScore(item.search, query) : null;
    // Title matches outrank secondary-only matches by a wide margin.
    const best = onTitle
      ? { score: onTitle.score + 50, titleHits: onTitle.indices }
      : onSearch
        ? { score: onSearch.score, titleHits: [] as number[] }
        : null;
    if (best) scored.push({ item, titleHits: best.titleHits, score: best.score + (item.boost ?? 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return scored;
}

/** Render a title with the fuzzy-matched characters wrapped in <mark>. */
function highlight(name: string, hits: number[]): VNode {
  if (hits.length === 0) return <>{name}</>;
  const set = new Set(hits);
  const out: VNode[] = [];
  let run = '';
  let marked = false;
  const flush = (i: number) => {
    if (!run) return;
    out.push(marked ? <mark key={i}>{run}</mark> : <span key={i}>{run}</span>);
    run = '';
  };
  for (let i = 0; i < name.length; i++) {
    const hit = set.has(i);
    if (hit !== marked) { flush(i); marked = hit; }
    run += name[i];
  }
  flush(name.length);
  return <>{out}</>;
}

const PAGES: Array<{ title: string; href: string; search: string }> = [
  { title: 'Home', href: '/', search: 'dashboard overview' },
  { title: 'Agents', href: '/agents', search: 'agents list' },
  { title: 'Sessions', href: '/sessions', search: 'runs history sessions' },
  { title: 'Approvals', href: '/approvals', search: 'approvals gates' },
  { title: 'Schedules', href: '/schedules', search: 'schedules cron' },
  { title: 'Stores', href: '/stores', search: 'stores data' },
  { title: 'Settings', href: '/settings', search: 'settings preferences providers' },
];

function approvalHref(row: ApprovalRow): string {
  const params = new URLSearchParams();
  if (row.resumeToken) params.set('token', row.resumeToken);
  params.set('project', row.project);
  return `/sessions/${encodeURIComponent(row.sessionId)}?${params.toString()}`;
}

function sessionHref(row: SessionRow): string {
  return `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
}

function approvalItems(rows: readonly ApprovalRow[]): PaletteItem[] {
  return rows.map((row) => ({
    key: `approval:${row.project}:${row.sessionId}`,
    group: 'Needs you' as const,
    title: displayAgentName(row.agentName, row.agentFilePath, row.agentId),
    ...(row.summary || row.prompt ? { desc: row.summary || row.prompt } : {}),
    meta: 'waiting',
    search: `approval ${row.sessionId} ${row.agentName}`,
    // Keeps a blocked run above same-named agents and sessions while typing.
    boost: 200,
    href: approvalHref(row),
  }));
}

function sessionItem(row: SessionRow, group: 'Recent' | 'Sessions'): PaletteItem {
  const name = displayAgentName(row.agent.name, row.agent.filePath, row.agent.id);
  return {
    key: `session:${group}:${row.project}:${row.sessionId}`,
    group,
    title: name,
    desc: row.status,
    meta: isRunningStatus(row.status) ? 'now' : formatRelativeTime(row.updatedAt).replace(' ago', ''),
    search: `${row.sessionId} ${row.status} ${name}`,
    href: sessionHref(row),
  };
}

/** Newest first, in-flight runs pulled to the top; mock runs never surface. */
function orderSessions(rows: readonly SessionRow[]): SessionRow[] {
  const visible = rows.filter((row) => !row.mock);
  const byRecency = (a: SessionRow, b: SessionRow) => b.updatedAt - a.updatedAt;
  return [
    ...visible.filter((row) => isRunningStatus(row.status)).sort(byRecency),
    ...visible.filter((row) => !isRunningStatus(row.status)).sort(byRecency),
  ];
}

/**
 * Global command palette. Opens on ⌘K / Ctrl+K from any serve page and fuzzy
 * matches across pending approvals, sessions, agents, pages, and a couple of
 * actions. With an empty query it leads with the runs that are blocked on the
 * reviewer, then the most recent sessions — the two lookups that dominate.
 * Agents and sessions are fetched on open; approvals ride the shell's stream.
 */
export function AgentPalette() {
  const location = useLocation();
  const { data: approvals } = useGlobalApprovals();
  const { pref, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Stable ids wiring the input (role=combobox) to the listbox and the active
  // option for screen readers via aria-controls / aria-activedescendant.
  const listboxId = useId();

  // Open via ⌘K / Ctrl+K (capture phase so it fires even while a page input
  // holds focus) or via the topbar search button on touch devices, which has no
  // such key combo. The custom event keeps the two entry points in sync.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  // Refresh agents and sessions on every open (sessions go stale fast), keeping
  // the previous rows on screen meanwhile; reset transient state and focus the
  // input.
  useEffect(() => {
    if (!open) return;
    // Remember what had focus so we can hand it back when the palette closes.
    const returnFocusTo = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    setLoadError(null);
    inputRef.current?.focus();
    let live = true;
    fetchAgents()
      .then((payload) => { if (live) setAgents(payload.agents); })
      .catch((err: Error) => { if (live) setLoadError(err.message); });
    fetchSessions({ limit: SESSION_LIMIT })
      .then((payload) => { if (live) setSessions(payload.sessions); })
      .catch(() => { /* Sessions are one section; a dead API already surfaces via agents. */ });
    return () => {
      live = false;
      if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus();
    };
  }, [open]);

  const pending = approvals?.buckets.pending ?? [];

  const items = useMemo((): PaletteItem[] => {
    const gates = approvalItems(pending);
    const blocked = new Set(pending.map((row) => `${row.project}:${row.sessionId}`));
    // A gate already listed under "Needs you" would otherwise repeat below.
    const rest = orderSessions(sessions ?? []).filter(
      (row) => !blocked.has(`${row.project}:${row.sessionId}`),
    );
    const agentItems = [...(agents ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent): PaletteItem => ({
        key: `agent:${agent.projectId}:${agent.path}`,
        group: 'Agents',
        title: agent.name,
        ...(agent.description ? { desc: agent.description } : {}),
        search: `${agent.projectId}/${agent.path}`,
        href: agentDetailHref(agent.projectId, agent.runPath),
      }));
    const pages = PAGES.map((page): PaletteItem => ({
      key: `page:${page.href}`,
      group: 'Pages',
      title: page.title,
      search: page.search,
      href: page.href,
    }));
    const actions: PaletteItem[] = [
      {
        key: 'action:new-agent',
        group: 'Actions',
        title: 'New agent',
        search: 'create agent new',
        href: '/agents?new=1',
      },
      {
        key: 'action:theme',
        group: 'Actions',
        title: pref === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        search: 'theme dark light appearance',
        act: () => setPref(pref === 'dark' ? 'light' : 'dark'),
      },
    ];
    // Empty query is a launchpad (blocked runs, then recents); typing searches
    // the full session window instead of the recent slice.
    return query.trim()
      ? [...gates, ...agentItems, ...rest.map((row) => sessionItem(row, 'Sessions')), ...pages, ...actions]
      : [...gates, ...rest.slice(0, RECENT_COUNT).map((row) => sessionItem(row, 'Recent')), ...agentItems, ...pages, ...actions];
  }, [pending, sessions, agents, pref, query]);

  const results = useMemo(() => rank(items, query.trim()), [items, query]);

  // Keep the active index in range as results change, and scroll it into view.
  useEffect(() => { if (active >= results.length) setActive(0); }, [results.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const close = () => setOpen(false);
  const go = (r: Ranked | undefined) => {
    if (!r) return;
    close();
    if (r.item.href) location.route(r.item.href);
    else r.item.act?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (results.length ? (i + 1) % results.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
  };

  // Manual focus trap: the palette is a plain role=dialog (not a native
  // <dialog>), so Tab would otherwise escape into the page behind the backdrop.
  // Keep Tab / Shift+Tab cycling among the palette's focusable elements.
  const onDialogKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex]:not([tabindex="-1"])') ?? [],
    );
    if (focusable.length === 0) { e.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey) {
      if (activeEl === first || !dialogRef.current?.contains(activeEl)) { e.preventDefault(); last.focus(); }
    } else if (activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Points screen readers at the option under the arrow-key cursor; undefined
  // when there are no results so nothing is announced as active.
  const activeOptionId = results.length > 0 && active < results.length ? `${listboxId}-opt-${active}` : undefined;

  if (!open) return null;

  const trimmed = query.trim();
  // Headers label the sections of the resting list. A query ranks every source
  // together, so groups interleave and a header per row is noise — the rows
  // carry their own meta there.
  const showGroups = trimmed === '';
  let lastGroup: PaletteGroup | null = null;

  return (
    <div class="palette-backdrop" onMouseDown={close}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={dialogRef} onKeyDown={onDialogKeyDown} onMouseDown={(e) => e.stopPropagation()}>
        <div class="palette-input">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search agents, sessions, pages…"
            role="combobox"
            aria-label="Search agents, sessions, pages"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            spellcheck={false}
            autocomplete="off"
          />
          <kbd class="palette-esc">esc</kbd>
        </div>
        <div class="palette-list" id={listboxId} ref={listRef} role="listbox">
          {loadError
            ? <div class="palette-empty">Failed to load agents: {loadError}</div>
            : agents === null
              ? <Loading wrapClass="palette-empty" label="Loading…" />
              : results.length === 0
                ? <div class="palette-empty">{trimmed ? `Nothing matches “${trimmed}”.` : 'Nothing loaded.'}</div>
                : results.map((r, i) => {
                  const header = !showGroups || r.item.group === lastGroup ? null : r.item.group;
                  lastGroup = r.item.group;
                  return (
                    <div class="palette-section" role="presentation" key={r.item.key}>
                      {header && <p class="palette-group" role="presentation">{header}</p>}
                      <button
                        type="button"
                        id={`${listboxId}-opt-${i}`}
                        class={i === active ? 'palette-row active' : 'palette-row'}
                        role="option"
                        aria-selected={i === active}
                        onMouseMove={() => setActive(i)}
                        onClick={() => go(r)}
                      >
                        <span class="palette-row-head">
                          <span class="palette-name">{highlight(r.item.title, r.titleHits)}</span>
                          {r.item.meta && <span class="palette-meta">{r.item.meta}</span>}
                        </span>
                        {r.item.desc && <span class="palette-desc">{r.item.desc}</span>}
                      </button>
                    </div>
                  );
                })}
        </div>
        <div class="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
