import { describe, expect, it } from 'bun:test';
import { addLanguageModelUsage, contextUsageFromSnapshot, usageToAssistantTokens } from '../src/session/usage';

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
