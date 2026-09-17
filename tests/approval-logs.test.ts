import { describe, expect, it } from 'bun:test';
import { buildApprovalLogs, normalizeReviewEscalation } from '../src/worker/approval-logs';
import { completeApprovalValueDisplay } from '../src/utils/approval-value';

describe('buildApprovalLogs', () => {
  it('shows model usage once per step and preserves each tool result size', () => {
    const make = (id: string, stepId?: string) => ({
      id, type: 'tool', callID: id, tool: 'results',
      state: { status: 'completed', input: {}, output: 'é', metadata: {
        modelStepUsage: { input: 18347, output: 1066, cachedInput: 14720, sharedCalls: 2, ...(stepId && { stepId }) },
      } },
    });
    for (const explicit of [false, true]) {
      const logs = buildApprovalLogs([
        make('a', explicit ? 'step1' : undefined),
        make('b', explicit ? 'step1' : undefined),
        make('c', explicit ? 'step2' : undefined),
        make('d', explicit ? 'step2' : undefined),
      ]);
      expect(logs.map(row => Boolean(row.details?.tokenUsage))).toEqual([true, false, true, false]);
      expect(logs.map(row => row.details?.returnedBytes)).toEqual([2, 2, 2, 2]);
      expect(logs).toHaveLength(4);
    }
  });
  it('projects a strict-review escalation only from valid pending metadata', () => {
    const escalation = {
      kind: 'fresh-review-exhausted',
      critique: '  Tighten the claim.  ',
      attempts: 2,
      maxAttempts: 2,
    };
    const logs = buildApprovalLogs([{
      id: 'part-review-escalation',
      type: 'tool',
      callID: 'review-call',
      tool: 'await_human',
      state: {
        status: 'pending',
        input: { prompt: 'Automated review needs your revision guidance' },
        resumePayload: { kind: 'await_human', resumeToken: 'review-token', reviewEscalation: escalation },
      },
    }]);

    expect(logs[0]?.details?.reviewEscalation).toEqual({ ...escalation, critique: 'Tighten the claim.' });
    expect(normalizeReviewEscalation({ ...escalation, attempts: 0 })).toBeUndefined();
    expect(normalizeReviewEscalation({ ...escalation, attempts: 3 })).toBeUndefined();
    expect(normalizeReviewEscalation({ ...escalation, kind: 'unknown' })).toBeUndefined();
  });

  it('carries the parent Code Mode call id into Web log data', () => {
    const logs = buildApprovalLogs([{
      id: 'part-1',
      type: 'tool',
      callID: 'outer:nested:1',
      parentCallID: 'outer',
      tool: 'store_list',
      state: {
        status: 'completed',
        input: {},
        output: { items: [] },
        time: { start: 1, end: 2 },
      },
    }]);

    expect(logs[0]).toMatchObject({
      callId: 'outer:nested:1',
      parentCallId: 'outer',
      tool: 'store_list',
    });
  });

  for (const decision of [
    { approved: true, status: 'completed', reviewer: 'approver' },
    { approved: false, status: 'error', reviewer: 'rejector' },
  ] as const) {
    it(`projects the generic ${decision.approved ? 'approval' : 'rejection'} reviewer from durable metadata`, () => {
      const logs = buildApprovalLogs([{
        id: `part-${decision.reviewer}`,
        type: 'tool',
        callID: 'publish-call',
        tool: 'publish',
        state: {
          status: decision.status,
          input: { canonical: true },
          rawApprovedInput: { title: 'signed title' },
          metadata: {
            resumePayload: {
              kind: 'tool_approval',
              approvalId: 'approval-publish',
              toolCallId: 'publish-call',
              toolName: 'publish',
            },
            approvalResponse: {
              type: 'tool-approval-response',
              approvalId: 'approval-publish',
              approved: decision.approved,
              ...(!decision.approved && { reason: 'Declined by policy owner.' }),
            },
            approvalReviewer: { username: decision.reviewer },
          },
          ...(decision.status === 'completed'
            ? { output: false, time: { start: 1, end: 2 } }
            : { error: 'Declined by policy owner.', time: { start: 1, end: 2 } }),
        },
      }]);

      expect(logs[0]?.details).toMatchObject({
        prompt: 'Approve execution of publish?',
        decisionStatus: decision.approved ? 'approved' : 'rejected',
        decisionReviewer: decision.reviewer,
      });
    });
  }

  it('renders complete tagged approval values for supported special values and references', () => {
    const shared = { value: 7 };
    const backing = new Uint8Array([99, 1, 2, 255, 77]);
    const sparse: any[] = new Array(2);
    sparse.extra = 'security-relevant-array-property';
    const cyclic: any = {
      count: 9n,
      at: new Date('2026-09-12T00:00:00.000Z'),
      invalidAt: new Date(Number.NaN),
      map: new Map([[shared, new Set(['one', 'two'])]]),
      bytes: new Uint8Array(backing.buffer, 1, 3),
      dataView: new DataView(backing.buffer, 2, 2),
      sparse,
      shared,
    };
    cyclic.again = shared;
    cyclic.self = cyclic;

    const display = completeApprovalValueDisplay(cyclic);

    expect(display.text).toContain('"__type": "BigInt"');
    expect(display.text).toContain('"__type": "Date"');
    expect(display.text).toContain('"invalid": true');
    expect(display.text).toContain('"__type": "Map"');
    expect(display.text).toContain('"__type": "Set"');
    expect(display.text).toContain('"__type": "Uint8Array"');
    expect(display.text).toContain('"__type": "DataView"');
    expect(display.text).toContain('"byteOffset": 1');
    expect(display.text).toContain('"byteLength": 3');
    expect(display.text).toContain('"base64": "YwEC/00="');
    expect(display.text).toContain('"__type": "Hole"');
    expect(display.text).toContain('"properties"');
    expect(display.text).toContain('security-relevant-array-property');
    expect(display.text).toContain('"__type": "Reference"');
    expect(display.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('marks an earlier failed call recovered only after its declared recovery succeeds', () => {
    const logs = buildApprovalLogs([
      {
        id: 'part-failed',
        type: 'tool',
        callID: 'call-failed',
        tool: 'results',
        state: {
          status: 'error',
          input: { expression: '.missing' },
          error: 'Path not found',
          time: { start: 1, end: 2 },
        },
      },
      {
        id: 'part-recovery',
        type: 'tool',
        callID: 'call-recovery',
        tool: 'results',
        state: {
          status: 'completed',
          input: {
            intent: 'Narrowing the previous result query',
            recovers: 'call-failed',
            expression: '.output',
          },
          output: 'found',
          time: { start: 3, end: 4 },
        },
      },
    ]);

    expect(logs[0]?.details).toMatchObject({ recoveredByCallId: 'call-recovery' });
    expect(logs[1]?.details).toMatchObject({
      recoversCallId: 'call-failed',
      intent: 'Narrowing the previous result query',
      input: expect.stringContaining('.output'),
    });
    expect(String(logs[1]?.details?.input)).not.toContain('recovers');
  });

  it('infers an immediate corrected same-tool recovery when the model omits metadata', () => {
    const logs = buildApprovalLogs([
      {
        id: 'part-failed',
        type: 'tool',
        callID: 'call-failed',
        tool: 'results',
        state: {
          status: 'error',
          input: { action: 'jq', resultId: 'result-1', expression: 'fromjson' },
          error: 'only strings can be parsed',
          time: { start: 1, end: 2 },
        },
      },
      {
        id: 'part-recovery',
        type: 'tool',
        callID: 'call-recovery',
        tool: 'results',
        state: {
          status: 'completed',
          input: { action: 'jq', resultId: 'result-1', expression: '.output | fromjson' },
          output: { values: [] },
          time: { start: 3, end: 4 },
        },
      },
    ]);

    expect(logs[0]?.details).toMatchObject({
      recoveredByCallId: 'call-recovery',
      recoveryInferred: true,
    });
    expect(logs[1]?.details).toMatchObject({
      recoversCallId: 'call-failed',
      recoveryInferred: true,
    });
  });

  it('projects every failed attempt in an inferred cross-tool result recovery chain', () => {
    const resultId = 'result_01J00000000000000000000000_01J00000000000000000000001';
    const logs = buildApprovalLogs([
      {
        id: 'part-code-first', type: 'tool', callID: 'call-code-first', tool: 'code_exec',
        state: {
          status: 'error',
          input: { code: `return results.read(${JSON.stringify(resultId)}, { offset: 0 });` },
          error: 'Expected one argument', time: { start: 1, end: 2 },
        },
      },
      {
        id: 'part-direct', type: 'tool', callID: 'call-direct', tool: 'results',
        state: {
          status: 'error', input: { action: 'read', resultId, pattern: '.' },
          error: 'Invalid input', time: { start: 3, end: 4 },
        },
      },
      {
        id: 'part-code-final', type: 'tool', callID: 'call-code-final', tool: 'code_exec',
        state: {
          status: 'completed', input: { code: `return results.read(${JSON.stringify(resultId)});` },
          output: { status: 'completed' }, time: { start: 5, end: 6 },
        },
      },
    ]);

    expect(logs[0]?.details).toMatchObject({
      recoveredByCallId: 'call-code-final',
      recoveryInferred: true,
    });
    expect(logs[1]?.details).toMatchObject({
      recoversCallId: 'call-code-first',
      recoveredByCallId: 'call-code-final',
      recoveryInferred: true,
    });
    expect(logs[2]?.details).toMatchObject({
      recoversCallId: 'call-direct',
      recoveryInferred: true,
    });
  });

  it('keeps a valid failed recovery attempt visible without clearing the original failure', () => {
    const logs = buildApprovalLogs([
      {
        id: 'part-original', type: 'tool', callID: 'call-original', tool: 'results',
        state: { status: 'error', input: {}, error: 'First failure', time: { start: 1, end: 2 } },
      },
      {
        id: 'part-attempt', type: 'tool', callID: 'call-attempt', tool: 'results',
        state: {
          status: 'error',
          input: { recovers: 'call-original', expression: '.stillMissing' },
          error: 'Second failure',
          time: { start: 3, end: 4 },
        },
      },
    ]);

    expect(logs[0]?.details?.recoveredByCallId).toBeUndefined();
    expect(logs[1]?.details?.recoversCallId).toBe('call-original');
  });

  it('rejects recovery links to missing, later, or non-failed calls', () => {
    const logs = buildApprovalLogs([
      {
        id: 'missing-target', type: 'tool', callID: 'call-missing-attempt', tool: 'results',
        state: { status: 'completed', input: { recovers: 'does-not-exist' }, output: 'ok', time: { start: 1, end: 2 } },
      },
      {
        id: 'future-target-attempt', type: 'tool', callID: 'call-future-attempt', tool: 'results',
        state: { status: 'completed', input: { recovers: 'call-future-error' }, output: 'ok', time: { start: 3, end: 4 } },
      },
      {
        id: 'future-target', type: 'tool', callID: 'call-future-error', tool: 'results',
        state: { status: 'error', input: {}, error: 'Too late', time: { start: 5, end: 6 } },
      },
      {
        id: 'successful-target', type: 'tool', callID: 'call-success', tool: 'results',
        state: { status: 'completed', input: {}, output: 'ok', time: { start: 7, end: 8 } },
      },
      {
        id: 'successful-target-attempt', type: 'tool', callID: 'call-success-attempt', tool: 'results',
        state: { status: 'completed', input: { recovers: 'call-success' }, output: 'ok', time: { start: 9, end: 10 } },
      },
    ]);

    expect(logs[0]?.details?.recoversCallId).toBeUndefined();
    expect(logs[1]?.details?.recoversCallId).toBeUndefined();
    expect(logs[2]?.details?.recoveredByCallId).toBeUndefined();
    expect(logs[4]?.details?.recoversCallId).toBeUndefined();
  });
});
