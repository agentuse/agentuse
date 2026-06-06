import { describe, expect, it } from 'bun:test';
import { usageToAssistantTokens } from '../src/session/usage';

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
});
