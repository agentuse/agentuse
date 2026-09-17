import { describe, expect, it } from 'bun:test';
import { activeDuration, activeTimingForTree, activeTimingsForForest, sessionTimingRow, transitionExecution, summarizeSessionTiming } from '../src/session/timing';
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
    time: { created: 1_000, updated: 11_000, execution: [{ start: 1_000, end: 3_000 }, { start: 6_000, end: 11_000 }] },
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
      running: false,
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
    expect(result.activeMs).toBe(7_000); // Approval union is independent of execution.
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
    const live = session({ status: 'suspended', time: { created: 1_000, updated: 7_000, execution: [{ start: 1_000, end: 7_000 }] } });
    const result = summarizeSessionTiming(live, [{ session: live, parts: [pending] }], 12_000);

    expect(result.wallMs).toBe(11_000);
    expect(result.approvalMs).toBe(5_000);
    expect(result.activeMs).toBe(6_000);
  });
});


describe('active execution clock', () => {
  it('excludes suspended and retry gaps and ignores metadata writes', () => {
    const root = session({ status: 'running', time: { created: 0, updated: 0, execution: [{ start: 100 }] } });
    transitionExecution(root, 'running', 200);
    transitionExecution(root, 'suspended', 300);
    root.status = 'suspended';
    transitionExecution(root, undefined, 500);
    transitionExecution(root, 'running', 1_000);
    root.status = 'running';
    transitionExecution(root, 'error', 1_200);
    root.status = 'error';
    transitionExecution(root, 'running', 5_000);
    root.status = 'running';
    const result = activeTimingForTree(root.id, [sessionTimingRow(root)], 5_100);
    expect(result.activeMs).toBe(500);
    expect(activeDuration(result, 5_200)).toBe(600);
    transitionExecution(root, 'completed', 5_300);
    root.status = 'completed';
    root.time.updated = 9_000;
    const finished = activeTimingForTree(root.id, [sessionTimingRow(root)], 10_000);
    expect(activeDuration(finished, 20_000)).toBe(700);
  });

  it('unions overlapping child execution while the parent is suspended', () => {
    const rows = [
      { sessionId: 'root', status: 'suspended', createdAt: 0, updatedAt: 100, execution: [{ start: 0, end: 100 }] },
      { sessionId: 'a', parentSessionId: 'root', status: 'completed', createdAt: 50, updatedAt: 400, execution: [{ start: 50, end: 400 }] },
      { sessionId: 'b', parentSessionId: 'root', status: 'running', createdAt: 300, updatedAt: 300, execution: [{ start: 300 }] },
      { sessionId: 'unrelated', status: 'running', createdAt: 0, updatedAt: 0 },
    ];
    const timing = activeTimingForTree('root', rows, 500);
    expect(timing.activeMs).toBe(500);
    expect(timing.running).toBe(true);
    expect(activeTimingsForForest(rows, 500).get('root')).toEqual(timing);
    rows[2]!.status = 'suspended';
    rows[2]!.updatedAt = 450;
    expect(activeTimingForTree('root', rows, 5_000).activeMs).toBe(450);
    expect(activeTimingForTree('root', rows, 5_000).running).toBe(false);
  });

  it('does not pass off historical wall time as active time', () => {
    const old = session({ time: { created: 0, updated: 10_000 } });
    expect(summarizeSessionTiming(old, [], 20_000).activeMs).toBeNull();
    expect(activeDuration(undefined)).toBeNull();
  });

  it('excludes preparation and tolerates cyclic parent links', () => {
    const rows = [
      { sessionId: 'root', parentSessionId: 'child', status: 'preparing', createdAt: 0, updatedAt: 0, execution: [] },
      { sessionId: 'child', parentSessionId: 'root', status: 'completed', createdAt: 0, updatedAt: 0, execution: [] },
    ];
    expect(activeTimingsForForest(rows, 1_000).get('root')?.activeMs).toBe(0);
  });
});
