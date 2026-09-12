import { describe, expect, it } from 'bun:test';
import { buildApprovalLogs } from '../src/worker/approval-logs';
import { completeApprovalValueDisplay } from '../src/utils/approval-value';

describe('buildApprovalLogs', () => {
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
});
