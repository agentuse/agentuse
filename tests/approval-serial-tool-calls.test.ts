import { describe, test, expect } from 'bun:test';
import { applyApprovalSerialToolCalls } from '../src/runner/execution';

describe('applyApprovalSerialToolCalls (agentuse-lab#165 interim gate)', () => {
  test('no-op for non-gate-capable agents', () => {
    expect(applyApprovalSerialToolCalls('anthropic', false, undefined)).toBeUndefined();
    const existing = { anthropic: { thinking: { type: 'enabled' } } };
    expect(applyApprovalSerialToolCalls('anthropic', false, existing)).toBe(existing);
  });

  test('anthropic: sets disableParallelToolUse, preserving existing options', () => {
    const result = applyApprovalSerialToolCalls('anthropic', true, {
      anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
    });
    expect(result.anthropic.disableParallelToolUse).toBe(true);
    expect(result.anthropic.thinking.budgetTokens).toBe(1024);
  });

  test('anthropic: works from undefined providerOptions', () => {
    const result = applyApprovalSerialToolCalls('anthropic', true, undefined);
    expect(result.anthropic.disableParallelToolUse).toBe(true);
  });

  test('openai: sets parallelToolCalls false, preserving cache/instructions options', () => {
    const result = applyApprovalSerialToolCalls('openai', true, {
      openai: { promptCacheKey: 'agentuse-x', instructions: 'sys' },
    });
    expect(result.openai.parallelToolCalls).toBe(false);
    expect(result.openai.promptCacheKey).toBe('agentuse-x');
    expect(result.openai.instructions).toBe('sys');
  });

  test('unsupported providers pass through unchanged (drain+abort still guards)', () => {
    const existing = { bedrock: { foo: 1 } };
    expect(applyApprovalSerialToolCalls('amazon-bedrock', true, existing)).toBe(existing);
    expect(applyApprovalSerialToolCalls('ollama', true, undefined)).toBeUndefined();
  });
});
