import { describe, it, expect } from 'bun:test';
import {
  composeFinalOutput,
  composeSubagentResult,
  createReportOutcomeTool,
  formatOutcomeLine,
  readOutcomeCall,
  stripLeadingOutcomeLine,
  type RunOutcome,
} from '../src/tools/report-outcome';
import { runResultJson } from '../src/runner/outcome';
import { loadStoredSubagentResult } from '../src/runner/subagent-cascade';
import { buildDescendantReport } from '../src/session/important-descendants';
import { collectRunOutcomes, subagentResultFromState } from '../src/worker/approval-logs';
import { reportFromSubagentResult } from '../src/cli/serve/session-log';

const execute = (outcome: RunOutcome, input: unknown, options?: Parameters<typeof createReportOutcomeTool>[1]) =>
  (createReportOutcomeTool(outcome, options) as any).execute(input);

describe('report_outcome tool', () => {
  it('records a complete verdict and keeps an empty artifact list', async () => {
    const outcome: RunOutcome = {};
    const reply = await execute(outcome, { status: 'complete', headline: 'Answered the question', artifacts: [] });

    expect(reply).toContain('Recorded and delivered');
    expect(outcome).toEqual({ complete: { headline: 'Answered the question', artifacts: [] } });
  });

  it('records idle as a successful completion marked idle', async () => {
    const outcome: RunOutcome = {};
    await execute(outcome, { status: 'idle', headline: 'No PRs due for release', artifacts: [] });

    expect(outcome).toEqual({ complete: { headline: 'No PRs due for release', artifacts: [], idle: true } });
  });

  it('keeps bookkeeping context on idle without declaring it delivered work', async () => {
    const outcome: RunOutcome = {};
    await execute(outcome, {
      status: 'idle', headline: 'No eligible notifications after checking both inboxes',
      details: 'Watermarks advanced; audit: [scan log](./scan-log.json).', artifacts: [],
    });
    expect(outcome.complete?.idle).toBe(true);
    expect(outcome.complete?.artifacts).toEqual([]);
    expect(composeFinalOutput(outcome.complete, '')).toBe(
      '💤 Idle: No eligible notifications after checking both inboxes\n\nWatermarks advanced; audit: [scan log](./scan-log.json).'
    );
  });

  it('refuses idle with artifacts and records nothing', async () => {
    const outcome: RunOutcome = {};
    await expect(execute(outcome, { status: 'idle', headline: 'Nothing to do', artifacts: ['pr/12'] }))
      .rejects.toThrow('status "idle" means this run delivered no substantive output');
    expect(outcome).toEqual({});
  });

  it('records incomplete from the headline without touching a prior complete', async () => {
    const outcome: RunOutcome = { complete: { headline: 'Looked done' } };
    const reply = await execute(outcome, {
      status: 'incomplete', headline: 'PR #119 blocked on failing CI; fix the build', artifacts: [], rejectionOnly: false,
    });

    expect(reply).toContain('will end marked incomplete');
    expect(outcome.incomplete).toEqual({ reason: 'PR #119 blocked on failing CI; fix the build', rejectionOnly: false });
    expect(outcome.complete).toEqual({ headline: 'Looked done' });
  });

  it('guards complete and idle behind a required submission, but never incomplete', async () => {
    const outcome: RunOutcome = {};
    const assertDeliverable = () => { throw new Error('Call submit_changes first'); };

    await expect(execute(outcome, { status: 'complete', headline: 'Done', artifacts: [] }, { assertDeliverable }))
      .rejects.toThrow('Call submit_changes first');
    await expect(execute(outcome, { status: 'idle', headline: 'Nothing', artifacts: [] }, { assertDeliverable }))
      .rejects.toThrow('Call submit_changes first');
    await execute(outcome, { status: 'incomplete', headline: 'Blocked', artifacts: [] }, { assertDeliverable });
    expect(outcome).toEqual({ incomplete: { reason: 'Blocked' } });
  });

  it('requires the artifact list in its schema', () => {
    const schema = (createReportOutcomeTool({}) as any).inputSchema;
    expect(schema.safeParse({ status: 'complete', headline: 'Done' }).success).toBe(false);
    expect(schema.safeParse({ status: 'complete', headline: 'Done', artifacts: [] }).success).toBe(true);
    expect(schema.safeParse({ status: 'skipped', headline: 'Done', artifacts: [] }).success).toBe(false);
  });
});

describe('readOutcomeCall', () => {
  it('reads each report_outcome status', () => {
    expect(readOutcomeCall('report_outcome', { status: 'idle', headline: 'Nothing due', artifacts: [] }))
      .toEqual({ status: 'idle', headline: 'Nothing due', artifacts: [] });
    expect(readOutcomeCall('report_outcome', { status: 'incomplete', headline: 'Blocked', artifacts: [], rejectionOnly: true }))
      .toEqual({ status: 'incomplete', headline: 'Blocked', artifacts: [], rejectionOnly: true });
  });

  it('reads a legacy report_complete as complete, never idle, even with an empty list', () => {
    expect(readOutcomeCall('report_complete', { headline: 'Swept, nothing to act on', artifacts: [] }))
      .toEqual({ status: 'complete', headline: 'Swept, nothing to act on' });
    expect(readOutcomeCall('report_complete', { headline: 'Shipped', details: 'Body', artifacts: ['pr/1'] }))
      .toEqual({ status: 'complete', headline: 'Shipped', details: 'Body', artifacts: ['pr/1'] });
  });

  it('reads a legacy report_incomplete reason as the headline', () => {
    expect(readOutcomeCall('report_incomplete', { reason: 'Login expired', rejectionOnly: false }))
      .toEqual({ status: 'incomplete', headline: 'Login expired', rejectionOnly: false });
  });

  it('ignores other tools and malformed calls', () => {
    expect(readOutcomeCall('tools__bash', { headline: 'x' })).toBeUndefined();
    expect(readOutcomeCall('report_outcome', { status: 'done', headline: 'x' })).toBeUndefined();
    expect(readOutcomeCall('report_outcome', { status: 'complete' })).toBeUndefined();
    expect(readOutcomeCall('report_incomplete', { headline: 'x' })).toBeUndefined();
    expect(readOutcomeCall('report_outcome', undefined)).toBeUndefined();
  });
});

describe('idle on every surface', () => {
  it('leads the run output and terminal line with the idle opener', () => {
    expect(formatOutcomeLine('report_outcome', { status: 'idle', headline: 'Nothing due', artifacts: [] }))
      .toBe('💤 Idle: Nothing due');
    expect(composeFinalOutput({ headline: 'Nothing due', idle: true }, '')).toBe('💤 Idle: Nothing due');
    expect(stripLeadingOutcomeLine('💤 Idle: Nothing due\n\nChecked 4 queues.', 'Nothing due')).toBe('Checked 4 queues.');
  });

  it('flags idle in run JSON and keeps the empty artifact list', () => {
    const json = runResultJson({
      text: '', status: 'completed', complete: { headline: 'Nothing due', artifacts: [], idle: true },
    } as any, 10);
    expect(json.success).toBe(true);
    expect(json.status).toBe('completed');
    expect(json.result).toMatchObject({ headline: 'Nothing due', artifacts: [], idle: true });
  });

  it('hands a parent the idle flag, which the session view carries onto the child row', () => {
    const result = composeSubagentResult({ agent: 'leaf', outcome: { complete: { headline: 'Nothing due', artifacts: [], idle: true } } });
    expect(result.metadata).toEqual({ agent: 'leaf', headline: 'Nothing due', artifacts: [], idle: true });

    const row = subagentResultFromState({ output: result }, 'subagent__leaf');
    expect(row).toMatchObject({ headline: 'Nothing due', idle: true });
    expect(reportFromSubagentResult(row)?.status).toBe('idle');
  });
});

const toolPart = (id: string, tool: string, input: unknown, start: number) => ({
  id, type: 'tool', tool, state: { status: 'completed', input, time: { start, end: start + 1 } },
});

describe('stored sessions read the same before and after report_outcome', () => {
  it('renders legacy and new outcome rows with matching kinds', () => {
    const { outcomeByPartId } = collectRunOutcomes([
      toolPart('a', 'report_complete', { headline: 'Posted 3' }, 1),
      toolPart('b', 'report_incomplete', { reason: 'Login expired' }, 2),
      toolPart('c', 'report_outcome', { status: 'idle', headline: 'Nothing due', artifacts: [] }, 3),
      toolPart('d', 'report_outcome', { status: 'complete', headline: 'Posted 4', artifacts: ['x.md'] }, 4),
    ]);
    expect(outcomeByPartId.get('a')).toEqual({ kind: 'complete', headline: 'Posted 3' });
    expect(outcomeByPartId.get('b')).toEqual({ kind: 'incomplete', headline: 'Login expired' });
    expect(outcomeByPartId.get('c')).toEqual({ kind: 'idle', headline: 'Nothing due' });
    expect(outcomeByPartId.get('d')).toEqual({ kind: 'complete', headline: 'Posted 4', artifacts: ['x.md'] });
  });

  it('builds a descendant report from either tool, with blockers still winning across a resume', () => {
    expect(buildDescendantReport([
      toolPart('a', 'report_outcome', { status: 'idle', headline: 'Nothing due', artifacts: [] }, 1),
    ] as any)).toEqual({ status: 'idle', headline: 'Nothing due' });
    // A run paused before the change called the legacy tool; after resume it
    // declared a blocker with the new one.
    expect(buildDescendantReport([
      toolPart('a', 'report_complete', { headline: 'Looked complete' }, 1),
      toolPart('b', 'report_outcome', { status: 'incomplete', headline: 'CI failing on PR #120', artifacts: [] }, 2),
    ] as any)).toEqual({ status: 'incomplete', headline: 'CI failing on PR #120' });
  });

  it('recovers an orphaned child from either tool', async () => {
    const reader = (parts: unknown[]) => ({
      getSessionMessages: async () => [{ id: 'message' }],
      getMessageParts: async () => parts,
      getLastAssistantText: async () => '',
    }) as any;

    expect(await loadStoredSubagentResult(reader([
      toolPart('a', 'report_complete', { headline: 'Shipped', artifacts: [] }, 1),
    ]), 's', 'a')).toEqual({ text: '', complete: { headline: 'Shipped' } });
    expect(await loadStoredSubagentResult(reader([
      toolPart('a', 'report_outcome', { status: 'idle', headline: 'Nothing due', artifacts: [] }, 1),
    ]), 's', 'a')).toEqual({ text: '', complete: { headline: 'Nothing due', artifacts: [], idle: true } });
    expect(await loadStoredSubagentResult(reader([
      toolPart('a', 'report_outcome', { status: 'incomplete', headline: 'Blocked', artifacts: [], rejectionOnly: true }, 1),
    ]), 's', 'a')).toEqual({ text: '', incomplete: { reason: 'Blocked', rejectionOnly: true } });
  });
});
