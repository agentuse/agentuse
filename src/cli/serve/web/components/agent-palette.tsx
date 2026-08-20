import type { VNode } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { AgentRow } from '../lib/api';
import { fetchAgents } from '../lib/api';
import { Loading } from './loading';
import { agentDetailHref } from '../lib/links';

/** Window event the topbar dispatches to open the palette (touch devices have no ⌘K). */
export const PALETTE_OPEN_EVENT = 'agentuse:open-palette';

/** Open the agent palette from anywhere (e.g. a tappable button). */
export function openAgentPalette() {
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
}

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

interface Ranked {
  agent: AgentRow;
  /** Matched indices into the agent name, for highlighting (empty if matched elsewhere). */
  nameHits: number[];
}

/** Rank agents against the query. Empty query lists all, sorted by name. */
function rank(agents: AgentRow[], query: string): Ranked[] {
  if (!query) {
    return [...agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({ agent, nameHits: [] }));
  }
  const scored: Array<Ranked & { score: number }> = [];
  for (const agent of agents) {
    const onName = fuzzyScore(agent.name, query);
    const secondary = `${agent.projectId}/${agent.path}`;
    const onPath = fuzzyScore(secondary, query);
    // Name matches outrank path-only matches by a wide margin.
    const best = onName
      ? { score: onName.score + 50, nameHits: onName.indices }
      : onPath
        ? { score: onPath.score, nameHits: [] as number[] }
        : null;
    if (best) scored.push({ agent, nameHits: best.nameHits, score: best.score });
  }
  scored.sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
  return scored;
}

/** Render a name with the fuzzy-matched characters wrapped in <mark>. */
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

/**
 * Global "go to agent" command palette. Opens on ⌘K / Ctrl+K from any serve
 * page, fuzzy-matches agent names, and navigates to the agent detail page on
 * Enter. Agents are fetched lazily on first open and cached for the session.
 */
export function AgentPalette() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
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

  // Fetch agents the first time the palette opens; reset transient state and
  // focus the input on every open.
  useEffect(() => {
    if (!open) return;
    // Remember what had focus so we can hand it back when the palette closes.
    const returnFocusTo = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    let live = true;
    if (!agents && !loadError) {
      fetchAgents()
        .then((payload) => { if (live) setAgents(payload.agents); })
        .catch((err: Error) => { if (live) setLoadError(err.message); });
    }
    return () => {
      live = false;
      if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus();
    };
  }, [open]);

  const results = useMemo(() => rank(agents ?? [], query.trim()), [agents, query]);

  // Keep the active index in range as results change, and scroll it into view.
  useEffect(() => { if (active >= results.length) setActive(0); }, [results.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const close = () => setOpen(false);
  const go = (r: Ranked | undefined) => {
    if (!r) return;
    close();
    location.route(agentDetailHref(r.agent.projectId, r.agent.runPath));
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

  return (
    <div class="palette-backdrop" onMouseDown={close}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Go to agent" ref={dialogRef} onKeyDown={onDialogKeyDown} onMouseDown={(e) => e.stopPropagation()}>
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
            placeholder="Go to agent…"
            role="combobox"
            aria-label="Go to agent"
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
              ? <Loading wrapClass="palette-empty" label="Loading agents…" />
              : results.length === 0
                ? <div class="palette-empty">{query.trim() ? `No agents match “${query.trim()}”.` : 'No agents loaded.'}</div>
                : results.map((r, i) => (
                  <button
                    type="button"
                    key={`${r.agent.projectId}::${r.agent.path}`}
                    id={`${listboxId}-opt-${i}`}
                    class={i === active ? 'palette-row active' : 'palette-row'}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => go(r)}
                  >
                    <span class="palette-name">{highlight(r.agent.name, r.nameHits)}</span>
                    {r.agent.description && <span class="palette-desc">{r.agent.description}</span>}
                  </button>
                ))}
        </div>
        <div class="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open agent</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
