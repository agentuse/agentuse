import type { AgentRow } from "./api";

/**
 * Pure graph model + layered layout for the agents Graph view. Edges come
 * exclusively from declared frontmatter surfaced on `AgentRow`:
 *   - `subagents`  → delegation within one run (solid)
 *   - `dependsOn`  → advisory cross-run ordering (dashed)
 *   - `store`      → shared-store membership; a dependency edge between two
 *                    agents sharing a store carries that name as its label
 * No runtime semantics — this mirrors what the files say, nothing more.
 */

export type EdgeKind = "delegation" | "dependency";

export interface GraphNode {
  /** Project-relative agent path (row identity), or the raw target for ghosts. */
  path: string;
  /** Display name: agent name, or the path tail for ghost targets. */
  name: string;
  agent?: AgentRow;
  /** Target declared but not present in the project (dangling or `../` external). */
  ghost: boolean;
  /** Column index in the layered layout (0 = leftmost / most upstream). */
  rank: number;
  /** Row index within the column. */
  order: number;
  /** Entry point: depended on / delegating, but not itself downstream of anything. */
  entry: boolean;
  /**
   * Weakly-connected-component index. Independent subgraphs each get their own
   * band of rows so pipelines never interleave; the view adds extra vertical
   * space between bands.
   */
  component: number;
  /** Shared store name, when the agent declares one. */
  store?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Store name annotating a dependency edge whose ends share it. */
  store?: string;
}

export interface AgentGraph {
  /** Connected nodes, positioned (rank/order assigned). */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Agents with no edges at all, rendered separately as a dimmed strip. */
  isolated: AgentRow[];
  /** Number of columns in the layout. */
  rankCount: number;
  /** Number of independent subgraphs (row bands). */
  componentCount: number;
}

/**
 * Build the graph for ONE project's rows. Callers group by projectId first;
 * edges never cross projects (targets outside stay ghosts).
 */
export function buildAgentGraph(agents: AgentRow[]): AgentGraph {
  const byPath = new Map(agents.map((a) => [a.path, a]));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: GraphEdge) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const agent of agents) {
    for (const target of agent.subagents ?? []) {
      pushEdge({ from: agent.path, to: target, kind: "delegation" });
    }
    for (const target of agent.dependsOn ?? []) {
      if (target === agent.path) continue; // self reference: linted server-side, never drawn
      const upstream = byPath.get(target);
      const store = agent.store && upstream?.store === agent.store ? agent.store : undefined;
      // dependsOn points at the upstream agent; the arrow flows downstream.
      pushEdge({ from: target, to: agent.path, kind: "dependency", ...(store && { store }) });
    }
  }

  const connected = new Set<string>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }

  const isolated = agents.filter((a) => !connected.has(a.path));

  // Node set: every connected row plus ghost targets that have no row.
  const nodes = new Map<string, GraphNode>();
  for (const path of connected) {
    const agent = byPath.get(path);
    nodes.set(path, {
      path,
      name: agent?.name ?? (path.split("/").pop() ?? path).replace(/\.agentuse$/, ""),
      ...(agent && { agent }),
      ghost: !agent,
      rank: 0,
      order: 0,
      entry: false,
      component: 0,
      ...(agent?.store && { store: agent.store }),
    });
  }

  // Rank = longest path from any root, so a node always sits right of ALL its
  // upstreams. Cycles (linted server-side) are broken by ignoring back-edges.
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e.to);
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push(e.from);
  }
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const computeRank = (path: string): number => {
    const known = rank.get(path);
    if (known !== undefined) return known;
    if (visiting.has(path)) return 0; // cycle back-edge: treat as root
    visiting.add(path);
    const ups = incoming.get(path) ?? [];
    const r = ups.length === 0 ? 0 : Math.max(...ups.map((u) => computeRank(u) + 1));
    visiting.delete(path);
    rank.set(path, r);
    return r;
  };
  for (const node of nodes.values()) node.rank = computeRank(node.path);

  // Entry: a real root that actually leads somewhere.
  for (const node of nodes.values()) {
    node.entry = !node.ghost
      && (incoming.get(node.path) ?? []).length === 0
      && (outgoing.get(node.path) ?? []).length > 0;
  }

  // Weakly connected components: independent subgraphs must not interleave in
  // shared columns (with several pipelines that reads as one tangled graph),
  // so each gets its own contiguous band of rows.
  const compRoot = new Map<string, string>();
  const find = (p: string): string => {
    let root = p;
    while (compRoot.get(root) !== root) root = compRoot.get(root) ?? root;
    compRoot.set(p, root);
    return root;
  };
  for (const path of nodes.keys()) compRoot.set(path, path);
  for (const e of edges) {
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) compRoot.set(a, b);
  }
  const members = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    const root = find(node.path);
    (members.get(root) ?? members.set(root, []).get(root)!).push(node);
  }
  // Big graphs first, then alphabetical by their first node for determinism.
  const components = [...members.values()].sort((a, b) =>
    b.length - a.length
    || (a[0]?.name ?? '').localeCompare(b[0]?.name ?? '')
    || (a[0]?.path ?? '').localeCompare(b[0]?.path ?? ''));

  // Order within each column, component by component: one barycenter pass
  // (average of upstream rows) to reduce crossings, then stable alphabetical.
  // `order` is a global row index; components stack via a running offset.
  const rankCount = nodes.size === 0 ? 0 : Math.max(...[...nodes.values()].map((n) => n.rank)) + 1;
  const rowOf = new Map<string, number>();
  let rowOffset = 0;
  components.forEach((comp, compIndex) => {
    for (const n of comp) n.component = compIndex;
    const columns = new Map<number, GraphNode[]>();
    for (const n of comp) {
      (columns.get(n.rank) ?? columns.set(n.rank, []).get(n.rank)!).push(n);
    }
    let compRows = 0;
    const compRankMax = Math.max(...comp.map((n) => n.rank));
    for (let r = 0; r <= compRankMax; r++) {
      const col = columns.get(r) ?? [];
      const bary = (n: GraphNode): number => {
        const ups = (incoming.get(n.path) ?? []).map((u) => rowOf.get(u)).filter((v): v is number => v !== undefined);
        return ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      col.forEach((n, i) => { n.order = rowOffset + i; rowOf.set(n.path, n.order); });
      compRows = Math.max(compRows, col.length);
    }
    rowOffset += compRows;
  });

  return {
    nodes: [...nodes.values()].sort((a, b) => a.component - b.component || a.rank - b.rank || a.order - b.order),
    edges,
    isolated,
    rankCount,
    componentCount: components.length,
  };
}
