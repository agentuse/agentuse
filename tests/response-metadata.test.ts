import { describe, expect, it } from 'bun:test';
import { responseMetadataFromRaw, responseMetadataFromStep, readResponseMetadata } from '../src/telemetry/response-metadata';

describe('response metadata allowlist', () => {
  it('retains returned facts and distinguishes ordinary input from cache writes', () => {
    expect(responseMetadataFromRaw({ type: 'response.completed', response: {
      id: 'resp_1', model: 'gpt-5.6', service_tier: 'priority', output: ['private output'],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } },
      prompt_cache_diagnostics: { type: 'cache_miss', reason: 'test-reason', private: 'discard' },
    } })).toEqual({ responseId: 'resp_1', model: 'gpt-5.6', serviceTier: 'priority',
      inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 20, uncachedInputTokens: 40,
      diagnosticType: 'cache_miss', diagnosticReason: 'test-reason' });
  });

  it('does not turn absent provider counts into SDK default zero values', () => {
    const raw = responseMetadataFromRaw({ type: 'response.completed', response: {
      id: 'resp_2', usage: { input_tokens: 100 },
    } });
    expect(responseMetadataFromStep({ usage: { inputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 0, noCacheTokens: 100 }, raw: { input_tokens: 100 } },
      response: { id: 'resp_2' } }, raw)).toEqual({ responseId: 'resp_2', inputTokens: 100 });
  });

  it('keeps explicit zero, rejects invalid counts and ignores nonterminal payloads', () => {
    expect(readResponseMetadata({ cacheWriteTokens: 0, cachedInputTokens: NaN, inputTokens: -1,
      model: null, responseId: '', output: 'secret', headers: { authorization: 'secret' } })).toEqual({ cacheWriteTokens: 0 });
    expect(responseMetadataFromRaw({ type: 'response.output_text.delta', delta: 'private' })).toBeUndefined();
    expect(responseMetadataFromStep({})).toBeUndefined();
  });

  it('falls back to SDK response facts when raw responses are unavailable', () => {
    expect(responseMetadataFromStep({ response: { id: 'resp_3', modelId: 'actual-model' },
      providerMetadata: { openai: { serviceTier: 'default' } },
      usage: { inputTokens: 60, inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 0, noCacheTokens: 50 } },
    })).toEqual({ responseId: 'resp_3', model: 'actual-model', serviceTier: 'default', inputTokens: 60,
      cachedInputTokens: 10, cacheWriteTokens: 0, uncachedInputTokens: 50 });
  });
});
