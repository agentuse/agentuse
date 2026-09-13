import { describe, expect, it } from 'bun:test';
import { resolveToolRecoveryLinks, type ToolRecoveryCandidate } from '../src/runner/tool-recovery';

const call = (overrides: Partial<ToolRecoveryCandidate>): ToolRecoveryCandidate => ({
  callId: 'call',
  tool: 'results',
  status: 'completed',
  input: {},
  ...overrides,
});

describe('resolveToolRecoveryLinks', () => {
  it('infers only an immediate successful same-tool call with corrected input', () => {
    const links = resolveToolRecoveryLinks([
      call({ callId: 'failed', status: 'error', input: { expression: 'fromjson' } }),
      call({ callId: 'fixed', input: { expression: '.output | fromjson' } }),
    ]);

    expect(links.recoveryTargetByCallId.get('fixed')).toEqual({
      failedCallId: 'failed',
      inferred: true,
    });
    expect(links.recoveryByFailedCallId.get('failed')).toEqual({
      recoveryCallId: 'fixed',
      inferred: true,
    });
  });

  it('does not infer recovery across another tool call or unchanged arguments', () => {
    const intervened = resolveToolRecoveryLinks([
      call({ callId: 'failed', status: 'error', input: { expression: 'bad' } }),
      call({ callId: 'other', tool: 'search', input: { query: 'help' } }),
      call({ callId: 'later', input: { expression: 'fixed' } }),
    ]);
    expect(intervened.recoveryTargetByCallId.size).toBe(0);

    const unchanged = resolveToolRecoveryLinks([
      call({ callId: 'failed', status: 'error', input: { expression: 'same' } }),
      call({ callId: 'flaky-success', input: { expression: 'same' } }),
    ]);
    expect(unchanged.recoveryTargetByCallId.size).toBe(0);
  });

  it('keeps an explicit valid attempt visible but confirms only a success', () => {
    const links = resolveToolRecoveryLinks([
      call({ callId: 'failed', status: 'error', input: { expression: 'bad' } }),
      call({
        callId: 'attempt',
        status: 'error',
        input: { expression: 'still bad' },
        recoversCallId: 'failed',
      }),
    ]);

    expect(links.recoveryTargetByCallId.get('attempt')).toEqual({
      failedCallId: 'failed',
      inferred: false,
    });
    expect(links.recoveryByFailedCallId.size).toBe(0);
  });

  it('infers and confirms a cross-tool recovery chain sharing one result', () => {
    const resultId = 'result_01J00000000000000000000000_01J00000000000000000000001';
    const links = resolveToolRecoveryLinks([
      call({
        callId: 'code-object-form',
        tool: 'code_exec',
        status: 'error',
        input: { code: `return results.read(${JSON.stringify(resultId)}, { offset: 0 });` },
      }),
      call({
        callId: 'direct-overfilled',
        status: 'error',
        input: { action: 'read', resultId, offset: 0, pattern: '.', expression: '.' },
      }),
      call({
        callId: 'code-fixed',
        tool: 'code_exec',
        input: { code: `return results.read(${JSON.stringify(resultId)});` },
      }),
    ]);

    expect(links.recoveryTargetByCallId.get('direct-overfilled')).toEqual({
      failedCallId: 'code-object-form',
      inferred: true,
    });
    expect(links.recoveryTargetByCallId.get('code-fixed')).toEqual({
      failedCallId: 'direct-overfilled',
      inferred: true,
    });
    expect(links.recoveryByFailedCallId.get('code-object-form')).toEqual({
      recoveryCallId: 'code-fixed',
      inferred: true,
    });
    expect(links.recoveryByFailedCallId.get('direct-overfilled')).toEqual({
      recoveryCallId: 'code-fixed',
      inferred: true,
    });
  });

  it('does not connect adjacent failures that reference different results', () => {
    const links = resolveToolRecoveryLinks([
      call({
        callId: 'first',
        status: 'error',
        input: { resultId: 'result_01J00000000000000000000000_01J00000000000000000000001' },
      }),
      call({
        callId: 'second',
        status: 'error',
        input: { resultId: 'result_01J00000000000000000000000_01J00000000000000000000002' },
      }),
    ]);

    expect(links.recoveryTargetByCallId.size).toBe(0);
    expect(links.recoveryByFailedCallId.size).toBe(0);
  });
});
