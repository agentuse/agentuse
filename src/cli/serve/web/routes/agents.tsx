import type { VNode } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AboutInfo, AgentRow, SessionRow, SessionsPayload } from '../lib/api';
import { fetchAgents, fetchInfo, fetchSessions } from '../lib/api';
import { useSessionsStream } from '../hooks/use-sessions-stream';
import { term, termTitle } from '../lib/terms';
import { matchesAgentFilter } from '../lib/agent-filter';
import { LogContent } from '../components/content';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useAgentsView } from '../hooks/use-agents-view';
import { formatApprovalTime, formatRelativeTime, displayStatusLabel, runTone, isRunningStatus } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { usePins } from '../hooks/use-pins';
import { useAgentColumns } from '../hooks/use-agent-columns';
import { useMediaQuery } from '../hooks/use-media-query';
import { useRunAgent } from '../hooks/use-run-agent';
import { useSmartBack } from '../hooks/use-smart-back';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { RunInstructionDialog } from '../components/run-instruction-dialog';
import { AgentGraphView } from '../components/agent-graph-view';
import { GroupRail } from '../components/group-rail';
import { SchedulePill } from '../components/schedule-pill';
import { OnboardingEmptyState } from '../components/onboarding-empty-state';
import { FirstProjectEmptyState } from '../components/first-project-empty-state';
import { agentDetailHref } from '../lib/links';
import { NewAgentButton } from '../components/agent-create-dialog';

/** Shared empty fallback, so a miss never hands a memoizing child a fresh array. */
const NO_AGENTS: AgentRow[] = [];

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
        <span class="btn-spinner" aria-hidden="true" />
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
              <SchedulePill class="chip status" schedule={agent.schedule} human={agent.scheduleHuman} />
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

/** Link to the focused single-project agents view (/agents/:project). */
export function agentsProjectHref(projectId: string): string {
  return `/agents/${encodeURIComponent(projectId)}`;
}

/**
 * Recent sessions per agent file (newest first), joined client-side: sessions
 * carry an absolute `agent.filePath` while agents carry a project-relative
 * `path`, so each session is assigned to the agent whose path is the LONGEST
 * suffix of that file path within the same project — a root-level
 * `deploy.agentuse` must not claim runs of a nested `staging/deploy.agentuse`.
 */
function runHistoryFinder(agents: AgentRow[], sessions: SessionRow[]): (agent: AgentRow) => SessionRow[] {
  const agentsByProject = new Map<string, AgentRow[]>();
  for (const a of agents) {
    const list = agentsByProject.get(a.projectId);
    if (list) list.push(a);
    else agentsByProject.set(a.projectId, [a]);
  }
  const runs = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const filePath = s.agent.filePath;
    if (!filePath) continue;
    let owner: AgentRow | undefined;
    for (const a of agentsByProject.get(s.project) ?? []) {
      if (!filePath.endsWith(`/${a.path}`)) continue;
      if (!owner || a.path.length > owner.path.length) owner = a;
    }
    if (!owner) continue;
    const key = `${owner.projectId}::${owner.path}`;
    const list = runs.get(key);
    if (list) list.push(s);
    else runs.set(key, [s]);
  }
  for (const list of runs.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  const empty: SessionRow[] = [];
  return (agent) => runs.get(`${agent.projectId}::${agent.path}`) ?? empty;
}

/**
 * "Last run" health cell: status dot + relative time, linking to the session.
 * A live session gets the pulsing dot; ended states carry their label so the
 * signal never rides on color alone.
 */
function LastRunCell({ session }: { session: SessionRow | undefined }) {
  if (!session) return <span class="muted">—</span>;
  const label = displayStatusLabel(session.status, session.errorCode);
  const tone = runTone(session.status);
  const at = session.updatedAt || session.createdAt;
  const text = tone === 'running' ? 'running now'
    : tone === 'ok' ? formatRelativeTime(at)
      : tone === 'waiting' ? `waiting · ${formatRelativeTime(at)}`
        : `${label} · ${formatRelativeTime(at)}`;
  return (
    <a
      class={`lastrun ${tone}`}
      href={`/sessions/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(session.project)}`}
      title={`${label} · ${formatApprovalTime(at)}`}
      // Narrow screens hide the text and leave only the aria-hidden dot, so
      // the name must not depend on the link's subtree.
      aria-label={`Last run ${text}`}
    >
      <span class={`lastrun-dot ${tone}`} aria-hidden="true"></span>
      <span class="lastrun-text">{text}</span>
    </a>
  );
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

const RUNSPARK_LIMIT = 12;
const RUNSPARK_MAX_PX = 16;

/**
 * Per-agent run history strip: one bar per recent run, oldest first, height by
 * duration and color by outcome. Supplementary to the last-run text beside it,
 * so per-bar detail stays on hover; the aggregate lives in the aria-label.
 */
function RunHistorySpark({ runs }: { runs: SessionRow[] }) {
  if (runs.length === 0) return null;
  const shown = runs.slice(0, RUNSPARK_LIMIT).reverse();
  const durations = shown.map((s) => Math.max(0, (s.updatedAt || s.createdAt) - s.createdAt));
  const max = Math.max(1, ...durations);
  const failed = shown.filter((s) => runTone(s.status) === 'failed').length;
  return (
    <span
      class="runspark"
      role="img"
      aria-label={`Last ${shown.length} run${shown.length === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`}
    >
      {shown.map((s, i) => (
        <span
          key={s.sessionId}
          class={`runspark-bar ${runTone(s.status)}`}
          style={{ height: `${Math.max(3, Math.round((durations[i]! / max) * RUNSPARK_MAX_PX))}px` }}
          title={`${displayStatusLabel(s.status, s.errorCode)} · ${formatRelativeTime(s.createdAt)} · ${formatDuration(durations[i]!)}`}
        ></span>
      ))}
    </span>
  );
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

/** Everything a rendered agent row or card needs beyond the agent itself. */
interface RowCtx {
  pins: PinApi;
  columns: string[];
  runsFor: (a: AgentRow) => SessionRow[];
  lastRunFor: (a: AgentRow) => SessionRow | undefined;
}

/** The file name is redundant when the friendly name is just its dashed form. */
function fileLabelDiffers(name: string, fileName: string): boolean {
  const base = fileName.replace(/\.agentuse$/, '');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(name) !== norm(base);
}

function walk(node: TreeNode, levels: boolean[], rows: VNode[], ctx: RowCtx): void {
  const children = sortChildren(node);
  children.forEach((child, idx) => {
    const last = idx === children.length - 1;
    const prefix = guides(levels, last);
    if (child.agent) {
      const a = child.agent;
      const pinned = ctx.pins.isPinned(a);
      const running = isRunningStatus(ctx.lastRunFor(a)?.status);
      rows.push(
        <div class={pinned ? 'tree-row pinned' : 'tree-row'} key={a.path}>
          <span class="tree-path">
            {prefix}
            {pinned && <span class="tree-pin" title="Pinned" aria-label="Pinned"><PinIcon filled /></span>}
            <a class="tree-label" href={agentDetailHref(a.projectId, a.runPath)}>
              <span class="tree-agent">{a.name}</span>
              {running && <span class="tree-live" title="Running now" aria-label="Running now"></span>}
              {fileLabelDiffers(a.name, child.name) && <span class="tree-file">{child.name}</span>}
            </a>
          </span>
          {ctx.columns.map((id) => <span class={columnCellClass(id)} key={id}><ColumnCell id={id} agent={a} ctx={ctx} /></span>)}
          <span class="tree-menu"><AgentMenu agent={a} pinned={pinned} onTogglePin={() => ctx.pins.toggle(a)} /></span>
        </div>
      );
    } else {
      rows.push(
        <div class="tree-row dir" key={`dir:${levels.length}:${child.name}`}>
          <span class="tree-path">{prefix}<span class="tree-label">{child.name}/</span></span>
        </div>
      );
      walk(child, [...levels, !last], rows, ctx);
    }
  });
}

function AgentTree(props: { agents: AgentRow[]; ctx: RowCtx }) {
  const rows: VNode[] = [];
  walk(buildTree(props.agents), [], rows, props.ctx);
  return <>{rows}</>;
}

/**
 * One agent as a gallery tile: name and description do the talking, with the
 * run-history strip + last-run health underneath and model/schedule chips in
 * the footer. The card is a plain container (not one big link) because it
 * holds its own interactive children (Run, ⋯ menu, last-run link).
 */
function AgentCard(props: { agent: AgentRow; ctx: RowCtx; showProject?: boolean }) {
  const a = props.agent;
  const runs = props.ctx.runsFor(a);
  const last = runs[0];
  const running = isRunningStatus(last?.status);
  const pinned = props.ctx.pins.isPinned(a);
  return (
    <div class={running ? 'agent-card running' : 'agent-card'}>
      <div class="agent-card-head">
        {pinned && <span class="tree-pin" title="Pinned" aria-label="Pinned"><PinIcon filled /></span>}
        <a class="agent-card-name" href={agentDetailHref(a.projectId, a.runPath)}>{a.name}</a>
        {running && <span class="tree-live" title="Running now" aria-label="Running now"></span>}
        <AgentMenu agent={a} pinned={pinned} onTogglePin={() => props.ctx.pins.toggle(a)} />
      </div>
      {props.showProject && (
        <a class="agent-card-project" href={agentsProjectHref(a.projectId)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.75 4.25h4l1.2 1.5h7.3v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-8Z" />
            <path d="M1.75 5.75h12.5" />
          </svg>
          <span>{a.projectId}</span>
        </a>
      )}
      <div class="agent-card-desc">{a.description || <span class="agent-card-nodesc">{a.path.replace(/\.agentuse$/, '')}</span>}</div>
      <div class="agent-card-runs">
        <RunHistorySpark runs={runs} />
        <LastRunCell session={last} />
      </div>
      <div class="agent-card-foot">
        {a.schedule && <SchedulePill class="chip status" schedule={a.schedule} human={a.scheduleHuman} />}
        <span class="chip" title={a.model}>{a.model}</span>
        <span class="agent-card-runbtn"><RunButton agentPath={a.runPath} projectId={a.projectId} /></span>
      </div>
    </div>
  );
}

/**
 * Card-view project header. Keeping the collection summary inside the same
 * surface as its cards makes the project the primary visual unit, while live
 * activity remains visible without turning every project into a dashboard.
 */
function ProjectCollectionHeader(props: { projectId: string; agents: AgentRow[]; ctx: RowCtx; about?: AboutInfo | undefined }) {
  const liveCount = props.agents.filter((a) => isRunningStatus(props.ctx.lastRunFor(a)?.status)).length;
  const countLabel = `${props.agents.length} agent${props.agents.length === 1 ? '' : 's'}`;
  const name = props.about?.name ?? props.projectId;
  return (
    <div class="project-collection-head">
      <div class="project-collection-identity">
        <span class="project-collection-mark" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.25 5.25h5l1.5 2h9v8a1.25 1.25 0 0 1-1.25 1.25h-13a1.25 1.25 0 0 1-1.25-1.25v-10Z" />
            <path d="M2.25 7.25h15.5" />
          </svg>
        </span>
        <div>
          <span class="project-collection-label">{termTitle('project')}</span>
          <h2><a href={agentsProjectHref(props.projectId)} {...(props.about?.name ? { title: props.projectId } : {})}>{name}</a></h2>
          {props.about?.description && <p class="project-collection-desc">{props.about.description}</p>}
        </div>
      </div>
      <div class="project-collection-summary">
        {props.about?.owner && <span class="project-collection-owner">{props.about.owner}</span>}
        {liveCount > 0 && <span class="project-collection-live"><span aria-hidden="true"></span>{liveCount} running</span>}
        <span class="project-collection-count">{countLabel}</span>
        <a class="project-collection-open" href={agentsProjectHref(props.projectId)} aria-label={`Open ${name} ${term('project')}`}>
          Open <span aria-hidden="true">→</span>
        </a>
      </div>
    </div>
  );
}

interface AgentDirectoryGroup {
  directory: string;
  agents: AgentRow[];
}

/** The full parent directory is the useful grouping boundary, not just its first segment. */
function agentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function groupAgentsByDirectory(agents: AgentRow[]): AgentDirectoryGroup[] {
  const groups = new Map<string, AgentRow[]>();
  for (const agent of agents) {
    const directory = agentDirectory(agent.path);
    const group = groups.get(directory);
    if (group) group.push(agent);
    else groups.set(directory, [agent]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    })
    .map(([directory, groupedAgents]) => ({ directory, agents: groupedAgents }));
}

/**
 * Split a project's card gallery into collapsible shelves using the agents'
 * real parent directories. A lone root-level group stays unlabelled; every
 * actual directory remains visible as useful location context. Shelves order
 * by their displayed label (numeric-aware), so ABOUT names like "1 · Intake"
 * define the walk order even when directory names sort differently.
 */
function AgentDirectoryGroups(props: { agents: AgentRow[]; ctx: RowCtx; projectId: string; aboutFor: (dir: string) => AboutInfo | undefined }) {
  const groups = groupAgentsByDirectory(props.agents);
  const showDirectoryHeaders = groups.length > 1 || groups[0]?.directory !== '';
  if (!showDirectoryHeaders) {
    return (
      <div class="agent-cards">
        {[...props.agents].sort(cardOrder(props.ctx)).map((a) => <AgentCard key={`${a.projectId}::${a.path}`} agent={a} ctx={props.ctx} />)}
      </div>
    );
  }
  // A folder's ABOUT.md names the shelf (#156); the raw directory path
  // stays reachable as the heading tooltip. Translate, don't disguise.
  const labeled = groups.map((group) => ({
    ...group,
    about: group.directory ? props.aboutFor(group.directory) : undefined,
  })).map((group) => ({
    ...group,
    label: group.about?.name ?? (group.directory || `${term('project')} root`),
  })).sort((a, b) => {
    if (a.directory === '') return -1;
    if (b.directory === '') return 1;
    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });
  return (
    <div class="agent-directories">
      {labeled.map((group) => {
        const { about, label } = group;
        const id = `${projectAnchor(props.projectId)}-directory-${(group.directory || 'root').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        return (
          <details class="agent-directory" open key={group.directory || '__root'} style={`--shelf-span: ${Math.min(group.agents.length, 3)}`}>
            <summary aria-labelledby={id}>
              <svg class="agent-directory-folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M1.75 4.25h4l1.2 1.5h7.3v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-8Z" />
                <path d="M1.75 5.75h12.5" />
              </svg>
              <h3 id={id} {...(about?.name ? { title: group.directory } : {})}>{label}</h3>
              {about?.description && <span class="agent-directory-desc">{about.description}</span>}
              <span class="agent-directory-count">{group.agents.length}</span>
              <span class="agent-directory-rule"></span>
              <svg class="agent-directory-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m5 6 3 3 3-3" />
              </svg>
            </summary>
            <div class="agent-cards">
              {[...group.agents].sort(cardOrder(props.ctx)).map((a) => <AgentCard key={`${a.projectId}::${a.path}`} agent={a} ctx={props.ctx} />)}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** Gallery order: pinned first, then live runs, then most recently run, then name. */
function cardOrder(ctx: RowCtx): (a: AgentRow, b: AgentRow) => number {
  return (a, b) => {
    const pa = ctx.pins.isPinned(a) ? 1 : 0;
    const pb = ctx.pins.isPinned(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ra = ctx.lastRunFor(a);
    const rb = ctx.lastRunFor(b);
    const la = isRunningStatus(ra?.status) ? 1 : 0;
    const lb = isRunningStatus(rb?.status) ? 1 : 0;
    if (la !== lb) return lb - la;
    const ta = ra?.createdAt ?? 0;
    const tb = rb?.createdAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name);
  };
}

function PinnedRow(props: { agent: AgentRow; ctx: RowCtx }) {
  const a = props.agent;
  const locLabel = a.path.replace(/\.agentuse$/, '');
  return (
    <div class="pin-row">
      <span class="pin-main">
        <span class="tree-pin" aria-hidden="true"><PinIcon filled /></span>
        <a class="pin-name" href={agentDetailHref(a.projectId, a.runPath)}>{a.name}</a>
        <span class="pin-loc">{a.projectId} / {locLabel}</span>
      </span>
      {props.ctx.columns.map((id) => <span class={columnCellClass(id)} key={id}><ColumnCell id={id} agent={a} ctx={props.ctx} /></span>)}
      <span class="tree-menu"><AgentMenu agent={a} pinned onTogglePin={() => props.ctx.pins.toggle(a)} /></span>
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

/** Every column that can be shown: the three built-ins, then one per metadata key. */
function availableColumns(metaKeys: string[]): ColumnDef[] {
  return [
    { id: 'lastRun', label: 'Last run' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'run', label: 'Run' },
    ...metaKeys.map((k) => ({ id: META_PREFIX + k, label: k })),
  ];
}

function columnLabel(id: string): string {
  if (id === 'lastRun') return 'Last run';
  if (id === 'schedule') return 'Schedule';
  if (id === 'run') return 'Run';
  return id.startsWith(META_PREFIX) ? id.slice(META_PREFIX.length) : id;
}

/** Cell alignment class for a column (run + metadata get their own). */
function columnCellClass(id: string): string {
  if (id === 'run') return 'tree-run';
  if (id === 'lastRun') return 'tree-lastrun';
  if (id.startsWith(META_PREFIX)) return 'tree-meta';
  return '';
}

/** Render one column's cell for an agent row. */
function ColumnCell({ id, agent, ctx }: { id: string; agent: AgentRow; ctx: RowCtx }): VNode {
  if (id === 'lastRun') return <LastRunCell session={ctx.lastRunFor(agent)} />;
  if (id === 'schedule') {
    return agent.schedule
      ? <SchedulePill class="chip status" schedule={agent.schedule} human={agent.scheduleHuman} />
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

export default function Agents({ project }: { project?: string } = {}) {
  const scoped = typeof project === 'string' && project.length > 0;
  const location = useLocation();
  const goBack = useSmartBack('/agents');
  const { data, error, loading } = useFetch('agents', () => fetchAgents(), { refreshMs: 30_000 });
  const info = useFetch('agents-info', () => fetchInfo(), { refreshMs: 30_000 });
  // ABOUT.md identity (#156): directory path -> display info, keyed
  // `projectId::dir` with '.' for the project root. Missing entries fall back
  // to raw ids and paths, so an about-less deployment renders unchanged.
  const aboutIndex = new Map<string, AboutInfo>();
  for (const d of data?.dirs ?? []) aboutIndex.set(`${d.projectId}::${d.path}`, d.about);
  const aboutOf = (projectId: string, dir: string) => aboutIndex.get(`${projectId}::${dir || '.'}`);
  const projectLabel = (projectId: string) => aboutOf(projectId, '.')?.name ?? projectId;
  useTitle(pageTitle(scoped ? projectLabel(project) : 'Agents'));
  const { isPinned, toggle, keys } = usePins();
  const pins: PinApi = { isPinned, toggle };
  const { columns, addColumn, removeColumn } = useAgentColumns();
  const narrow = useMediaQuery('(max-width: 700px)');
  // Recent sessions power the "Last run" column (and the live pulse on rows).
  // 30d keeps rarely-run agents from reading as "never ran". Prefer the shared
  // sessions stream over polling, like Home: the hub pushes on a ~2s cadence
  // while anything is running, so a run's dot appears and clears promptly
  // instead of waiting out a poll tick. Polling stays as the fallback for when
  // the stream can't connect (proxies that buffer SSE, older daemons).
  const [streamedSessions, setStreamedSessions] = useState<SessionsPayload | null>(null);
  const [sessionsFallback, setSessionsFallback] = useState(false);
  const fetchedSessions = useFetch(
    'agents-last-runs',
    () => fetchSessions({ window: '30d', detail: 'agents' }),
    sessionsFallback ? { refreshMs: 10_000 } : {}
  );
  useSessionsStream({
    window: '30d',
    agent: undefined,
    status: undefined,
    triage: undefined,
    trigger: undefined,
    approval: undefined,
    detail: 'agents',
    enabled: !sessionsFallback,
    onData: setStreamedSessions,
    onError: () => setSessionsFallback(true),
    onFallback: () => setSessionsFallback(true),
  });
  const sessionRows = (streamedSessions ?? fetchedSessions.data)?.sessions ?? [];
  const { view, setView } = useAgentsView();

  // The filter lives in the URL (?q=) so a filtered view survives refresh and
  // back-navigation and can be shared. Typing keeps local state for instant
  // feedback and mirrors it into the URL with replaceState — no history entry
  // per keystroke, and no router re-render that could steal input focus.
  const [filter, setFilter] = useState(location.query.q ?? '');
  const syncUrl = (nextFilter: string) => {
    const base = scoped ? `/agents/${encodeURIComponent(project)}` : '/agents';
    const q = nextFilter.trim();
    history.replaceState(null, '', q ? `${base}?${new URLSearchParams({ q })}` : base);
  };
  const updateFilter = (value: string) => {
    setFilter(value);
    syncUrl(value);
  };
  const query = filter.trim().toLowerCase();

  // A scoped view (/agents/:project) narrows every downstream computation —
  // columns, filter counts, pins, groups — to a single project. Distinguish
  // "no such project" from "project loaded but empty" so the empty state reads
  // correctly. The API always returns every agent; scoping is a client filter.
  const allLoaded = useMemo(() => data?.agents ?? [], [data]);
  const projectMissing = scoped && info.data !== null && !info.data.projects.some((item) => item.id === project);
  const loadedAgents = useMemo(
    () => (scoped ? allLoaded.filter((a) => a.projectId === project) : allLoaded),
    [allLoaded, scoped, project],
  );
  // Per-project full row sets for the graph view, memoized so an unrelated
  // re-render here (a keystroke in the filter, a sessions poll) doesn't hand
  // AgentGraphView a fresh array and force it to rebuild every DAG.
  const graphAgentsByProject = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    for (const agent of loadedAgents) {
      const list = map.get(agent.projectId);
      if (list) list.push(agent);
      else map.set(agent.projectId, [agent]);
    }
    return map;
  }, [loadedAgents]);
  // Column model: built-ins + one per metadata key. `activeColumns` keeps the
  // user's saved order, dropping any metadata column whose key is no longer in
  // the payload. `renderColumns` is what actually renders (narrow screens keep
  // only Run; the rest live in the ⋯ menu).
  const metaKeys = metadataKeys(loadedAgents);
  const allColumns = availableColumns(metaKeys);
  const allColumnIds = new Set(allColumns.map((c) => c.id));
  const activeColumns = columns.filter((id) => allColumnIds.has(id));
  const inactiveColumns = allColumns.filter((c) => !activeColumns.includes(c.id));
  const renderColumns = narrow ? activeColumns.filter((id) => id === 'run' || id === 'lastRun') : activeColumns;
  const gridTemplate = columnsGridTemplate(renderColumns);
  const runsFor = runHistoryFinder(allLoaded, sessionRows);
  const lastRunFor = (a: AgentRow) => runsFor(a)[0];
  const rowCtx: RowCtx = { pins, columns: renderColumns, runsFor, lastRunFor };
  const allAgents = query ? loadedAgents.filter((a) => matchesAgentFilter(a, query)) : loadedAgents;
  const onboardingProject = scoped ? project : (info.data?.default ?? info.data?.projects[0]?.id);
  const noProjects = info.data?.projects.length === 0;
  const onboardingProjectInfo = info.data?.projects.find((item) => item.id === onboardingProject);
  const onboardingSession = sessionRows.find((session) =>
    session.trigger === 'onboarding' && session.project === onboardingProject);
  const showOnboarding = Boolean(
    data && info.data && !query && !projectMissing && onboardingProject &&
    onboardingProjectInfo?.agentCount === 0 && loadedAgents.length === 0
  );
  const byProject = new Map<string, AgentRow[]>();
  for (const agent of allAgents) {
    const list = byProject.get(agent.projectId);
    if (list) list.push(agent);
    else byProject.set(agent.projectId, [agent]);
  }
  const errors = (data?.errors ?? []).filter((e) => !scoped || e.projectId === project);
  const railItems = !scoped
    ? [...byProject.entries()].map(([projectId, agents]) => ({ id: projectAnchor(projectId), label: projectLabel(projectId), count: agents.length }))
    : [];

  // Pinned agents in the order they were pinned, skipping any that no longer
  // exist in the served set (scoped views only resolve pins in this project).
  const byKey = new Map<string, AgentRow>(allAgents.map((a) => [`${a.projectId}::${a.path}`, a]));
  const pinnedAgents = keys.map((k) => byKey.get(k)).filter((a): a is AgentRow => a !== undefined);

  const trimmed = filter.trim();
  const filterActive = query.length > 0;
  const filterLabel = `“${trimmed}”`;
  const lede = !data
    ? (loading ? 'Loading agents…' : '')
    : projectMissing
      ? `No ${term('project')} “${project}” is loaded here.`
      : filterActive
        ? `${allAgents.length} of ${loadedAgents.length} agent${loadedAgents.length === 1 ? '' : 's'} match ${filterLabel}.`
        : noProjects
          ? 'Create a project to keep your first agents and runs together.'
        : showOnboarding
          ? scoped ? `No agents in this ${term('project')} yet.` : 'No agents yet.'
        : scoped
          ? `${loadedAgents.length} agent${loadedAgents.length === 1 ? '' : 's'} in this ${term('project')}.`
          : `${loadedAgents.length} agent${loadedAgents.length === 1 ? '' : 's'} across ${byProject.size} ${term('project', byProject.size)}.`;
  const emptyMsg = filterActive
    ? `No agents match ${filterLabel}.`
    : projectMissing
      ? `No ${term('project')} “${project}” is loaded here.`
      : scoped
        ? `This ${term('project')} has no agents.`
        : 'No agents loaded yet.';

  return (
    <div class="page-agents">
      <Topbar currentPage="agents" />
      <GroupRail items={railItems} />
      <main>
        <header>
          {scoped
            ? <a class="back" href="/agents" onClick={goBack}>← all agents</a>
            : <div class="eyebrow">loaded agents</div>}
          <div class="agents-title-row">
            <h1 {...(scoped && aboutOf(project, '.')?.name ? { title: project } : {})}>{scoped ? projectLabel(project) : 'Agents'}</h1>
            {!noProjects && !projectMissing && <NewAgentButton {...(scoped ? { initialProjectId: project } : {})} />}
          </div>
          <p class="lede">{lede}</p>
          {scoped && (() => {
            // The scoped view is the project's detail surface: the ABOUT.md
            // description, owner, and body render here (#156).
            const about = aboutOf(project, '.');
            if (!about || (!about.description && !about.owner && !about.body)) return null;
            return (
              <div class="project-about">
                {(about.description || about.owner) && (
                  <p class="project-about-line">
                    {about.description}
                    {about.owner && <span class="project-about-owner">{about.description ? ' · ' : ''}{about.owner}</span>}
                  </p>
                )}
                {about.body && (
                  <details class="project-about-more">
                    <summary>About this {term('project')}</summary>
                    <LogContent value={about.body} forceMarkdown />
                  </details>
                )}
              </div>
            );
          })()}
          {loadedAgents.length > 0 && (
            <div class="agents-controls">
              <div class="agents-filter">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
                </svg>
                <input
                  type="search"
                  value={filter}
                  onInput={(e) => updateFilter((e.target as HTMLInputElement).value)}
                  placeholder="Filter agents by name, path, model…"
                  aria-label="Filter agents"
                  spellcheck={false}
                  autocomplete="off"
                />
                {filter && (
                  <button type="button" class="agents-filter-clear" aria-label="Clear filter" onClick={() => updateFilter('')}>×</button>
                )}
              </div>
              <div class="view-toggle" role="group" aria-label="Layout">
                <button type="button" class={view === 'tree' ? 'on' : ''} aria-pressed={view === 'tree'} onClick={() => setView('tree')}>Tree</button>
                <button type="button" class={view === 'cards' ? 'on' : ''} aria-pressed={view === 'cards'} onClick={() => setView('cards')}>Cards</button>
                <button type="button" class={view === 'graph' ? 'on' : ''} aria-pressed={view === 'graph'} onClick={() => setView('graph')}>Graph</button>
              </div>
            </div>
          )}
          {view === 'graph' && loadedAgents.length > 0 && (
            <div class="agent-graph-legend">
              <span class="agent-graph-legend-item">
                <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><path d="M1 4h24" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
                delegates to
              </span>
              <span class="agent-graph-legend-item">
                <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><path d="M1 4h24" stroke="currentColor" stroke-width="1.3" stroke-dasharray="5 4" fill="none" /></svg>
                depends on
              </span>
              <span class="agent-graph-legend-item">
                <span class="agent-graph-legend-entry" aria-hidden="true"></span>
                entry point
              </span>
              {!loadedAgents.some((a) => (a.subagents?.length ?? 0) > 0 || (a.dependsOn?.length ?? 0) > 0) && (
                <span class="agent-graph-legend-hint">
                  No relationships declared yet: add <code>dependsOn:</code> or <code>subagents:</code> to agent frontmatter.
                </span>
              )}
            </div>
          )}
          {view === 'tree' && loadedAgents.length > 0 && (
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
            {view === 'cards'
              ? <div class="agent-cards pinned-cards">
                  {pinnedAgents.map((a) => <AgentCard key={`${a.projectId}::${a.path}`} agent={a} ctx={rowCtx} showProject={!scoped} />)}
                </div>
              : <div class="panel">
                  <div class="pin-list" style={{ gridTemplateColumns: gridTemplate }}>
                    {pinnedAgents.map((a) => <PinnedRow key={`${a.projectId}::${a.path}`} agent={a} ctx={rowCtx} />)}
                  </div>
                </div>}
          </section>
        )}
        {noProjects && !scoped
          ? <FirstProjectEmptyState compact />
          : showOnboarding
          ? <OnboardingEmptyState
              compact
              {...(onboardingProject ? { projectId: onboardingProject } : {})}
              {...(onboardingProjectInfo?.about?.name ? { projectName: onboardingProjectInfo.about.name } : {})}
              {...(onboardingProjectInfo?.path ? { projectPath: onboardingProjectInfo.path } : {})}
              {...(onboardingSession ? { session: onboardingSession } : {})}
            />
          : byProject.size === 0
          ? <div class="panel">{loading && !data
            ? <Loading label="Loading agents…" />
            : <div class="empty">
              {emptyMsg}
              {filterActive && !projectMissing && (
                <button type="button" class="empty-action" onClick={() => updateFilter('')}>Clear filter</button>
              )}
            </div>}</div>
          : [...byProject.entries()].map(([projectId, agents]) => (
            <section class={view === 'cards' && !scoped ? 'group project-collection' : 'group'} id={projectAnchor(projectId)} key={projectId}>
              {!scoped && view === 'cards' && <ProjectCollectionHeader projectId={projectId} agents={agents} ctx={rowCtx} about={aboutOf(projectId, '.')} />}
              {!scoped && view !== 'cards' && (() => {
                // Live activity belongs on every project heading, not just the
                // card view's: it is the one thing worth interrupting a scan for.
                const live = agents.filter((a) => isRunningStatus(lastRunFor(a)?.status)).length;
                return (
                  <h2 class="group-title">
                    <a class="group-link" href={agentsProjectHref(projectId)} {...(aboutOf(projectId, '.')?.name ? { title: projectId } : {})}><span>{projectLabel(projectId)}</span></a>
                    <span class="count">{agents.length} agent{agents.length === 1 ? '' : 's'}</span>
                    {live > 0 && <span class="group-live"><span aria-hidden="true"></span>{live} running</span>}
                    <span class="rule"></span>
                  </h2>
                );
              })()}
              {view === 'cards'
                ? <AgentDirectoryGroups agents={agents} ctx={rowCtx} projectId={projectId} aboutFor={(dir) => aboutOf(projectId, dir)} />
                : view === 'graph'
                  // The graph gets the project's FULL row set (not the filtered
                  // slice): removing rows would sever edges. It applies the same
                  // query itself, hiding tiles with no match outright and dimming
                  // non-matching nodes inside the tiles that survive.
                  ? <AgentGraphView agents={graphAgentsByProject.get(projectId) ?? NO_AGENTS} query={query} lastRunFor={lastRunFor} />
                  : <div class="panel">
                      <div class="tree" style={{ gridTemplateColumns: gridTemplate }}>
                        <div class="tree-head">
                          <span>Tree</span>
                          {renderColumns.map((id) => <span key={id}>{columnLabel(id)}</span>)}
                          <span></span>
                        </div>
                        <AgentTree agents={agents} ctx={rowCtx} />
                      </div>
                    </div>}
            </section>
          ))}
      </main>
    </div>
  );
}
