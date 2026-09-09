/**
 * The dashboard's entry points into the changeset flow.
 *
 * The create dialog and the revise action both call one seam rather than the
 * API client directly, so what they send can be checked without a DOM: the
 * calls below are exactly what those buttons run on submit.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const startChangeset = mock(async (projectId: string, input: unknown) => ({
  changeset: { sessionId: '01CHANGESET', projectId, ...(input as object) },
  sessionToken: 'tok',
}));

mock.module('../src/cli/serve/web/lib/api', () => ({ startChangeset }));

const {
  buildCreateInstruction,
  changesetCountLine,
  changesetEntries,
  startCreateChangeset,
  startReviseChangeset,
} = await import('../src/cli/serve/web/lib/changeset-entry');

beforeEach(() => { startChangeset.mockClear(); });

describe('starting a create changeset', () => {
  it('sends mode create with the objective as the instruction', async () => {
    await startCreateChangeset('support', { objective: '  Summarize new tickets  ' }, ' openai:gpt-5.6 ');
    expect(startChangeset).toHaveBeenCalledTimes(1);
    expect(startChangeset.mock.calls[0]).toEqual(['support', {
      mode: 'create',
      instruction: 'Summarize new tickets',
      model: 'openai:gpt-5.6',
    }]);
  });

  it('folds a discovery idea\'s name, schedule and evidence into the instruction', () => {
    expect(buildCreateInstruction({
      name: 'Ticket triage',
      description: 'Keeps the queue moving',
      schedule: '0 9 * * 1-5',
      evidence: 'src/tickets.ts, docs/sla.md',
      objective: 'Sort new tickets by urgency.',
    })).toBe([
      'Requested name: Ticket triage',
      'Description: Keeps the queue moving',
      'Requested schedule: 0 9 * * 1-5',
      'Evidence from this project: src/tickets.ts, docs/sla.md',
      '',
      'Sort new tickets by urgency.',
    ].join('\n'));
  });

  it('leaves a hand-written brief as just its objective', () => {
    expect(buildCreateInstruction({ objective: 'Watch the deploy log.' })).toBe('Watch the deploy log.');
  });
});

describe('starting a revise changeset', () => {
  it('sends mode revise with the target agent path', async () => {
    await startReviseChangeset({
      projectId: 'support',
      target: 'agents/triage.agentuse',
      instruction: ' exclude refunded orders ',
      model: 'openai:gpt-5.6',
    });
    expect(startChangeset.mock.calls[0]).toEqual(['support', {
      mode: 'revise',
      instruction: 'exclude refunded orders',
      model: 'openai:gpt-5.6',
      target: 'agents/triage.agentuse',
    }]);
  });

  it('carries the originating run when the revise started from one', async () => {
    await startReviseChangeset({
      projectId: 'support',
      target: 'agents/triage.agentuse',
      instruction: 'stop timing out',
      model: 'openai:gpt-5.6',
      originSessionId: '01ORIGIN',
    });
    expect((startChangeset.mock.calls[0] as [string, { originSessionId?: string }])[1].originSessionId).toBe('01ORIGIN');
  });

  it('omits the originating run when there is none', async () => {
    await startReviseChangeset({
      projectId: 'support',
      target: 'agents/triage.agentuse',
      instruction: 'stop timing out',
      model: 'openai:gpt-5.6',
      originSessionId: undefined,
    });
    expect((startChangeset.mock.calls[0] as [string, Record<string, unknown>])[1]).not.toHaveProperty('originSessionId');
  });
});

describe('changeset list rows', () => {
  const summary = (over: Record<string, unknown>) => ({
    version: 1,
    sessionId: '01A',
    projectId: 'support',
    projectRoot: '/p',
    scopeRoot: '/p',
    mode: 'revise',
    instruction: 'exclude refunded orders',
    authoringModel: 'openai:gpt-5.6',
    status: 'applied',
    createdAt: 1,
    updatedAt: 1,
    proposals: [],
    exchange: [],
    testRuns: [],
    ...over,
  }) as Parameters<typeof changesetEntries>[0][number];

  it('pulls anything still open above finished changesets, newest first', () => {
    const rows = changesetEntries([
      summary({ sessionId: '01OLD', status: 'applied', updatedAt: 10 }),
      summary({ sessionId: '01OPEN', status: 'proposed', updatedAt: 5 }),
      summary({ sessionId: '01NEW', status: 'discarded', updatedAt: 20 }),
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual(['01OPEN', '01NEW', '01OLD']);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.label).toBe('Changes ready to review');
    expect(rows[0]!.href).toBe('/projects/support/changesets/01OPEN');
  });

  it('prefers the latest proposal\'s reply over the instruction', () => {
    const [row] = changesetEntries([summary({
      status: 'proposed',
      proposals: [
        { index: 1, submittedAt: 1, reply: 'first pass', files: [{ path: 'a' }] },
        { index: 2, submittedAt: 2, reply: 'Skips refunds now', files: [{ path: 'a' }, { path: 'b' }] },
      ],
    })]);
    expect(row!.detail).toBe('Skips refunds now');
    expect(changesetCountLine(row!)).toBe('2 files · proposal 2');
  });

  it('says nothing about size before a proposal lands', () => {
    const [row] = changesetEntries([summary({ status: 'running' })]);
    expect(row!.detail).toBe('exclude refunded orders');
    expect(changesetCountLine(row!)).toBe('');
  });
});
