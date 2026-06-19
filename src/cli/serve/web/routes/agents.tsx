import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { AgentRow } from '../lib/api';
import { fetchAgents, runAgentDetached } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';

/**
 * Starts the agent in the background and navigates straight to its live session
 * view. The run endpoint pre-assigns the session id and returns it before the
 * run produces anything, so the redirect can carry it (plus a view token on
 * token-gated daemons) and the session page streams the run as it happens.
 */
function RunButton(props: { agentPath: string; projectId: string }) {
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRun = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await runAgentDetached(props.agentPath, props.projectId);
      const params = new URLSearchParams({ project: props.projectId, pending: '1' });
      if (res.token) params.set('token', res.token);
      location.route(`/sessions/${encodeURIComponent(res.sessionId)}?${params.toString()}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      class="run-btn"
      disabled={busy}
      onClick={onRun}
      title={error ?? 'Run this agent now and open its session'}
    >
      {busy ? 'Starting…' : 'Run'}
    </button>
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

function walk(node: TreeNode, levels: boolean[], rows: VNode[]): void {
  const children = sortChildren(node);
  children.forEach((child, idx) => {
    const last = idx === children.length - 1;
    const prefix = guides(levels, last);
    if (child.agent) {
      const a = child.agent;
      const agentId = a.path.replace(/\.agentuse$/, '');
      rows.push(
        <div class="tree-row" key={a.path}>
          <span class="tree-path">{prefix}<a class="tree-label" href={`/sessions?agent=${encodeURIComponent(agentId)}`}>{child.name}</a></span>
          <span class="tree-name">{a.name}{a.description && <div class="tree-desc">{a.description}</div>}</span>
          <span><span class="chip">{a.model}</span></span>
          <span>{a.schedule ? <span class="chip status">{a.schedule}</span> : <span class="muted">—</span>}</span>
          <span class="tree-run"><RunButton agentPath={a.runPath} projectId={a.projectId} /></span>
        </div>
      );
    } else {
      rows.push(
        <div class="tree-row dir" key={`dir:${levels.length}:${child.name}`}>
          <span class="tree-path">{prefix}<span class="tree-label">{child.name}/</span></span>
        </div>
      );
      walk(child, [...levels, !last], rows);
    }
  });
}

function AgentTree(props: { agents: AgentRow[] }) {
  const rows: VNode[] = [];
  walk(buildTree(props.agents), [], rows);
  return <>{rows}</>;
}

export default function Agents() {
  useTitle('AgentUse / Agents');
  const { data, error, loading } = useFetch('agents', () => fetchAgents(), { refreshMs: 30_000 });

  const byProject = new Map<string, AgentRow[]>();
  for (const agent of data?.agents ?? []) {
    const list = byProject.get(agent.projectId);
    if (list) list.push(agent);
    else byProject.set(agent.projectId, [agent]);
  }
  const errors = data?.errors ?? [];

  return (
    <div class="page-agents">
      <Topbar currentPage="agents" />
      <main>
        <header>
          <div class="eyebrow">loaded agents</div>
          <h1>Agents</h1>
          <p class="lede">{data
            ? `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'} across ${byProject.size} project${byProject.size === 1 ? '' : 's'} in this serve daemon.`
            : loading ? 'Loading agents…' : ''}</p>
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
        {byProject.size === 0
          ? <div class="panel"><div class="empty">{loading ? 'Loading…' : 'No agents loaded by this serve daemon.'}</div></div>
          : [...byProject.entries()].map(([projectId, agents]) => (
            <section class="group" id={projectAnchor(projectId)} key={projectId}>
              <h2 class="group-title"><span>{projectId}</span><span class="count">{agents.length} agent{agents.length === 1 ? '' : 's'}</span><span class="rule"></span></h2>
              <div class="panel">
                <div class="tree">
                  <div class="tree-head"><span>Tree</span><span>Name</span><span>Model</span><span>Schedule</span><span>Run</span></div>
                  <AgentTree agents={agents} />
                </div>
              </div>
            </section>
          ))}
      </main>
    </div>
  );
}
