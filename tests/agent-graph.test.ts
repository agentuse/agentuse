import { describe, it, expect } from 'bun:test';
import { buildAgentGraph } from '../src/cli/serve/web/lib/agent-graph';
import type { AgentRow } from '../src/cli/serve/web/lib/api';

function row(partial: Partial<AgentRow> & { path: string }): AgentRow {
  return {
    projectId: 'p',
    runPath: partial.path,
    name: partial.path.split('/').pop()!.replace(/\.agentuse$/, ''),
    model: 'anthropic:claude-sonnet-4-0',
    ...partial,
  };
}

describe('buildAgentGraph', () => {
  it('separates isolated agents from connected ones', () => {
    const graph = buildAgentGraph([
      row({ path: 'a.agentuse', subagents: ['b.agentuse'] }),
      row({ path: 'b.agentuse' }),
      row({ path: 'lonely.agentuse' }),
    ]);
    expect(graph.nodes.map((n) => n.path).sort()).toEqual(['a.agentuse', 'b.agentuse']);
    expect(graph.isolated.map((a) => a.path)).toEqual(['lonely.agentuse']);
  });

  it('flows dependency arrows downstream and ranks upstream first', () => {
    const graph = buildAgentGraph([
      row({ path: 'scrape.agentuse', store: 'leads' }),
      row({ path: 'enrich.agentuse', store: 'leads', dependsOn: ['scrape.agentuse'] }),
      row({ path: 'outreach.agentuse', store: 'leads', dependsOn: ['enrich.agentuse'] }),
    ]);
    expect(graph.edges).toContainEqual({ from: 'scrape.agentuse', to: 'enrich.agentuse', kind: 'dependency', store: 'leads' });
    const byPath = new Map(graph.nodes.map((n) => [n.path, n]));
    expect(byPath.get('scrape.agentuse')!.rank).toBe(0);
    expect(byPath.get('enrich.agentuse')!.rank).toBe(1);
    expect(byPath.get('outreach.agentuse')!.rank).toBe(2);
    expect(byPath.get('scrape.agentuse')!.entry).toBe(true);
    expect(byPath.get('enrich.agentuse')!.entry).toBe(false);
    expect(graph.rankCount).toBe(3);
  });

  it('omits the store label when ends declare different stores', () => {
    const graph = buildAgentGraph([
      row({ path: 'a.agentuse', store: 'one' }),
      row({ path: 'b.agentuse', store: 'two', dependsOn: ['a.agentuse'] }),
    ]);
    expect(graph.edges[0]!.store).toBeUndefined();
  });

  it('renders unknown targets as ghost nodes', () => {
    const graph = buildAgentGraph([
      row({ path: 'b.agentuse', dependsOn: ['missing.agentuse', '../outside/x.agentuse'] }),
    ]);
    const ghosts = graph.nodes.filter((n) => n.ghost).map((n) => n.path).sort();
    expect(ghosts).toEqual(['../outside/x.agentuse', 'missing.agentuse']);
    expect(graph.nodes.find((n) => n.path === '../outside/x.agentuse')!.name).toBe('x');
  });

  it('drops self references and survives cycles', () => {
    const graph = buildAgentGraph([
      row({ path: 'a.agentuse', dependsOn: ['a.agentuse', 'b.agentuse'] }),
      row({ path: 'b.agentuse', dependsOn: ['a.agentuse'] }),
    ]);
    expect(graph.edges.filter((e) => e.from === e.to)).toHaveLength(0);
    // Cycle a<->b still yields finite ranks and both nodes present.
    expect(graph.nodes).toHaveLength(2);
    expect(graph.rankCount).toBeGreaterThan(0);
  });

  it('stacks independent subgraphs into separate row bands', () => {
    const graph = buildAgentGraph([
      row({ path: 'p1/a.agentuse', subagents: ['p1/b.agentuse'] }),
      row({ path: 'p1/b.agentuse' }),
      row({ path: 'p2/x.agentuse', dependsOn: ['p2/y.agentuse'] }),
      row({ path: 'p2/y.agentuse' }),
      row({ path: 'p3/m.agentuse', subagents: ['p3/w1.agentuse', 'p3/w2.agentuse'] }),
      row({ path: 'p3/w1.agentuse' }),
      row({ path: 'p3/w2.agentuse' }),
    ]);
    expect(graph.componentCount).toBe(3);
    const byPath = new Map(graph.nodes.map((n) => [n.path, n]));
    // Members of one subgraph share a component; different subgraphs never do.
    expect(byPath.get('p1/a.agentuse')!.component).toBe(byPath.get('p1/b.agentuse')!.component);
    expect(byPath.get('p2/x.agentuse')!.component).toBe(byPath.get('p2/y.agentuse')!.component);
    expect(byPath.get('p1/a.agentuse')!.component).not.toBe(byPath.get('p2/x.agentuse')!.component);
    // Row bands are disjoint: no shared `order` across components in any column.
    const seen = new Map<string, number>();
    for (const n of graph.nodes) {
      const prev = seen.get(`${n.rank}:${n.order}`);
      expect(prev === undefined || prev === n.component).toBe(true);
      seen.set(`${n.rank}:${n.order}`, n.component);
    }
    // Largest subgraph (3 nodes) sorts first.
    expect(byPath.get('p3/m.agentuse')!.component).toBe(0);
  });

  it('duplicates subagents shared across managers into each band', () => {
    const graph = buildAgentGraph([
      row({ path: 'li.agentuse', subagents: ['judge.agentuse'] }),
      row({ path: 'ss.agentuse', subagents: ['judge.agentuse'] }),
      row({ path: 'judge.agentuse' }),
    ]);
    // Without duplication the shared judge would fuse both managers into one
    // tangled band; instead each manager keeps its own cluster and copy.
    expect(graph.componentCount).toBe(2);
    const judges = graph.nodes.filter((n) => n.path === 'judge.agentuse');
    expect(judges).toHaveLength(2);
    expect(judges.every((n) => n.shared)).toBe(true);
    expect(new Set(judges.map((n) => n.component)).size).toBe(2);
    // Each band carries its own edge to its own copy.
    expect(graph.edges).toHaveLength(2);
    expect(new Set(graph.edges.map((e) => e.to)).size).toBe(2);
    // Unshared nodes keep path identity as their instance id.
    expect(graph.nodes.find((n) => n.path === 'li.agentuse')!.id).toBe('li.agentuse');
  });

  it('ranks a delegation fan-out with manager on the left', () => {
    const graph = buildAgentGraph([
      row({ path: 'manager.agentuse', subagents: ['w1.agentuse', 'w2.agentuse'] }),
      row({ path: 'w1.agentuse' }),
      row({ path: 'w2.agentuse' }),
    ]);
    const byPath = new Map(graph.nodes.map((n) => [n.path, n]));
    expect(byPath.get('manager.agentuse')!.rank).toBe(0);
    expect(byPath.get('manager.agentuse')!.entry).toBe(true);
    expect(byPath.get('w1.agentuse')!.rank).toBe(1);
    expect(byPath.get('w2.agentuse')!.order).not.toBe(byPath.get('w1.agentuse')!.order);
  });
});
