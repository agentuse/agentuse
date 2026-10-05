import { describe, expect, it } from 'bun:test';
import {
  detectRuntimeBlockers,
  incompleteSessionError,
  resolveBlocker,
  settleIncomplete,
} from '../src/runner/blocker-evidence';
import { classifyRunResult } from '../src/runner/outcome';
import { blockerGroupKey, isHumanBlocker } from '../src/session/blocker';
import { failureLabel } from '../src/session/failure-label';
import type { ToolCallTrace } from '../src/plugin/types';

const failed = (output: unknown): ToolCallTrace => ({ name: 'bash', type: 'tool', startTime: 0, duration: 1, success: false, output });

describe('detectRuntimeBlockers', () => {
  it('reads missing tools from sh and zsh, and missing Python and Node packages', () => {
    const evidence = detectRuntimeBlockers([
      failed({ output: '[stderr]\n/bin/sh: birdc: command not found\n<bash_metadata>\nexit code: 127\n</bash_metadata>' }),
      failed('zsh: command not found: ego-browser'),
      failed("ModuleNotFoundError: No module named 'boto3.session'"),
      failed("Error: Cannot find package '@scope/pkg/sub' imported from x.js"),
    ]);
    expect(evidence).toEqual([
      { kind: 'missing_tool', subject: 'birdc' },
      { kind: 'missing_tool', subject: 'ego-browser' },
      { kind: 'missing_package', subject: 'boto3' },
      { kind: 'missing_package', subject: '@scope/pkg' },
    ]);
  });

  it('ignores successful calls, model segments, and relative imports', () => {
    expect(detectRuntimeBlockers([
      { name: 'bash', type: 'tool', startTime: 0, duration: 1, success: true, output: 'birdc: command not found' },
      { name: 'model', type: 'llm', startTime: 0, duration: 1, output: 'birdc: command not found' },
      failed("Cannot find module './local-helper'"),
    ])).toEqual([]);
  });

  it('inherits a sub-agent blocker only when the runtime proved it', () => {
    const child = (source: string): ToolCallTrace => ({
      name: 'scout', type: 'subagent', startTime: 0, duration: 1, success: true,
      output: { output: 'blocked', metadata: { blocker: { kind: 'missing_tool', subject: 'birdc', source } } },
    });
    expect(detectRuntimeBlockers([child('runtime')])).toEqual([{ kind: 'missing_tool', subject: 'birdc' }]);
    expect(detectRuntimeBlockers([child('agent')])).toEqual([]);
  });
});

describe('resolveBlocker', () => {
  const birdc = { kind: 'missing_tool' as const, subject: 'birdc' };
  const boto3 = { kind: 'missing_package' as const, subject: 'boto3' };

  it('prefers runtime evidence the agent named', () => {
    expect(resolveBlocker({ kind: 'no_access', subject: 'X' }, 'Source selection blocked because `birdc` is unavailable', [boto3, birdc]))
      .toEqual({ kind: 'missing_tool', subject: 'birdc', source: 'runtime' });
  });

  it('uses the only evidence of the declared kind when the wording differs', () => {
    expect(resolveBlocker({ kind: 'missing_package', subject: 'uploader dependency' }, 'Upload failed', [birdc, boto3]))
      .toEqual({ kind: 'missing_package', subject: 'boto3', source: 'runtime' });
  });

  it('keeps the declaration when evidence is about something else', () => {
    expect(resolveBlocker({ kind: 'bad_input', subject: 'content/registry.yaml' }, 'registry is cut off', [birdc]))
      .toEqual({ kind: 'bad_input', subject: 'content/registry.yaml', source: 'agent' });
  });

  it('matches whole words only', () => {
    expect(resolveBlocker({ kind: 'other', subject: 'tools' }, 'the tools failed', [{ kind: 'missing_tool', subject: 'ls' }]))
      .toEqual({ kind: 'other', subject: 'tools', source: 'agent' });
  });
});

describe('settled incomplete verdicts', () => {
  it('persists the settled blocker on the session error', () => {
    const settled = settleIncomplete(
      { reason: 'birdc is unavailable', blocker: { kind: 'other', subject: 'X reader' } },
      [failed('/bin/sh: birdc: command not found')],
    );
    expect(incompleteSessionError(settled)).toEqual({
      code: 'INCOMPLETE',
      message: 'birdc is unavailable',
      cause: 'missing_tool',
      subject: 'birdc',
      causeSource: 'runtime',
    });
  });

  it('keeps a legacy verdict without a blocker as a plain INCOMPLETE error', () => {
    expect(incompleteSessionError(settleIncomplete({ reason: 'Login expired' }, []))).toEqual({
      code: 'INCOMPLETE',
      message: 'Login expired',
    });
  });

  it('exits 0 only when a person is the blocker', () => {
    const exit = (kind?: 'waiting_on_human' | 'rejected_by_human' | 'missing_tool') =>
      classifyRunResult({ status: 'completed', incomplete: { reason: 'r', ...(kind && { blocker: { kind, subject: 's' } }) } } as any);
    expect(exit('waiting_on_human')).toMatchObject({ kind: 'incomplete', exitCode: 0, success: false });
    expect(exit('rejected_by_human')).toMatchObject({ kind: 'incomplete', exitCode: 0 });
    expect(exit('missing_tool')).toMatchObject({ kind: 'incomplete', exitCode: 1 });
    expect(exit()).toMatchObject({ kind: 'incomplete', exitCode: 1 });
  });
});

describe('blocker helpers', () => {
  it('groups one stuck thing however it was quoted', () => {
    expect(blockerGroupKey('missing_tool', '`Birdc` ')).toBe(blockerGroupKey('missing_tool', 'birdc'));
    expect(blockerGroupKey('missing_tool', 'birdc')).not.toBe(blockerGroupKey('missing_package', 'birdc'));
  });

  it('treats only people as non-error blockers and labels every kind', () => {
    expect(isHumanBlocker('waiting_on_human')).toBe(true);
    expect(isHumanBlocker('rejected_by_human')).toBe(true);
    expect(isHumanBlocker('missing_tool')).toBe(false);
    expect(isHumanBlocker(undefined)).toBe(false);
    expect(failureLabel('missing_tool')).toBe('Missing tool');
    expect(failureLabel('provider_timeout')).toBe('Provider request timed out');
    expect(failureLabel('not_a_kind')).toBeUndefined();
  });
});
