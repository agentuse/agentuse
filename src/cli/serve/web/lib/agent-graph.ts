import type { AgentRow } from "./api";

/**
 * Pure graph model + layered layout for the agents Graph view. Edges come
 * exclusively from declared frontmatter surfaced on `AgentRow`:
 *   - `subagents`  → delegation within one run (solid)
 *   - `dependsOn`  → advisory cross-run ordering (dashed)
 *   - `store`      → shared-store membership; a dependency edge between two
 *                    agents sharing a store carries that name as its label
 * No runtime semantics — this mirrors what the files say, nothing more.
 *
 * Layout model: every root (no incoming edges) claims its reachable subtree as
 * a CLUSTER, drawn as its own contiguous band of rows. A subagent reachable
 * from several roots (a judge shared by three managers) is DUPLICATED into
 * each band and flagged `shared` — each manager spawns its own instance, and
 * without duplication one shared utility leaf fuses otherwise-independent
 * workflows into a single tangled component. Node identity therefore splits in
 * two: `path` (the agent) vs `id` (one placed instance of it). An agent shared
 * through `dependsOn` runs only once, so its clusters MERGE instead — one
 * pipeline with several entry points (see below).
 */

export type EdgeKind = "delegation" | "dependency";

export interface GraphNode {
  /** Unique instance key (`path`, or `path@<cluster>` for shared duplicates). */
  id: string;
  /** Project-relative agent path (row identity), or the raw target for ghosts. */
  path: string;
  /** Display name: agent name, or the path tail for ghost targets. */
  name: string;
  agent?: AgentRow;
  /** Target declared but not present in the project (dangling or `../` external). */
  ghost: boolean;
  /** Column index in the layered layout (0 = leftmost / most upstream). */
  rank: number;
  /** Row index within the column (global; clusters stack via disjoint bands). */
  order: number;
  /** Entry point: the root agent of its cluster. */
  entry: boolean;
  /** Cluster (row band) index this instance belongs to. */
  component: number;
  /** Agent appears in more than one cluster; this is one of its copies. */
  shared: boolean;
  /** Shared store name, when the agent declares one. */
  store?: string;
}

export interface GraphEdge {
  /** Node instance ids (NOT paths). */
  from: string;
  to: string;
  kind: EdgeKind;
  /** Store name annotating a dependency edge whose ends share it. */
  store?: string;
}

export interface AgentGraph {
  /** Placed node instances, sorted by band then position. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Agents with no edges at all, rendered separately as a dimmed strip. */
  isolated: AgentRow[];
  /** Number of columns in the layout. */
  rankCount: number;
  /** Number of clusters (row bands). */
  componentCount: number;
}

interface RawEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  store?: string;
}

/**
 * Build the graph for ONE project's rows. Callers group by projectId first;
 * edges never cross projects (targets outside stay ghosts).
 */
export function buildAgentGraph(agents: AgentRow[]): AgentGraph {
  const byPath = new Map(agents.map((a) => [a.path, a]));
  const rawEdges: RawEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: RawEdge) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    rawEdges.push(edge);
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
  for (const e of rawEdges) { connected.add(e.from); connected.add(e.to); }
  const isolated = agents.filter((a) => !connected.has(a.path));

  const outgoing = new Map<string, RawEdge[]>();
  const incomingCount = new Map<string, number>();
  for (const path of connected) { outgoing.set(path, []); incomingCount.set(path, 0); }
  for (const e of rawEdges) {
    outgoing.get(e.from)!.push(e);
    incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
  }

  // Clusters: one per root, holding everything the root reaches. Cycle-only
  // subgraphs (no root) fall back to one cluster per leftover group.
  const roots = [...connected].filter((p) => (incomingCount.get(p) ?? 0) === 0).sort();
  let clusters: string[][] = [];
  const clusterOf = new Map<string, number[]>(); // path -> cluster indexes containing it
  const reach = (start: string): string[] => {
    const out: string[] = [];
    const visited = new Set<string>();
    const walk = (p: string) => {
      if (visited.has(p)) return;
      visited.add(p);
      out.push(p);
      for (const e of outgoing.get(p) ?? []) walk(e.to);
    };
    walk(start);
    return out;
  };
  for (const root of roots) clusters.push(reach(root));
  const leftovers = [...connected].filter((p) => !clusters.some((c) => c.includes(p))).sort();
  while (leftovers.length) {
    // A rootless cycle group: seed from its first member; reach() may not cover
    // mutual upstreams, so sweep repeatedly until the group is exhausted.
    const group = reach(leftovers[0]!);
    clusters.push(group);
    for (const p of group) {
      const i = leftovers.indexOf(p);
      if (i >= 0) leftovers.splice(i, 1);
    }
  }
  // Duplication is right for `subagents` only: the child really does run once
  // inside each manager's run, so two managers own two instances. `dependsOn`
  // is cross-run ordering — a shared agent reached that way runs ONCE, after
  // either upstream (daily + weekly → entry → rebalance). Splitting there is a
  // lie that also copies the whole tail and prints the same tile twice, so
  // merge those clusters and let the pipeline show its two entry points.
  const dependencyTargets = new Set(rawEdges.filter((e) => e.kind === "dependency").map((e) => e.to));
  const parent = clusters.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const membership = new Map<string, number[]>();
  clusters.forEach((cluster, k) => {
    for (const p of cluster) (membership.get(p) ?? membership.set(p, []).get(p)!).push(k);
  });
  for (const [path, ks] of membership) {
    if (ks.length < 2 || !dependencyTargets.has(path)) continue;
    for (let i = 1; i < ks.length; i++) {
      const a = find(ks[0]!);
      const b = find(ks[i]!);
      if (a !== b) parent[b] = a;
    }
  }
  const bandOf = new Map<number, number>(); // union root -> merged cluster index
  const mergedClusters: string[][] = [];
  clusters.forEach((cluster, k) => {
    const root = find(k);
    let band = bandOf.get(root);
    if (band === undefined) { band = mergedClusters.length; bandOf.set(root, band); mergedClusters.push([]); }
    const target = mergedClusters[band]!;
    for (const p of cluster) if (!target.includes(p)) target.push(p);
  });
  clusters = mergedClusters;

  // Big clusters first, then by root name for determinism.
  clusters.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
  clusters.forEach((cluster, k) => {
    for (const p of cluster) (clusterOf.get(p) ?? clusterOf.set(p, []).get(p)!).push(k);
  });

  // Instantiate nodes per (path, cluster); shared agents get one copy per band.
  const nodes = new Map<string, GraphNode>();
  const instanceId = (path: string, k: number) =>
    (clusterOf.get(path)?.length ?? 0) > 1 ? `${path}@${k}` : path;
  clusters.forEach((cluster, k) => {
    for (const path of cluster) {
      const agent = byPath.get(path);
      const sharedCopies = (clusterOf.get(path)?.length ?? 0) > 1;
      nodes.set(instanceId(path, k), {
        id: instanceId(path, k),
        path,
        name: agent?.name ?? (path.split("/").pop() ?? path).replace(/\.agentuse$/, ""),
        ...(agent && { agent }),
        ghost: !agent,
        rank: 0,
        order: 0,
        entry: false,
        component: k,
        shared: sharedCopies,
        ...(agent?.store && { store: agent.store }),
      });
    }
  });

  // Instance edges: a raw edge materializes once per cluster containing both
  // ends (reachability guarantees the target follows its source into a band).
  const edges: GraphEdge[] = [];
  for (const e of rawEdges) {
    for (const k of clusterOf.get(e.from) ?? []) {
      if (!clusterOf.get(e.to)?.includes(k)) continue;
      edges.push({ ...e, from: instanceId(e.from, k), to: instanceId(e.to, k) });
    }
  }

  const incoming = new Map<string, string[]>();
  const outgoingIds = new Map<string, string[]>();
  for (const e of edges) {
    (outgoingIds.get(e.from) ?? outgoingIds.set(e.from, []).get(e.from)!).push(e.to);
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push(e.from);
  }

  // Rank = longest path from the band's root, so a node always sits right of
  // ALL its upstreams. Cycles (linted server-side) break at the back-edge.
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const computeRank = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle back-edge: treat as root
    visiting.add(id);
    const ups = incoming.get(id) ?? [];
    const r = ups.length === 0 ? 0 : Math.max(...ups.map((u) => computeRank(u) + 1));
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const node of nodes.values()) node.rank = computeRank(node.id);

  // Entry: a real root that actually leads somewhere.
  for (const node of nodes.values()) {
    node.entry = !node.ghost
      && (incoming.get(node.id) ?? []).length === 0
      && (outgoingIds.get(node.id) ?? []).length > 0;
  }

  // Order within each column, cluster by cluster: one barycenter pass (average
  // of upstream rows) to reduce crossings, then stable alphabetical. `order`
  // is a global row index; clusters stack via a running offset.
  const rankCount = nodes.size === 0 ? 0 : Math.max(...[...nodes.values()].map((n) => n.rank)) + 1;
  const rowOf = new Map<string, number>();
  let rowOffset = 0;
  for (let k = 0; k < clusters.length; k++) {
    const comp = [...nodes.values()].filter((n) => n.component === k);
    const columns = new Map<number, GraphNode[]>();
    for (const n of comp) {
      (columns.get(n.rank) ?? columns.set(n.rank, []).get(n.rank)!).push(n);
    }
    let compRows = 0;
    const compRankMax = Math.max(...comp.map((n) => n.rank));
    for (let r = 0; r <= compRankMax; r++) {
      const col = columns.get(r) ?? [];
      const bary = (n: GraphNode): number => {
        const ups = (incoming.get(n.id) ?? []).map((u) => rowOf.get(u)).filter((v): v is number => v !== undefined);
        return ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      col.forEach((n, i) => { n.order = rowOffset + i; rowOf.set(n.id, n.order); });
      compRows = Math.max(compRows, col.length);
    }
    rowOffset += compRows;
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.component - b.component || a.rank - b.rank || a.order - b.order),
    edges,
    isolated,
    rankCount,
    componentCount: clusters.length,
  };
}
