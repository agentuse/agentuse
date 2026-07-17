import { describe, expect, it } from 'bun:test';
import { compareSessionsForList } from '../src/cli/sessions';

const M = 60_000;
const mk = (o: { id: string; status: string; created: number; updated?: number; subagentActive?: boolean }): any => ({
  id: o.id, agentId: 'a', agentName: 'a', model: 'm',
  created: new Date(o.created),
  updated: new Date(o.updated ?? o.created),
  isSubAgent: false, dirPath: '', projectRoot: '',
  status: o.status,
  ...(o.subagentActive && { subagentActive: true }),
});

describe('compareSessionsForList', () => {
  it('pins a live run above finished runs even when it is the oldest', () => {
    const live = mk({ id: 'live', status: 'suspended', subagentActive: true, created: -60 * M }); // oldest
    const doneRecent = mk({ id: 'doneRecent', status: 'completed', created: -10 * M, updated: -5 * M });
    expect([doneRecent, live].sort(compareSessionsForList).map((r) => r.id)).toEqual(['live', 'doneRecent']);
  });

  it('orders non-live runs by most-recent activity (updatedAt), not created', () => {
    const a = mk({ id: 'a', status: 'completed', created: -10 * M, updated: -5 * M });  // freshest activity
    const b = mk({ id: 'b', status: 'completed', created: -40 * M, updated: -40 * M });
    const c = mk({ id: 'c', status: 'suspended', created: -50 * M, updated: -50 * M }); // oldest activity
    expect([c, b, a].sort(compareSessionsForList).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a plain running session as live', () => {
    const running = mk({ id: 'run', status: 'running', created: -100 * M });
    const done = mk({ id: 'done', status: 'completed', created: -1 * M });
    expect([done, running].sort(compareSessionsForList).map((r) => r.id)).toEqual(['run', 'done']);
  });
});
