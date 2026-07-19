import { useState } from 'preact/hooks';
import type { AgentRow } from '../lib/api';
import { buildAgentGraph, type AgentGraph, type GraphNode } from '../lib/agent-graph';
import { agentDetailHref } from '../routes/agent-detail';

/**
 * The agents page's Graph layout: declared relationships for one project as a
 * left-to-right DAG. Nodes are HTML (links, ellipsis, tooltips for free)
 * absolutely positioned over an SVG underlay that draws the edges — solid for
 * `subagents:` delegation, dashed for `dependsOn:`, the latter labeled with
 * the shared store name when both ends declare it. Agents with no
 * relationships render as a dimmed strip below rather than cluttering the DAG.
 */

const NODE_W = 176;
const NODE_H = 52;
const COL_GAP = 72;
const ROW_GAP = 16;
/** Extra space between independent subgraphs (component row bands). */
const COMP_GAP = 36;
const PAD = 12;

function nodeX(n: GraphNode): number { return PAD + n.rank * (NODE_W + COL_GAP); }
function nodeY(n: GraphNode): number { return PAD + n.order * (NODE_H + ROW_GAP) + n.component * COMP_GAP; }

/** Filter match mirroring the list views: dim, never remove, so edges survive. */
function matches(agent: AgentRow | undefined, query: string): boolean {
  if (!query) return true;
  if (!agent) return false;
  return [agent.name, agent.path, agent.model, agent.description ?? '']
    .some((v) => v.toLowerCase().includes(query));
}

export function AgentGraphView(props: { agents: AgentRow[]; query: string }) {
  const graph: AgentGraph = buildAgentGraph(props.agents);
  const [hovered, setHovered] = useState<string | null>(null);

  const width = PAD * 2 + graph.rankCount * NODE_W + Math.max(0, graph.rankCount - 1) * COL_GAP;
  const height = graph.nodes.length === 0 ? 0 : Math.max(...graph.nodes.map((n) => nodeY(n))) + NODE_H + PAD;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const neighbors = new Set<string>();
  if (hovered) {
    neighbors.add(hovered);
    for (const e of graph.edges) {
      if (e.from === hovered) neighbors.add(e.to);
      if (e.to === hovered) neighbors.add(e.from);
    }
  }

  return (
    <div class="agent-graph panel">
      {graph.nodes.length === 0
        ? <div class="empty">No declared relationships yet. Add <code>dependsOn:</code> or <code>subagents:</code> to agent frontmatter to draw edges here.</div>
        : (
          <div class="agent-graph-scroll">
            <div class="agent-graph-canvas" style={{ width: `${width}px`, height: `${height}px` }}>
              <svg class="agent-graph-edges" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
                <defs>
                  <marker id="agent-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0.5 L7.5 4 L0 7.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </marker>
                </defs>
                {graph.edges.map((e) => {
                  const from = byId.get(e.from);
                  const to = byId.get(e.to);
                  if (!from || !to) return null;
                  const x1 = nodeX(from) + NODE_W;
                  const y1 = nodeY(from) + NODE_H / 2;
                  const x2 = nodeX(to) - 3;
                  const y2 = nodeY(to) + NODE_H / 2;
                  const bend = Math.max(28, (x2 - x1) / 2);
                  const cls = [
                    'agent-graph-edge',
                    e.kind,
                    hovered ? (e.from === hovered || e.to === hovered ? 'hi' : 'dim') : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <g class={cls} key={`${e.kind}|${e.from}|${e.to}`}>
                      <path
                        d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        marker-end="url(#agent-graph-arrow)"
                      />
                      {e.store && (
                        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} text-anchor="middle">⛁ {e.store}</text>
                      )}
                    </g>
                  );
                })}
              </svg>
              {graph.nodes.map((n) => {
                const dimmed = (props.query && !matches(n.agent, props.query))
                  || (hovered !== null && !neighbors.has(n.id));
                const cls = [
                  'agent-graph-node',
                  n.ghost ? 'ghost' : '',
                  n.entry ? 'entry' : '',
                  n.shared ? 'shared' : '',
                  dimmed ? 'dim' : '',
                ].filter(Boolean).join(' ');
                const style = { left: `${nodeX(n)}px`, top: `${nodeY(n)}px`, width: `${NODE_W}px`, height: `${NODE_H}px` };
                const body = (
                  <>
                    <span class="agent-graph-node-name">
                      {n.name}
                      {n.agent?.warnings && (
                        <span class="agent-graph-warn" title={n.agent.warnings.join('\n')}>⚠</span>
                      )}
                    </span>
                    <span class="agent-graph-node-sub">
                      {n.entry && <span class="agent-graph-entry-pill">entry</span>}
                      {n.shared && <span class="agent-graph-shared-pill" title="Also used by other groups in this graph">shared</span>}
                      {n.store && <span class="agent-graph-store">⛁ {n.store}</span>}
                      {n.ghost && <span class="agent-graph-ghost-note">not loaded</span>}
                    </span>
                  </>
                );
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
            </div>
          </div>
        )}
      {graph.isolated.length > 0 && (
        <div class="agent-graph-isolated">
          <span class="agent-graph-isolated-label">No declared relationships</span>
          {graph.isolated.map((a) => (
            <a
              key={a.path}
              class={`agent-graph-chip${props.query && !matches(a, props.query) ? ' dim' : ''}`}
              href={agentDetailHref(a.projectId, a.runPath)}
              title={a.path}
            >{a.name}</a>
          ))}
        </div>
      )}
    </div>
  );
}
