import { describe, expect, it } from 'bun:test';
import { buildApprovalLogs } from '../src/worker/approval-logs';

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
});
