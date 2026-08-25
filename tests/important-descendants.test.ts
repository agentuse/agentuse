import { describe, expect, it } from 'bun:test';
import { __testing } from '../src/cli/serve';
import { buildImportantDescendantEvents, buildImportantDescendants, type ImportantDescendantSummary } from '../src/session/important-descendants';
import type { SessionInfo, VerifyPart } from '../src/session/types';

function session(options: {
  id: string;
  parent?: string;
  name: string;
  agentId?: string;
  description?: string;
  status?: SessionInfo['status'];
  createdAt: number;
  error?: { code: string; message: string };
  observability?: SessionInfo['observability'];
}): SessionInfo {
  return {
    id: options.id,
    ...(options.parent && { parentSessionID: options.parent }),
    status: options.status ?? 'completed',
    trigger: 'manual',
    agent: {
      id: options.agentId ?? `agents/${options.name.toLowerCase().replaceAll(' ', '-')}`,
      name: options.name,
      ...(options.description && { description: options.description }),
      isSubAgent: Boolean(options.parent),
    },
    model: 'test:model',
    version: 'test',
    config: {},
    project: { root: '/project', cwd: '/project' },
    time: { created: options.createdAt, updated: options.createdAt + 5_000 },
    ...(options.error && { error: { ...options.error, time: options.createdAt + 5_000 } }),
    ...(options.observability && { observability: options.observability }),
  };
}

function childSummary(value: SessionInfo) {
  return {
    sessionId: value.id,
    agent: { id: value.agent.id, name: value.agent.name },
    status: value.status,
    trigger: value.trigger,
    createdAt: value.time.created,
    updatedAt: value.time.updated,
    ...(value.error && { errorCode: value.error.code, errorMessage: value.error.message }),
  };
}

function flatten(rows: Array<{ sessionId: string; children?: any[] }>): string[] {
  return rows.flatMap((row) => [row.sessionId, ...flatten(row.children ?? [])]);
}

function verifyPart(options: {
  id: string;
  sessionId: string;
  attempt: number;
  verdict: VerifyPart['verdict'];
  time: number;
  judge?: string;
  critique?: string;
}): VerifyPart {
  return {
    id: options.id,
    messageID: 'message',
    sessionID: options.sessionId,
    type: 'verify',
    verdict: options.verdict,
    attempt: options.attempt,
    maxRedos: 1,
    time: { start: options.time },
    ...(options.judge && { judge: options.judge }),
    ...(options.critique && { critique: options.critique }),
  };
}

function approvalPart(options: {
  id: string;
  sessionId: string;
  state: 'pending' | 'commented' | 'machine-comment';
  time: number;
  comment?: string;
}) {
  const input = { summary: 'Pick the revised newsletter direction' };
  const base = {
    id: options.id,
    messageID: 'message',
    sessionID: options.sessionId,
    type: 'tool',
    tool: 'await_human',
    callID: `call-${options.id}`,
  };
  if (options.state === 'pending') {
    return {
      ...base,
      state: { status: 'pending', input, suspendedAt: options.time },
    } as any;
  }
  return {
    ...base,
    state: {
      status: 'completed',
      input,
      output: options.state === 'machine-comment'
        ? { status: 'rejected', source: 'pre-review', comment: options.comment ?? 'Add sources', reviewer: { username: 'verify-judge' } }
        : { status: 'comment', comment: options.comment ?? 'Remove the news reference', reviewer: { username: 'web' } },
      time: { start: options.time - 500, end: options.time },
    },
  } as any;
}

describe('important descendant classification', () => {
  it('surfaces Manager → Pipeline → Judge under the real parent with breadcrumb context', () => {
    const manager = session({ id: 'manager', name: 'Newsletter Manager', createdAt: 1_000 });
    const pipeline = session({
      id: 'pipeline', parent: manager.id, name: 'Newsletter Pipeline',
      description: 'Mutation agent', createdAt: 2_000,
    });
    const judge = session({
      id: 'judge-1', parent: pipeline.id, name: 'Newsletter Pipeline Gate', createdAt: 3_000,
      observability: { role: 'verify-judge', attempt: 0, maxAttempts: 2 },
    });

    const rows = buildImportantDescendants(manager, [{ session: pipeline }, { session: judge }]);
    expect(rows.map((row) => row.sessionId)).toEqual(['pipeline', 'judge-1']);
    expect(rows[1]).toMatchObject({
      parentSessionId: 'pipeline',
      depth: 2,
      kinds: ['judge'],
      attemptLabel: 'Judge attempt 1 of 2',
      breadcrumb: [
        { sessionId: 'manager', agentName: 'Newsletter Manager' },
        { sessionId: 'pipeline', agentName: 'Newsletter Pipeline' },
      ],
    });
  });

  it('numbers multiple historical Judge attempts chronologically when metadata is absent', () => {
    const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
    const pipeline = session({ id: 'pipeline', parent: manager.id, name: 'Pipeline', createdAt: 2_000 });
    const second = session({ id: 'judge-b', parent: pipeline.id, name: 'Pipeline Gate', createdAt: 4_000 });
    const first = session({ id: 'judge-a', parent: pipeline.id, name: 'Pipeline Gate', createdAt: 3_000 });

    const rows = buildImportantDescendants(manager, [
      { session: pipeline }, { session: second }, { session: first },
    ]);
    expect(rows.find((row) => row.sessionId === 'judge-a')?.attemptLabel).toBe('Judge attempt 1');
    expect(rows.find((row) => row.sessionId === 'judge-b')?.attemptLabel).toBe('Judge attempt 2');
  });

  it('bubbles a nested Pipeline failure and makes the absence of any Judge explicit', () => {
    const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
    const coordinator = session({ id: 'coordinator', parent: manager.id, name: 'Coordinator', createdAt: 2_000 });
    const pipeline = session({
      id: 'pipeline', parent: coordinator.id, name: 'Newsletter Pipeline', createdAt: 3_000,
      status: 'error', error: { code: 'EXECUTION_ERROR', message: 'terminated' },
    });

    const rows = buildImportantDescendants(manager, [{ session: coordinator }, { session: pipeline }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sessionId: 'coordinator', important: false, kinds: ['context'] });
    expect(rows[1]).toMatchObject({
      sessionId: 'pipeline', parentSessionId: 'coordinator', important: true,
      kinds: ['failure', 'mutation'], label: 'Failed before Judge', errorMessage: 'terminated',
    });
  });

  it('surfaces approval gates and hides routine read-only descendants', () => {
    const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
    const reader = session({ id: 'reader', parent: manager.id, name: 'Research Reader', createdAt: 2_000 });
    const approval = session({ id: 'approval', parent: manager.id, name: 'Approval Worker', createdAt: 3_000 });
    const gatePart = approvalPart({ id: 'gate', sessionId: approval.id, state: 'pending', time: 3_100 });

    const rows = buildImportantDescendants(manager, [
      { session: reader, parts: [] },
      { session: approval, parts: [gatePart] },
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual(['approval']);
    expect(rows[0]).toMatchObject({
      kinds: ['approval'],
      phase: 'awaiting-approval',
      gateLabel: 'Pick the revised newsletter direction',
    });
  });

  it('shows a running child as revising after human feedback without reusing the completed gate prompt', () => {
    const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
    const pipeline = session({
      id: 'pipeline', parent: manager.id, name: 'Newsletter Pipeline', createdAt: 2_000, status: 'running',
    });
    const human = approvalPart({
      id: 'gate-human', sessionId: pipeline.id, state: 'commented', time: 4_000,
      comment: 'Use the Midlife ICP without a news reference',
    });
    const machine = approvalPart({
      id: 'gate-machine', sessionId: pipeline.id, state: 'machine-comment', time: 3_000,
    });

    const evidence = [{ session: pipeline, parts: [machine, human] }];
    expect(buildImportantDescendants(manager, evidence)[0]).toMatchObject({
      phase: 'revising',
      label: 'Revising after reviewer feedback',
    });
    expect(buildImportantDescendants(manager, evidence)[0]?.gateLabel).toBeUndefined();
    expect(buildImportantDescendantEvents(manager, evidence)).toMatchObject([{
      type: 'reviewer-feedback',
      sourceLogId: 'gate-human',
      reviewer: 'web',
      comment: 'Use the Midlife ICP without a news reference',
      roundLabel: 'Revision request 1',
      time: 4_000,
    }]);
  });

  it('labels the next pending gate as revised approval and retains the feedback event', () => {
    const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
    const pipeline = session({
      id: 'pipeline', parent: manager.id, name: 'Newsletter Pipeline', createdAt: 2_000, status: 'suspended',
    });
    const human = approvalPart({ id: 'gate-human', sessionId: pipeline.id, state: 'commented', time: 3_000 });
    const pending = approvalPart({ id: 'gate-revised', sessionId: pipeline.id, state: 'pending', time: 4_000 });

    const evidence = [{ session: pipeline, parts: [human, pending] }];
    expect(buildImportantDescendants(manager, evidence)[0]).toMatchObject({
      phase: 'awaiting-approval',
      label: 'Revised approval · Pick the revised newsletter direction',
    });
    expect(buildImportantDescendantEvents(manager, evidence)).toHaveLength(1);
  });

  it('projects multiple inline criteria attempts as events owned by Pipeline', () => {
    const manager = session({ id: 'manager', name: 'Newsletter Manager', createdAt: 1_000 });
    const pipeline = session({ id: 'pipeline', parent: manager.id, name: 'Newsletter Pipeline', createdAt: 2_000 });
    const parts = [
      verifyPart({ id: 'verify-1', sessionId: pipeline.id, attempt: 0, verdict: 'fail', time: 3_000, judge: 'openai:gpt-5', critique: 'Add sources' }),
      verifyPart({ id: 'verify-2', sessionId: pipeline.id, attempt: 1, verdict: 'pass', time: 4_000, judge: 'openai:gpt-5' }),
    ];

    const evidence = [{ session: pipeline, parts }];
    expect(buildImportantDescendants(manager, evidence)[0]?.kinds).toContain('verification');
    expect(buildImportantDescendantEvents(manager, evidence)).toMatchObject([
      {
        sourceLogId: 'verify-1', ownerSessionId: 'pipeline', mode: 'inline', verdict: 'fail',
        attemptLabel: 'Attempt 1 of 2',
        breadcrumb: [
          { sessionId: 'manager', agentName: 'Newsletter Manager' },
          { sessionId: 'pipeline', agentName: 'Newsletter Pipeline' },
        ],
      },
      { sourceLogId: 'verify-2', ownerSessionId: 'pipeline', mode: 'inline', verdict: 'pass', attemptLabel: 'Attempt 2 of 2' },
    ]);
  });

  it('does not create an event row when the verify attempt has a real Judge child session', () => {
    const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
    const pipeline = session({ id: 'pipeline', parent: manager.id, name: 'Pipeline', createdAt: 2_000 });
    const judge = session({
      id: 'judge', parent: pipeline.id, name: 'Pipeline Gate', createdAt: 3_000,
      observability: { role: 'verify-judge', attempt: 0, maxAttempts: 2 },
    });
    const marker = verifyPart({
      id: 'verify-1', sessionId: pipeline.id, attempt: 0, verdict: 'pass', time: 3_500,
      judge: '.agentuse/pipeline-gate.agentuse',
    });

    expect(buildImportantDescendantEvents(manager, [
      { session: pipeline, parts: [marker] }, { session: judge, parts: [] },
    ])).toEqual([]);
  });
});

describe('important descendant log tree', () => {
  const manager = session({ id: 'manager', name: 'Manager', createdAt: 1_000 });
  const pipeline = session({ id: 'pipeline', parent: manager.id, name: 'Pipeline', createdAt: 2_000 });
  const judge1 = session({ id: 'judge-1', parent: pipeline.id, name: 'Pipeline Gate', createdAt: 3_000 });
  const judge2 = session({ id: 'judge-2', parent: pipeline.id, name: 'Pipeline Gate', createdAt: 4_000 });

  it('nests multiple Judge rows once each beneath the existing direct-child row', () => {
    const important = buildImportantDescendants(manager, [
      { session: pipeline }, { session: judge1 }, { session: judge2 },
    ]);
    const logs = __testing.logsWithChildSessions(
      [{ id: 'call', type: 'tool', tool: 'subagent__pipeline', title: 'Pipeline', time: 2_000 }],
      [childSummary(pipeline)],
      (id: string) => `/sessions/${id}`,
      important,
      { sessionId: manager.id, agentName: manager.agent.name }
    );
    const tree = logs[0]?.subagentSession;
    expect(tree?.sessionId).toBe('pipeline');
    expect(tree?.children?.map((child: any) => child.sessionId)).toEqual(['judge-1', 'judge-2']);
    expect(flatten(tree ? [tree] : [])).toEqual(['pipeline', 'judge-1', 'judge-2']);
    expect(new Set(flatten(tree ? [tree] : [])).size).toBe(3);
    expect(tree?.href).toBe('/sessions/pipeline');
    expect(tree?.children?.[0]?.href).toBe('/sessions/judge-1');
  });

  it('preserves existing direct-child rendering when no descendant projection is present', () => {
    const logs = __testing.logsWithChildSessions(
      [{ id: 'call', type: 'tool', tool: 'subagent__pipeline', title: 'Pipeline', time: 2_000 }],
      [childSummary(pipeline)],
      (id: string) => `/sessions/${id}`,
      [],
      { sessionId: manager.id, agentName: manager.agent.name }
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.subagentSession).toMatchObject({
      sessionId: 'pipeline', href: '/sessions/pipeline',
      breadcrumb: [{ sessionId: 'manager', agentName: 'Manager' }],
    });
    expect(logs[0]?.subagentSession?.children).toBeUndefined();
  });

  it('attaches inline verification to its real owner without adding a session row', () => {
    const marker = verifyPart({
      id: 'verify-inline', sessionId: pipeline.id, attempt: 0, verdict: 'fail', time: 3_000,
      judge: 'openai:gpt-5', critique: 'Missing citation',
    });
    const evidence = [{ session: pipeline, parts: [marker] }];
    const logs = __testing.logsWithChildSessions(
      [{ id: 'call', type: 'tool', tool: 'subagent__pipeline', title: 'Pipeline', time: 2_000 }],
      [childSummary(pipeline)],
      (id: string) => `/sessions/${id}`,
      buildImportantDescendants(manager, evidence),
      { sessionId: manager.id, agentName: manager.agent.name },
      buildImportantDescendantEvents(manager, evidence)
    );
    const tree = logs[0]?.subagentSession;
    expect(flatten(tree ? [tree] : [])).toEqual(['pipeline']);
    expect(tree?.events).toMatchObject([{
      ownerSessionId: 'pipeline', displayStatus: 'failed', href: '/sessions/pipeline#log-verify-inline',
    }]);
  });
});
