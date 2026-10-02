import { describe, expect, it } from 'bun:test';
import { findThreadApproval } from '../src/cli/serve/slack-thread-lookup';
import type { ApprovalSummary } from '../src/cli/serve/list-payloads';

const approval = (sessionId: string, ts: string) => ({
  sessionId,
  channelMessage: { type: 'slack-message', channel: 'C1', ts },
}) as unknown as ApprovalSummary;

const ok = (approvals: ApprovalSummary[]) => ({
  listApprovals: async () => ({ success: true as const, approvals }),
});
const failing = (message: string) => ({
  listApprovals: async () => ({ success: false as const, error: { message } }),
});
const project = (id: string) => ({ id, root: `/projects/${id}` });
const inThread = (ts: string) => (item: ApprovalSummary) => item.channelMessage?.ts === ts;

describe('findThreadApproval', () => {
  it('returns the match from whichever project has it', async () => {
    const found = await findThreadApproval([
      { project: project('a'), worker: ok([approval('s-a', '1.0')]) },
      { project: project('b'), worker: ok([approval('s-b', '2.0')]) },
    ], inThread('2.0'), 'thread');
    expect(found?.project.id).toBe('b');
    expect(found?.approval.sessionId).toBe('s-b');
  });

  it('reports no match only when every project was checked', async () => {
    const found = await findThreadApproval([
      { project: project('a'), worker: ok([]) },
      { project: project('b'), worker: ok([approval('s-b', '2.0')]) },
    ], inThread('9.9'), 'thread');
    expect(found).toBeUndefined();
  });

  it('throws instead of dropping the reply when a project lookup failed', async () => {
    await expect(findThreadApproval([
      { project: project('a'), worker: failing('WORKER_NOT_READY') },
      { project: project('b'), worker: ok([]) },
    ], inThread('2.0'), 'Slack thread C1/2.0')).rejects.toThrow('a: WORKER_NOT_READY');
  });

  it('throws when a project has no worker to ask', async () => {
    await expect(findThreadApproval([
      { project: project('a'), worker: undefined },
    ], inThread('2.0'), 'thread')).rejects.toThrow('a: worker not available');
  });

  it('still uses a match from a reachable project when another lookup failed', async () => {
    const found = await findThreadApproval([
      { project: project('a'), worker: failing('down') },
      { project: project('b'), worker: ok([approval('s-b', '2.0')]) },
    ], inThread('2.0'), 'thread');
    expect(found?.approval.sessionId).toBe('s-b');
  });
});
