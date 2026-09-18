import { describe, expect, it } from 'bun:test';
import {
  approvalWasRolledBackAfterResume,
  buildApprovalLogs,
  formatGenericToolApprovalValue,
  groupParallelToolCalls,
  logsWithRecoveredApprovalDecision,
  logsWithSessionError,
  normalizeApprovalChanges,
  normalizeApprovalOptions,
  normalizeApprovalReference,
  normalizeReviewEscalation,
  normalizeToolOutputArtifact,
  toolOutputArtifactFromState,
} from '../src/worker/approval-logs';
import { completeApprovalValueDisplay } from '../src/utils/approval-value';

describe('buildApprovalLogs', () => {
  it('measures context growth once across parallel calls, including cached input', () => {
    const make = (id: string, stepId: string, input: number, sharedCalls: number, cachedInput = 0) => ({
      id, type: 'tool', callID: id, tool: 'results',
      state: { status: 'completed', input: {}, output: 'text', metadata: {
        modelStepUsage: { stepId, input, output: 1066, cachedInput, sharedCalls },
      } },
    });
    const logs = buildApprovalLogs([
      make('a', 'first', 18347, 2, 14720), make('b', 'first', 18347, 2, 14720),
      make('c', 'next', 47715, 1), make('d', 'smaller', 20000, 1),
    ]);
    expect(logs[0]?.details?.contextAddedTokens).toBeUndefined();
    expect(logs.find(row => row.id === 'b')?.details?.contextAddedTokens).toBeUndefined();
    expect(logs.find(row => row.id === 'c')?.details?.contextAddedTokens).toBe(29368);
    expect(logs.find(row => row.id === 'd')?.details?.contextAddedTokens).toBe(-27715);
  });
  it('keeps incomplete groups, single calls, and pending approvals flat', () => {
    const row = { id: 'a', callId: 'a', type: 'tool', tool: 'results', title: 'Read', status: 'completed',
      details: { modelStepId: 's', tokenUsage: { input: 100, output: 10, cachedInput: 0, sharedCalls: 2 } } };
    expect(groupParallelToolCalls([row])).toEqual([row]);
    const gate = { ...row, id: 'b', callId: 'b', tool: 'await_human', status: 'pending' };
    expect(groupParallelToolCalls([row, gate])).toEqual([row, gate]);
  });

  it('preserves nested Code Mode children when grouping their parent calls', () => {
    const usage = { input: 100, output: 10, cachedInput: 0, sharedCalls: 2 };
    const rows = [
      { id: 'a', callId: 'a', type: 'tool', tool: 'code_exec', title: 'Program', status: 'completed', details: { modelStepId: 's', tokenUsage: usage, returnedBytes: 100 } },
      { id: 'nested', callId: 'nested', parentCallId: 'a', type: 'tool', tool: 'bash', title: 'Child', status: 'completed', details: { returnedBytes: 999 } },
      { id: 'b', callId: 'b', type: 'tool', tool: 'results', title: 'Read', status: 'error', details: { modelStepId: 's', returnedBytes: 20 } },
    ];
    const grouped = groupParallelToolCalls(rows);
    expect(grouped[0]?.status).toBe('error');
    expect(grouped.find(row => row.id === 'nested')?.parentCallId).toBe('a');
    expect(grouped.find(row => row.id === 'a')?.parentCallId).toBe('model-step:s');
    expect(grouped[0]?.details?.returnedBytes).toBe(120);
    const missing = rows.map(row => row.id === 'b' ? { ...row, details: { modelStepId: 's' } } : row);
    expect(groupParallelToolCalls(missing)[0]?.details?.returnedBytes).toBeUndefined();
  });
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
      const parents = logs.filter(row => row.title === 'Parallel tool calls');
      const children = logs.filter(row => row.parentCallId);
      expect(parents).toHaveLength(2);
      expect(parents.every(row => row.details?.tokenUsage?.input === 18347)).toBe(true);
      expect(parents.map(row => row.details?.returnedBytes)).toEqual([4, 4]);
      expect(children.every(row => !row.details?.tokenUsage)).toBe(true);
      expect(children.map(row => row.details?.returnedBytes)).toEqual([2, 2, 2, 2]);
      expect(logs).toHaveLength(6);
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

it('keeps metadata in session log projections without duplicate tool-step rows', () => {
  const metadata = { responseId: 'resp_1', cacheWriteTokens: 0 };
  const usage = { stepId: 'call-1', input: 100, output: 2, cachedInput: 30, sharedCalls: 1, responseMetadata: metadata };
  const logs = buildApprovalLogs([
    { id: 'tool', type: 'tool', tool: 'read', callID: 'call-1', state: { status: 'completed', output: 'ok', metadata: { modelStepUsage: usage } } },
    { id: 'step-1', type: 'step-finish', modelStepUsage: usage },
    { id: 'step-2', type: 'step-finish', modelStepUsage: { ...usage, stepId: undefined, sharedCalls: 0,
      responseMetadata: { responseId: 'resp_2' } } },
  ]);
  expect(logs).toHaveLength(2);
  expect(logs[0]?.details?.responseMetadata).toEqual(metadata);
  expect(logs[1]?.details?.responseMetadata).toEqual({ responseId: 'resp_2' });
});

describe('approval log recovery and normalization', () => {
  it('normalizes review changes while dropping empty content and unsafe media URLs', () => {
    expect(normalizeApprovalChanges([
      {
        label: '  Announcement  ',
        content: 'Ship it',
        displayContent: [' Summary ', '', ' Details '],
        media_urls: ['https://example.com/a.png', 'javascript:alert(1)', 'https://example.com/a.png'],
        optionId: ' approve ',
      },
      { label: 'ignored', content: '   ' },
    ])).toEqual([{
      label: 'Announcement',
      content: 'Ship it',
      displayContent: 'Summary\n\nDetails',
      displayParts: ['Summary', 'Details'],
      mediaUrls: ['https://example.com/a.png'],
      optionId: 'approve',
    }]);
    expect(normalizeApprovalChanges({ content: 'not an array' })).toBeUndefined();
  });

  it('requires two unique, well-formed approval choices', () => {
    expect(normalizeApprovalOptions([
      { id: 'ship', label: ' Ship ', recommended: true },
      { id: 'ship', label: 'Duplicate' },
      { id: 'revise', label: 'Revise', description: '  Request changes  ' },
      { id: '', label: 'Invalid' },
    ])).toEqual([
      { id: 'ship', label: 'Ship', recommended: true },
      { id: 'revise', label: 'Revise', description: 'Request changes' },
    ]);
    expect(normalizeApprovalOptions([{ id: 'only', label: 'Only choice' }])).toBeUndefined();
  });

  it('keeps reference text but rejects non-HTTP URLs', () => {
    expect(normalizeApprovalReference({
      label: ' Source ',
      title: 'Launch notes',
      url: 'file:///private/secret',
    })).toEqual({ label: 'Source', title: 'Launch notes' });
    expect(normalizeApprovalReference({ url: 'https://example.com/notes' })).toEqual({
      url: 'https://example.com/notes',
    });
    expect(normalizeApprovalReference(null)).toBeUndefined();
  });

  it('normalizes tool artifacts from metadata before falling back to output text', () => {
    expect(normalizeToolOutputArtifact({
      kind: 'tool-output', path: ' logs/full.txt ', bytes: 42, originalChars: 100,
    })).toEqual({ path: 'logs/full.txt', bytes: 42, originalChars: 100 });
    expect(normalizeToolOutputArtifact({ kind: 'other', path: 'ignored' })).toBeUndefined();

    expect(toolOutputArtifactFromState({
      metadata: { fullOutputArtifact: { kind: 'tool-output', path: 'preferred.json', bytes: 9 } },
      output: 'full tool output saved to session artifact: fallback.txt (12 bytes)',
    })).toEqual({ path: 'preferred.json', bytes: 9 });
    expect(toolOutputArtifactFromState({
      output: 'Full output saved to session artifact: nested/output.log (512 bytes)',
    })).toEqual({ path: 'nested/output.log', bytes: 512 });
  });

  it('recovers a rolled-back approval decision without leaking its resume token', () => {
    const approvalPart = {
      id: 'gate-1',
      type: 'tool',
      state: { status: 'pending', suspendedAt: 100 },
    };
    const session = { error: { code: 'FAILED', message: 'Resume failed' } } as any;
    expect(approvalWasRolledBackAfterResume(session, approvalPart, [
      approvalPart,
      { id: 'later', type: 'tool', state: { status: 'completed', time: { start: 101 } } },
    ])).toBe(true);
    expect(approvalWasRolledBackAfterResume(session, approvalPart, [approvalPart])).toBe(false);

    const recovered = logsWithRecoveredApprovalDecision([{
      id: 'gate-1',
      type: 'tool',
      status: 'pending',
      title: 'Pending for approval',
      details: { resumeToken: 'secret-token', prompt: 'Publish?' },
    }], approvalPart);
    expect(recovered[0]).toMatchObject({
      status: 'completed',
      title: 'Approved',
      details: { prompt: 'Publish?', decisionStatus: 'approved' },
    });
    expect(recovered[0]?.details?.resumeToken).toBeUndefined();
  });

  it('merges current and historical session errors with stable, non-duplicated ids', () => {
    const base = [{ id: 'tool-1', type: 'tool', title: 'Worked', time: 10 }];
    const session = {
      id: 'session-1',
      time: { updated: 20 },
      errorHistory: [{ code: 'FIRST', message: 'First failure', time: 15 }],
      error: { code: 'SECOND', message: 'Second failure', time: 25 },
    } as any;
    const once = logsWithSessionError(base as any, session);
    expect(once.slice(1)).toEqual([
      {
        id: 'session-error:session-1',
        type: 'session',
        status: 'error',
        title: 'Session failed',
        time: 15,
        details: { errorMessage: 'First failure' },
      },
      {
        id: 'session-error:session-1:2',
        type: 'session',
        status: 'error',
        title: 'Session failed',
        time: 25,
        details: { errorMessage: 'Second failure' },
      },
    ]);
    expect(logsWithSessionError(once, session)).toEqual(once);
  });

  it('formats malformed generic approval values safely and caps display size', () => {
    const cyclic: any = { value: 'kept' };
    cyclic.self = cyclic;
    expect(formatGenericToolApprovalValue(cyclic)).toBe('[object Object]');
    const large = formatGenericToolApprovalValue('x'.repeat(20_000));
    expect(large.length).toBeLessThan(20_000);
    expect(large).toEndWith('\n… [truncated for display]');
    expect(formatGenericToolApprovalValue(undefined)).toBe('undefined');
  });
});
