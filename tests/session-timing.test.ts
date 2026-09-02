import { describe, expect, it } from 'bun:test';
import { summarizeSessionTiming } from '../src/session/timing';
import type { Part, SessionInfo } from '../src/session/types';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'root',
    status: 'completed',
    trigger: 'manual',
    agent: { id: 'manager', name: 'Manager', isSubAgent: false },
    model: 'openai:test',
    version: 'test',
    config: {},
    project: { root: '/tmp/project', cwd: '/tmp/project' },
    time: { created: 1_000, updated: 11_000 },
    ...overrides,
  };
}

function gate(id: string, start: number, end: number): Part {
  return {
    id,
    sessionID: 'child',
    messageID: 'message',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'await_human',
    state: {
      status: 'completed',
      input: {},
      output: { status: 'approved' },
      metadata: { resumePayload: { kind: 'await_human' } },
      time: { start, end },
    },
  } as Part;
}

describe('summarizeSessionTiming', () => {
  it('reports approval wait separately from active execution', () => {
    const result = summarizeSessionTiming(session(), [
      { session: session(), parts: [gate('one', 3_000, 6_000)] },
    ], 20_000);

    expect(result).toEqual({
      calculatedAt: 20_000,
      wallMs: 10_000,
      activeMs: 7_000,
      approvalMs: 3_000,
      approvalCount: 1,
    });
  });

  it('unions overlapping descendant approvals and ignores superseded gates', () => {
    const superseded = { ...gate('old', 2_000, 9_000), superseded: true } as Part;
    const result = summarizeSessionTiming(session(), [
      { session: session(), parts: [gate('one', 3_000, 6_000)] },
      { session: session(), parts: [gate('two', 5_000, 8_000), superseded] },
    ], 20_000);

    expect(result.approvalMs).toBe(5_000);
    expect(result.activeMs).toBe(5_000);
    expect(result.approvalCount).toBe(2);
  });

  it('counts a pending gate through now for a live session', () => {
    const pending = {
      ...gate('pending', 0, 0),
      state: {
        status: 'pending',
        input: {},
        suspendedAt: 7_000,
        resumePayload: { kind: 'await_human', resumeToken: 'token' },
      },
    } as Part;
    const live = session({ status: 'suspended', time: { created: 1_000, updated: 7_000 } });
    const result = summarizeSessionTiming(live, [{ session: live, parts: [pending] }], 12_000);

    expect(result.wallMs).toBe(11_000);
    expect(result.approvalMs).toBe(5_000);
    expect(result.activeMs).toBe(6_000);
  });
});
