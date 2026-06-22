import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentRow } from '../lib/api';
import { fetchAgents } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { usePins } from '../hooks/use-pins';
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

function walk(node: TreeNode, levels: boolean[], rows: VNode[], pins: PinApi): void {
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
          <span>{a.schedule ? <span class="chip status" title={a.schedule}>{a.scheduleHuman ?? a.schedule}</span> : <span class="muted">—</span>}</span>
          <span class="tree-run"><RunButton agentPath={a.runPath} projectId={a.projectId} /></span>
          <span class="tree-menu"><AgentMenu agent={a} pinned={pinned} onTogglePin={() => pins.toggle(a)} /></span>
        </div>
      );
    } else {
      rows.push(
        <div class="tree-row dir" key={`dir:${levels.length}:${child.name}`}>
          <span class="tree-path">{prefix}<span class="tree-label">{child.name}/</span></span>
        </div>
      );
      walk(child, [...levels, !last], rows, pins);
    }
  });
}

function AgentTree(props: { agents: AgentRow[]; pins: PinApi }) {
  const rows: VNode[] = [];
  walk(buildTree(props.agents), [], rows, props.pins);
  return <>{rows}</>;
}

function PinnedRow(props: { agent: AgentRow; pins: PinApi }) {
  const a = props.agent;
  const locLabel = a.path.replace(/\.agentuse$/, '');
  return (
    <div class="pin-row">
      <span class="pin-main">
        <span class="tree-pin" aria-hidden="true"><PinIcon filled /></span>
        <a class="pin-name" href={agentDetailHref(a.projectId, a.runPath)}>{a.name}</a>
        <span class="pin-loc">{a.projectId} / {locLabel}</span>
      </span>
      <span>{a.schedule ? <span class="chip status" title={a.schedule}>{a.scheduleHuman ?? a.schedule}</span> : <span class="muted">—</span>}</span>
      <span class="tree-run"><RunButton agentPath={a.runPath} projectId={a.projectId} /></span>
      <span class="tree-menu"><AgentMenu agent={a} pinned onTogglePin={() => props.pins.toggle(a)} /></span>
    </div>
  );
}

/** Case-insensitive substring match across the fields a user is likely to type. */
function matchesFilter(agent: AgentRow, query: string): boolean {
  if (!query) return true;
  const haystack = `${agent.name} ${agent.path} ${agent.description ?? ''} ${agent.projectId} ${agent.model} ${agent.schedule ?? ''}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export default function Agents() {
  useTitle('AgentUse / Agents');
  const { data, error, loading } = useFetch('agents', () => fetchAgents(), { refreshMs: 30_000 });
  const { isPinned, toggle, keys } = usePins();
  const pins: PinApi = { isPinned, toggle };

  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();

  const loadedAgents = data?.agents ?? [];
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
              <div class="pin-list">
                {pinnedAgents.map((a) => <PinnedRow key={`${a.projectId}::${a.path}`} agent={a} pins={pins} />)}
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
                <div class="tree">
                  <div class="tree-head"><span>Tree</span><span>Schedule</span><span>Run</span><span></span></div>
                  <AgentTree agents={agents} pins={pins} />
                </div>
              </div>
            </section>
          ))}
      </main>
    </div>
  );
}
