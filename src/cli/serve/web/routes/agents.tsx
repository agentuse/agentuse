import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentRow } from '../lib/api';
import { fetchAgents } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { usePins } from '../hooks/use-pins';
import { useAgentColumns } from '../hooks/use-agent-columns';
import { useMediaQuery } from '../hooks/use-media-query';
import { useRunAgent } from '../hooks/use-run-agent';
import { Topbar } from '../components/topbar';
import { RunInstructionDialog } from '../components/run-instruction-dialog';
import { agentDetailHref } from './agent-detail';

/**
 * Starts the agent in the background and navigates straight to its live session
 * view. The run endpoint pre-assigns the session id and returns it before the
 * run produces anything, so the redirect can carry it (plus a view token on
 * token-gated daemons) and the session page streams the run as it happens.
 */
function RunButton(props: { agentPath: string; projectId: string }) {
  const { run, busy, error } = useRunAgent(props.agentPath, props.projectId);

  const onRun = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    void run();
  };

  return (
    <button
      type="button"
      class="run-btn"
      disabled={busy}
      onClick={onRun}
      aria-label="Run this agent"
      title={error ?? 'Run this agent now and open its session'}
    >
      {busy ? (
        <span class="run-btn-spinner" aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 3.5v9a.75.75 0 0 0 1.14.64l7.25-4.5a.75.75 0 0 0 0-1.28l-7.25-4.5A.75.75 0 0 0 5 3.5Z" />
        </svg>
      )}
    </button>
  );
}

function PinIcon(props: { filled?: boolean }) {
  // Lucide "pin", drawn with stroke; the filled state is conveyed by colour.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class={props.filled ? 'pin-svg filled' : 'pin-svg'}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/**
 * Per-agent overflow menu. Holds the bits pulled off the row (full name, model)
 * plus the pin toggle. The popover is rendered with position:fixed so it is not
 * clipped by the panel's overflow:hidden; it closes on outside click, Escape,
 * scroll, or resize (the anchor rect is captured once at open time).
 */
function AgentMenu(props: { agent: AgentRow; pinned: boolean; onTogglePin: () => void }) {
  const { agent, pinned, onTogglePin } = props;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const { run, busy, error } = useRunAgent(agent.runPath, agent.projectId);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <div class="agent-menu">
      <button
        type="button"
        ref={btnRef}
        class={pos ? 'menu-btn open' : 'menu-btn'}
        aria-haspopup="menu"
        aria-expanded={pos ? 'true' : 'false'}
        aria-label="Agent details and actions"
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {pos && (
        <div ref={popRef} class="menu-popover" role="menu" style={{ top: `${pos.top}px`, right: `${pos.right}px` }}>
          <div class="menu-name">{agent.name}</div>
          {agent.description && <div class="menu-desc">{agent.description}</div>}
          <div class="menu-meta">
            <span class="menu-meta-label">Model</span>
            <span class="chip">{agent.model}</span>
          </div>
          {agent.schedule && (
            <div class="menu-meta">
              <span class="menu-meta-label">Schedule</span>
              <span class="chip status" title={agent.schedule}>{agent.scheduleHuman ?? agent.schedule}</span>
            </div>
          )}
          {agent.metadata && Object.keys(agent.metadata).length > 0 && (
            <div class="menu-meta-block">
              <span class="menu-meta-label">Metadata</span>
              <div class="menu-kv">
                {Object.entries(agent.metadata).map(([k, v]) => (
                  <div class="menu-kv-row" key={k}>
                    <span class="menu-kv-key">{k}</span>
                    <span class="menu-kv-val"><MetaValue value={v} /></span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div class="menu-sep" />
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPos(null); setRunOpen(true); }}
          >
            <svg class="menu-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5 3.5v9a.75.75 0 0 0 1.14.64l7.25-4.5a.75.75 0 0 0 0-1.28l-7.25-4.5A.75.75 0 0 0 5 3.5Z" />
            </svg>
            <span>Run with Custom Instruction</span>
          </button>
          <a
            class="menu-item"
            role="menuitem"
            href={agentDetailHref(agent.projectId, agent.runPath)}
            onClick={() => setPos(null)}
          >
            <svg class="menu-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 4 2.5 8 6 12" /><path d="M10 4l3.5 4L10 12" />
            </svg>
            <span>Open agent</span>
          </a>
          <button
            type="button"
            class={pinned ? 'menu-item unpin' : 'menu-item'}
            role="menuitem"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(); setPos(null); }}
          >
            <PinIcon filled={pinned} />
            <span>{pinned ? 'Unpin from top' : 'Pin to top'}</span>
          </button>
        </div>
      )}
      <RunInstructionDialog
        open={runOpen}
        agentName={agent.name}
        busy={busy}
        error={error}
        onSubmit={(instruction) => { void run(instruction); }}
        onClose={() => { if (!busy) setRunOpen(false); }}
      />
    </div>
  );
}

function projectAnchor(projectId: string): string {
  return `project-${projectId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  agent?: AgentRow;
}

function buildTree(agents: AgentRow[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map() };
  for (const agent of agents) {
    const parts = agent.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.agent = agent;
      node = child;
    });
  }
  return root;
}

function sortChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.agent === undefined;
    const bDir = b.agent === undefined;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function guides(levels: boolean[], last: boolean): VNode[] {
  const cells = levels.map((continues, i) => <span class={`guide${continues ? ' v' : ''}`} key={`g${i}`}></span>);
  cells.push(<span class={`guide elbow${last ? ' last' : ''}`} key="elbow"></span>);
  return cells;
}

interface PinApi {
  isPinned: (a: AgentRow) => boolean;
  toggle: (a: AgentRow) => void;
}

function walk(node: TreeNode, levels: boolean[], rows: VNode[], pins: PinApi, columns: string[]): void {
  const children = sortChildren(node);
  children.forEach((child, idx) => {
    const last = idx === children.length - 1;
    const prefix = guides(levels, last);
    if (child.agent) {
      const a = child.agent;
      const pinned = pins.isPinned(a);
      rows.push(
        <div class={pinned ? 'tree-row pinned' : 'tree-row'} key={a.path}>
          <span class="tree-path">
            {prefix}
            {pinned && <span class="tree-pin" title="Pinned" aria-label="Pinned"><PinIcon filled /></span>}
            <a class="tree-label" href={agentDetailHref(a.projectId, a.runPath)}>{child.name}</a>
          </span>
          {columns.map((id) => <span class={columnCellClass(id)} key={id}><ColumnCell id={id} agent={a} /></span>)}
          <span class="tree-menu"><AgentMenu agent={a} pinned={pinned} onTogglePin={() => pins.toggle(a)} /></span>
        </div>
      );
    } else {
      rows.push(
        <div class="tree-row dir" key={`dir:${levels.length}:${child.name}`}>
          <span class="tree-path">{prefix}<span class="tree-label">{child.name}/</span></span>
        </div>
      );
      walk(child, [...levels, !last], rows, pins, columns);
    }
  });
}

function AgentTree(props: { agents: AgentRow[]; pins: PinApi; columns: string[] }) {
  const rows: VNode[] = [];
  walk(buildTree(props.agents), [], rows, props.pins, props.columns);
  return <>{rows}</>;
}

function PinnedRow(props: { agent: AgentRow; pins: PinApi; columns: string[] }) {
  const a = props.agent;
  const locLabel = a.path.replace(/\.agentuse$/, '');
  return (
    <div class="pin-row">
      <span class="pin-main">
        <span class="tree-pin" aria-hidden="true"><PinIcon filled /></span>
        <a class="pin-name" href={agentDetailHref(a.projectId, a.runPath)}>{a.name}</a>
        <span class="pin-loc">{a.projectId} / {locLabel}</span>
      </span>
      {props.columns.map((id) => <span class={columnCellClass(id)} key={id}><ColumnCell id={id} agent={a} /></span>)}
      <span class="tree-menu"><AgentMenu agent={a} pinned onTogglePin={() => props.pins.toggle(a)} /></span>
    </div>
  );
}

/** Union of metadata keys across the loaded agents, sorted, for the column picker. */
function metadataKeys(agents: AgentRow[]): string[] {
  const keys = new Set<string>();
  for (const a of agents) {
    if (a.metadata) for (const k of Object.keys(a.metadata)) keys.add(k);
  }
  return [...keys].sort();
}

/** Flatten metadata scalars into a search string (keys always, scalar values too). */
function metadataText(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  return Object.entries(metadata)
    .map(([k, v]) => (v == null || typeof v === 'object' ? k : `${k} ${v}`))
    .join(' ');
}

/**
 * One metadata value rendered for a cell: booleans as a chip/muted flag,
 * scalars as truncated text, missing or non-scalar values as a muted dash.
 * The framework never interprets the key, so this only formats the value.
 */
function MetaValue({ value }: { value: unknown }): VNode {
  if (value === true) return <span class="chip status">true</span>;
  if (value === false) return <span class="muted">false</span>;
  if (value == null) return <span class="muted">—</span>;
  if (typeof value === 'string' || typeof value === 'number') {
    const s = String(value);
    return <span class="tree-meta-val" title={s}>{s}</span>;
  }
  let json = '';
  try { json = JSON.stringify(value); } catch { /* circular; leave blank */ }
  return <span class="muted" title={json}>{'{…}'}</span>;
}

const META_PREFIX = 'meta:';

interface ColumnDef { id: string; label: string; }

/** Every column that can be shown: the two built-ins, then one per metadata key. */
function availableColumns(metaKeys: string[]): ColumnDef[] {
  return [
    { id: 'schedule', label: 'Schedule' },
    { id: 'run', label: 'Run' },
    ...metaKeys.map((k) => ({ id: META_PREFIX + k, label: k })),
  ];
}

function columnLabel(id: string): string {
  if (id === 'schedule') return 'Schedule';
  if (id === 'run') return 'Run';
  return id.startsWith(META_PREFIX) ? id.slice(META_PREFIX.length) : id;
}

/** Cell alignment class for a column (run + metadata get their own). */
function columnCellClass(id: string): string {
  if (id === 'run') return 'tree-run';
  if (id.startsWith(META_PREFIX)) return 'tree-meta';
  return '';
}

/** Render one column's cell for an agent row. */
function ColumnCell({ id, agent }: { id: string; agent: AgentRow }): VNode {
  if (id === 'schedule') {
    return agent.schedule
      ? <span class="chip status" title={agent.schedule}>{agent.scheduleHuman ?? agent.schedule}</span>
      : <span class="muted">—</span>;
  }
  if (id === 'run') return <RunButton agentPath={agent.runPath} projectId={agent.projectId} />;
  if (id.startsWith(META_PREFIX)) return <MetaValue value={agent.metadata?.[id.slice(META_PREFIX.length)]} />;
  return <span class="muted">—</span>;
}

/** Grid template for a tree/pin grid: Tree(1fr) + one auto per column + menu. */
function columnsGridTemplate(columns: string[]): string {
  return ['minmax(0, 1fr)', ...columns.map(() => 'auto'), 'auto'].join(' ');
}

/** Case-insensitive substring match across the fields a user is likely to type. */
function matchesFilter(agent: AgentRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${agent.name} ${agent.path} ${agent.description ?? ''} ${agent.projectId} ${agent.model} ${agent.schedule ?? ''} ${metadataText(agent.metadata)}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export default function Agents() {
  useTitle('AgentUse / Agents');
  const { data, error, loading } = useFetch('agents', () => fetchAgents(), { refreshMs: 30_000 });
  const { isPinned, toggle, keys } = usePins();
  const pins: PinApi = { isPinned, toggle };
  const { columns, addColumn, removeColumn } = useAgentColumns();
  const narrow = useMediaQuery('(max-width: 700px)');

  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();

  const loadedAgents = data?.agents ?? [];
  // Column model: built-ins + one per metadata key. `activeColumns` keeps the
  // user's saved order, dropping any metadata column whose key is no longer in
  // the payload. `renderColumns` is what actually renders (narrow screens keep
  // only Run; the rest live in the ⋯ menu).
  const metaKeys = metadataKeys(loadedAgents);
  const allColumns = availableColumns(metaKeys);
  const allColumnIds = new Set(allColumns.map((c) => c.id));
  const activeColumns = columns.filter((id) => allColumnIds.has(id));
  const inactiveColumns = allColumns.filter((c) => !activeColumns.includes(c.id));
  const renderColumns = narrow ? activeColumns.filter((id) => id === 'run') : activeColumns;
  const gridTemplate = columnsGridTemplate(renderColumns);
  const allAgents = query ? loadedAgents.filter((a) => matchesFilter(a, query)) : loadedAgents;
  const byProject = new Map<string, AgentRow[]>();
  for (const agent of allAgents) {
    const list = byProject.get(agent.projectId);
    if (list) list.push(agent);
    else byProject.set(agent.projectId, [agent]);
  }
  const errors = data?.errors ?? [];

  // Pinned agents in the order they were pinned, skipping any that no longer
  // exist in the served set.
  const byKey = new Map<string, AgentRow>(allAgents.map((a) => [`${a.projectId}::${a.path}`, a]));
  const pinnedAgents = keys.map((k) => byKey.get(k)).filter((a): a is AgentRow => a !== undefined);

  return (
    <div class="page-agents">
      <Topbar currentPage="agents" />
      <main>
        <header>
          <div class="eyebrow">loaded agents</div>
          <h1>Agents</h1>
          <p class="lede">{data
            ? query
              ? `${allAgents.length} of ${loadedAgents.length} agent${loadedAgents.length === 1 ? '' : 's'} match “${filter.trim()}”.`
              : `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'} across ${byProject.size} project${byProject.size === 1 ? '' : 's'} in this serve daemon.`
            : loading ? 'Loading agents…' : ''}</p>
          {loadedAgents.length > 0 && (
            <div class="agents-filter">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
              </svg>
              <input
                type="search"
                value={filter}
                onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
                placeholder="Filter agents by name, path, model…"
                aria-label="Filter agents"
                spellcheck={false}
                autocomplete="off"
              />
              {filter && (
                <button type="button" class="agents-filter-clear" aria-label="Clear filter" onClick={() => setFilter('')}>×</button>
              )}
            </div>
          )}
          {loadedAgents.length > 0 && (
            <div class="agents-cols">
              <span class="agents-cols-label">Columns</span>
              {activeColumns.length === 0 && <span class="agents-cols-empty">none</span>}
              {activeColumns.map((id) => (
                <span class="col-pill" key={id}>
                  {columnLabel(id)}
                  <button
                    type="button"
                    class="col-pill-x"
                    aria-label={`Remove ${columnLabel(id)} column`}
                    onClick={() => removeColumn(id)}
                  >×</button>
                </span>
              ))}
              {inactiveColumns.length > 0 && (
                <div class="agents-cols-select agents-cols-add">
                  <select
                    aria-label="Add column"
                    value=""
                    onChange={(e) => {
                      const el = e.target as HTMLSelectElement;
                      if (el.value) addColumn(el.value);
                      el.value = '';
                    }}
                  >
                    <option value="">+ Add column</option>
                    {inactiveColumns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
          {error && <div class="errors">Failed to load agents: {error.message}</div>}
          {errors.length > 0 && (
            <details class="issues">
              <summary class="issues-badge">⚠ {errors.length} failed to parse</summary>
              <div class="issues-popover">
                <h3>{errors.length} agent{errors.length === 1 ? '' : 's'} failed to parse</h3>
                <ul>{errors.map((err) => <li key={`${err.projectId}/${err.path}`}><code>{err.projectId}/{err.path}</code><span class="msg">{err.message.split('\n')[0]}</span></li>)}</ul>
              </div>
            </details>
          )}
        </header>
        {pinnedAgents.length > 0 && (
          <section class="group pinned-group">
            <h2 class="group-title"><span>Pinned</span><span class="count">{pinnedAgents.length}</span><span class="rule"></span></h2>
            <div class="panel">
              <div class="pin-list" style={{ gridTemplateColumns: gridTemplate }}>
                {pinnedAgents.map((a) => <PinnedRow key={`${a.projectId}::${a.path}`} agent={a} pins={pins} columns={renderColumns} />)}
              </div>
            </div>
          </section>
        )}
        {byProject.size === 0
          ? <div class="panel"><div class="empty">{loading ? 'Loading…' : query ? `No agents match “${filter.trim()}”.` : 'No agents loaded by this serve daemon.'}</div></div>
          : [...byProject.entries()].map(([projectId, agents]) => (
            <section class="group" id={projectAnchor(projectId)} key={projectId}>
              <h2 class="group-title"><span>{projectId}</span><span class="count">{agents.length} agent{agents.length === 1 ? '' : 's'}</span><span class="rule"></span></h2>
              <div class="panel">
                <div class="tree" style={{ gridTemplateColumns: gridTemplate }}>
                  <div class="tree-head">
                    <span>Tree</span>
                    {renderColumns.map((id) => <span key={id}>{columnLabel(id)}</span>)}
                    <span></span>
                  </div>
                  <AgentTree agents={agents} pins={pins} columns={renderColumns} />
                </div>
              </div>
            </section>
          ))}
      </main>
    </div>
  );
}
