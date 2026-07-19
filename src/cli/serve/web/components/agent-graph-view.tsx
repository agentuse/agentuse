import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentRow } from '../lib/api';
import { buildAgentGraph, type AgentGraph, type GraphEdge, type GraphNode } from '../lib/agent-graph';
import { agentDetailHref } from '../routes/agent-detail';

/**
 * The agents page's Graph layout: declared relationships for one project.
 * Each cluster (one workflow/fleet) renders as its own tile in a wrapping
 * grid, so narrow DAGs sit side by side on desktop instead of stacking down a
 * full-width canvas. Nodes are mini-cards (HTML: links, ellipsis, tooltips
 * for free) absolutely positioned over an SVG underlay per tile: solid edges
 * for `subagents:` delegation, dashed for `dependsOn:`, the latter labeled
 * with the shared store name on hover. Agents with no relationships render as
 * the same mini-cards in a Standalone section below.
 */

const NODE_W = 200;
const NODE_H = 58;
const COL_GAP = 84;
const ROW_GAP = 14;
const PAD = 10;

function nodeX(n: GraphNode): number { return PAD + n.rank * (NODE_W + COL_GAP); }

/** Provider prefixes repeat on every node; the bare model name is the signal. */
function shortModel(model: string): string {
  const i = model.indexOf(':');
  return i === -1 ? model : model.slice(i + 1);
}

/** Filter match mirroring the list views: dim, never remove, so edges survive. */
function matches(agent: AgentRow | undefined, query: string): boolean {
  if (!query) return true;
  if (!agent) return false;
  return [agent.name, agent.path, agent.model, agent.description ?? '']
    .some((v) => v.toLowerCase().includes(query));
}

/**
 * Tile header: the deepest directory shared by every member (the fleet's
 * natural name, full relative path like `agents/quotes/`), otherwise the
 * entry agent.
 */
function clusterTitle(nodes: GraphNode[]): string {
  // Shared duplicates are borrowed utilities (a judge in agents/shared/ used
  // by every fleet); letting them into the prefix would collapse
  // agents/substack/ down to agents/. Only fall back to them when the whole
  // cluster is borrowed.
  const own = nodes.filter((n) => !n.ghost && !n.shared);
  const members = own.length > 0 ? own : nodes.filter((n) => !n.ghost);
  let common: string[] | null = null;
  for (const n of members) {
    const dirs = n.path.split('/').slice(0, -1);
    if (common === null) { common = dirs; continue; }
    let i = 0;
    while (i < common.length && i < dirs.length && common[i] === dirs[i]) i++;
    common = common.slice(0, i);
  }
  if (common?.length) return `${common.join('/')}/`;
  // Prefer a real agent for the title; a ghost root (dangling target) should
  // not name the whole tile after something that doesn't exist.
  return nodes.find((n) => n.entry)?.name
    ?? nodes.find((n) => !n.ghost)?.name
    ?? nodes[0]?.name
    ?? '';
}

function MiniCardBody(props: { name: string; agent?: AgentRow | undefined; ghost?: boolean; shared?: boolean }) {
  const a = props.agent;
  return (
    <>
      <span class="agent-graph-node-name">
        {props.name}
        {a?.warnings && (
          <span class="agent-graph-warn" title={a.warnings.join('\n')}>⚠</span>
        )}
      </span>
      <span class="agent-graph-node-sub">
        {props.shared && <span class="agent-graph-shared-pill" title="Also used by other groups in this graph">shared</span>}
        {props.ghost
          ? <span class="agent-graph-ghost-note">not loaded</span>
          : a && (
            <>
              {/* Presence beats detail on a mini-card: the glyph says "scheduled",
                  the tooltip carries the cadence. */}
              {a.schedule && <span class="agent-graph-sched" title={`${a.scheduleHuman ?? a.schedule} (${a.schedule})`}>⏱</span>}
              <span class="agent-graph-model" title={a.model}>{shortModel(a.model)}</span>
            </>
          )}
      </span>
    </>
  );
}

function ClusterTile(props: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  markerId: string;
  query: string;
  hovered: string | null;
  setHovered: (id: string | null) => void;
}) {
  const { nodes, edges, query, hovered, setHovered } = props;
  // Overflow affordance: a blurred fade on whichever side has more canvas to
  // scroll to. State-driven (not pure CSS) so the fades vanish entirely when
  // the whole DAG fits.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const updateFade = () => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
  };
  useEffect(() => {
    updateFade();
    window.addEventListener('resize', updateFade);
    return () => window.removeEventListener('resize', updateFade);
  }, [nodes.length]);
  const minRow = Math.min(...nodes.map((n) => n.order));
  const nodeY = (n: GraphNode) => PAD + (n.order - minRow) * (NODE_H + ROW_GAP);
  const rankCount = Math.max(...nodes.map((n) => n.rank)) + 1;
  const width = PAD * 2 + rankCount * NODE_W + (rankCount - 1) * COL_GAP;
  const height = Math.max(...nodes.map((n) => nodeY(n))) + NODE_H + PAD;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const neighbors = new Set<string>();
  if (hovered) {
    neighbors.add(hovered);
    for (const e of edges) {
      if (e.from === hovered) neighbors.add(e.to);
      if (e.to === hovered) neighbors.add(e.from);
    }
  }

  return (
    <div class="agent-graph-cluster">
      <div class="agent-graph-cluster-head">
        <span class="agent-graph-cluster-title">{clusterTitle(nodes)}</span>
        <span class="agent-graph-cluster-count">{nodes.length}</span>
      </div>
      <div class="agent-graph-scrollwrap">
        <div class="agent-graph-scroll" ref={scrollRef} onScroll={updateFade}>
          <div class="agent-graph-canvas" style={{ width: `${width}px`, height: `${height}px` }}>
          <svg class="agent-graph-edges" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {edges.map((e) => {
              const from = byId.get(e.from);
              const to = byId.get(e.to);
              if (!from || !to) return null;
              const x1 = nodeX(from) + NODE_W;
              const y1 = nodeY(from) + NODE_H / 2;
              const x2 = nodeX(to) - 3;
              const y2 = nodeY(to) + NODE_H / 2;
              const midX = (x1 + x2) / 2;
              const active = hovered !== null && (e.from === hovered || e.to === hovered);
              const cls = [
                'agent-graph-edge',
                e.kind,
                hovered ? (active ? 'hi' : 'soft-dim') : '',
              ].filter(Boolean).join(' ');
              return (
                <g class={cls} key={`${e.kind}|${e.from}|${e.to}`}>
                  {/* Orthogonal rounded elbows instead of beziers: every edge
                      from one source shares the same horizontal stub and
                      mid-gap vertical, so a fan-out reads as a single trunk
                      that brackets its targets rather than N crossing curves. */}
                  <path
                    d={y1 === y2
                      ? `M ${x1} ${y1} H ${x2}`
                      : (() => {
                        const dir = y2 > y1 ? 1 : -1;
                        const r = Math.min(10, Math.abs(y2 - y1) / 2, (x2 - x1) / 2);
                        return `M ${x1} ${y1} H ${midX - r} Q ${midX} ${y1} ${midX} ${y1 + r * dir} V ${y2 - r * dir} Q ${midX} ${y2} ${midX + r} ${y2} H ${x2}`;
                      })()}
                    fill="none"
                    marker-end={`url(#${props.markerId})`}
                  />
                </g>
              );
            })}
          </svg>
          {nodes.map((n) => {
            const queryMiss = Boolean(query) && !matches(n.agent, query);
            const hoverMiss = hovered !== null && !neighbors.has(n.id);
            const cls = [
              'agent-graph-node',
              n.ghost ? 'ghost' : '',
              n.entry ? 'entry' : '',
              queryMiss ? 'dim' : hoverMiss ? 'soft-dim' : '',
            ].filter(Boolean).join(' ');
            const style = { left: `${nodeX(n)}px`, top: `${nodeY(n)}px`, width: `${NODE_W}px`, height: `${NODE_H}px` };
            const body = <MiniCardBody name={n.name} agent={n.agent} ghost={n.ghost} shared={n.shared} />;
            return n.agent
              ? (
                <a
                  key={n.id}
                  class={cls}
                  style={style}
                  href={agentDetailHref(n.agent.projectId, n.agent.runPath)}
                  title={n.path}
                  onMouseEnter={() => setHovered(n.id)}
                  onMouseLeave={() => setHovered(null)}
                >{body}</a>
              )
              : (
                <div
                  key={n.id}
                  class={cls}
                  style={style}
                  title={n.path}
                  onMouseEnter={() => setHovered(n.id)}
                  onMouseLeave={() => setHovered(null)}
                >{body}</div>
              );
          })}
          {/* Store labels only surface on hover, as HTML chips floating above
              the edge midpoint: store names are wider than the column gap, so
              inline SVG text would run under the neighboring cards. A solid
              chip may overlap a card and still read as a tooltip. */}
          {hovered !== null && edges.filter((e) => e.store && (e.from === hovered || e.to === hovered)).map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const midX = (nodeX(from) + NODE_W + nodeX(to) - 3) / 2;
            const midY = (nodeY(from) + nodeY(to)) / 2 + NODE_H / 2;
            return (
              <span
                key={`label|${e.kind}|${e.from}|${e.to}`}
                class="agent-graph-edge-label"
                style={{ left: `${midX}px`, top: `${midY}px` }}
              >⛁ {e.store}</span>
            );
          })}
          </div>
        </div>
        {fade.left && <div class="agent-graph-fade left" aria-hidden="true"></div>}
        {fade.right && <div class="agent-graph-fade right" aria-hidden="true"></div>}
      </div>
    </div>
  );
}

export function AgentGraphView(props: { agents: AgentRow[]; query: string }) {
  const graph: AgentGraph = buildAgentGraph(props.agents);
  const [hovered, setHovered] = useState<string | null>(null);

  // One arrowhead marker per project section (markers resolve by document id,
  // so tiles share a single hidden defs svg instead of colliding per tile).
  const markerId = 'agent-graph-arrow';
  const clusters: GraphNode[][] = [];
  for (const n of graph.nodes) {
    (clusters[n.component] ??= []).push(n);
  }
  const memberIds = clusters.map((c) => new Set(c.map((n) => n.id)));
  const clusterEdges = (k: number) => graph.edges.filter((e) => memberIds[k]!.has(e.from));

  return (
    <div class="agent-graph">
      <svg class="agent-graph-defs" width="0" height="0" aria-hidden="true">
        <defs>
          {/* Two markers, same shape: the base one matches the edge stroke, the
              -hi one matches the hover highlight. CSS swaps marker-end on .hi
              edges, since marker contents can't see the referencing stroke. */}
          {[markerId, `${markerId}-hi`].map((id) => (
            <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.5 L7.5 4 L0 7.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </marker>
          ))}
        </defs>
      </svg>
      {clusters.length > 0 && (
        <div class="agent-graph-grid">
          {clusters.map((nodes, k) => (
            <ClusterTile
              key={nodes[0]!.id}
              nodes={nodes}
              edges={clusterEdges(k)}
              markerId={markerId}
              query={props.query}
              hovered={hovered}
              setHovered={setHovered}
            />
          ))}
        </div>
      )}
      {graph.isolated.length > 0 && (
        <div class="agent-graph-standalone">
          <div class="agent-graph-cluster-head">
            <span class="agent-graph-cluster-title">standalone</span>
            <span class="agent-graph-cluster-count">{graph.isolated.length}</span>
          </div>
          <div class="agent-graph-standalone-grid">
            {graph.isolated.map((a) => (
              <a
                key={a.path}
                class={`agent-graph-node static${props.query && !matches(a, props.query) ? ' dim' : ''}`}
                href={agentDetailHref(a.projectId, a.runPath)}
                title={a.path}
              >
                <MiniCardBody name={a.name} agent={a} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
