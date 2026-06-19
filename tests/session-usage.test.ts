import { describe, expect, it } from 'bun:test';
import { addAssistantTokens, addLanguageModelUsage, contextUsageFromSnapshot, usageToAssistantTokens } from '../src/session/usage';

describe('usageToAssistantTokens', () => {
  it('persists normalized cache read/write token counts', () => {
    const tokens = usageToAssistantTokens({
      inputTokens: 501684,
      inputTokenDetails: {
        noCacheTokens: 120000,
        cacheReadTokens: 350000,
        cacheWriteTokens: 31684,
      },
      outputTokens: 2187,
      outputTokenDetails: {
        textTokens: 2000,
        reasoningTokens: 187,
      },
      totalTokens: 503871,
    });

    expect(tokens).toEqual({
      input: 501684,
      output: 2187,
      reasoning: 187,
      cache: {
        read: 350000,
        write: 31684,
      },
    });
  });

  it('falls back to deprecated AI SDK cache and reasoning fields', () => {
    const tokens = usageToAssistantTokens({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 7,
      cachedInputTokens: 42,
    } as any);

    expect(tokens).toEqual({
      input: 100,
      output: 20,
      reasoning: 7,
      cache: {
        read: 42,
        write: 0,
      },
    });
  });

  it('adds per-step language model usage without dropping details', () => {
    const usage = addLanguageModelUsage({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      inputTokenDetails: {
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
      },
      outputTokenDetails: {
        reasoningTokens: 1,
      },
    } as any, {
      inputTokens: 20,
      outputTokens: 3,
      totalTokens: 23,
      inputTokenDetails: {
        cacheReadTokens: 6,
        cacheWriteTokens: 2,
      },
      outputTokenDetails: {
        reasoningTokens: 2,
      },
    } as any);

    expect(usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      inputTokenDetails: {
        cacheReadTokens: 10,
        cacheWriteTokens: 3,
      },
      outputTokenDetails: {
        reasoningTokens: 3,
      },
    });
  });
});

describe('addAssistantTokens', () => {
  it('treats a missing base as zero (fresh run)', () => {
    const delta = { input: 100, output: 20, reasoning: 3, cache: { read: 70, write: 5 } };
    expect(addAssistantTokens(undefined, delta)).toEqual(delta);
  });

  it('folds a prior cumulative total into a resumed run so the count stays monotonic', () => {
    // Models the bug: invocation #1 suspends at an approval gate with a large
    // cumulative total; invocation #2 (resume) reports only its own usage. The
    // persisted value must be the sum, never a drop back to #2's smaller number.
    const priorFromSuspend = { input: 221_521, output: 1_341, reasoning: 0, cache: { read: 170_567, write: 0 } };
    const resumedRun = { input: 271_074, output: 3_405, reasoning: 0, cache: { read: 214_331, write: 0 } };

    expect(addAssistantTokens(priorFromSuspend, resumedRun)).toEqual({
      input: 492_595,
      output: 4_746,
      reasoning: 0,
      cache: { read: 384_898, write: 0 },
    });
  });
});

describe('contextUsageFromSnapshot', () => {
  it('recomputes active context from persisted snapshot messages', () => {
    const usage = contextUsageFromSnapshot({
      version: 1,
      updatedAt: 1,
      messages: [
        { role: 'user', content: 'a'.repeat(20_000) },
        { role: 'tool', content: [{ type: 'tool-result', toolName: 'tools__bash', output: 'b'.repeat(20_000) }] },
      ],
      usage: {
        activeTokens: 3_520,
        contextLimit: 922_000,
        usagePercentage: 0.38177874186550975,
        compacted: false,
        compactions: 0,
        updatedAt: 1,
      },
    });

    expect(usage?.activeTokens).toBeGreaterThan(3_520);
    expect(usage?.contextLimit).toBe(922_000);
    expect(usage?.usagePercentage).toBeCloseTo((usage!.activeTokens / 922_000) * 100);
  });
});
