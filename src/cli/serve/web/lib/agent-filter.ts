import type { AgentRow } from './api';

/**
 * The agents page's search predicate, shared by every view (tree, cards,
 * graph). One definition matters: the graph decides which clusters to keep by
 * this rule while the page decides which projects to render by the same one, so
 * a weaker copy in either place would leave a project section holding nothing.
 */

/** Flatten metadata scalars into a search string (keys always, scalar values too). */
export function metadataText(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  return Object.entries(metadata)
    .map(([k, v]) => (v == null || typeof v === 'object' ? k : `${k} ${v}`))
    .join(' ');
}

/**
 * Case-insensitive substring match across the fields a user is likely to type.
 * `query` is expected pre-trimmed and lowercased; every whitespace-separated
 * term must hit.
 */
export function matchesAgentFilter(agent: AgentRow | undefined, query: string): boolean {
  if (!query) return true;
  if (!agent) return false; // ghost node: nothing to match against
  const haystack = `${agent.name} ${agent.path} ${agent.description ?? ''} ${agent.projectId} ${agent.model} ${agent.schedule ?? ''} ${metadataText(agent.metadata)}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}
