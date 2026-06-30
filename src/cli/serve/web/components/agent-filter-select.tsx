import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

/**
 * Searchable single-select for the sessions agent filter. Click to open the
 * full agent list, type to search it (id or name), choose to apply. Unlike the
 * native <datalist>, the list stays browsable after a value is set and the
 * query never narrows the underlying sessions feed — it only filters the
 * dropdown. Selecting commits via `onChange`; the inline ✕ clears it.
 */
export function AgentFilterSelect(props: {
  options: Array<[id: string, name: string]>;
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(([id, name]) =>
      id.toLowerCase().includes(q) || name.toLowerCase().includes(q));
  }, [props.options, query]);

  useEffect(() => { if (active >= filtered.length) setActive(0); }, [filtered.length]);
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('.agent-select-opt.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const openList = () => { setOpen(true); setQuery(''); setActive(0); };
  const choose = (id: string) => { setOpen(false); setQuery(''); props.onChange(id); };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openList(); else setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const opt = filtered[active]; if (opt) choose(opt[0]); }
  };

  return (
    <div class="agent-select" ref={rootRef}>
      <input
        ref={inputRef}
        type="text"
        value={open ? query : props.value}
        placeholder="any"
        spellcheck={false}
        autocomplete="off"
        aria-label="Filter by agent"
        aria-expanded={open}
        onFocus={openList}
        onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setActive(0); setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {props.value && !open && (
        <button
          type="button"
          class="agent-select-clear"
          aria-label="Clear agent filter"
          onMouseDown={(e) => { e.preventDefault(); choose(''); }}
        >×</button>
      )}
      {open && (
        <div class="agent-select-pop" ref={listRef} role="listbox">
          {filtered.length === 0
            ? <div class="agent-select-empty">No agents match.</div>
            : filtered.map(([id, name], i) => (
              <button
                type="button"
                key={id}
                class={`agent-select-opt${i === active ? ' active' : ''}${id === props.value ? ' selected' : ''}`}
                role="option"
                aria-selected={id === props.value}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(id); }}
              >
                <span class="agent-select-id">{id}</span>
                <span class="agent-select-name">{name}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
