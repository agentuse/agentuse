import { afterEach, describe, expect, it } from 'bun:test';
import { getModelInfo } from '../src/utils/models-api';

describe('getModelInfo', () => {
  it('uses provider input limit for active-context accounting when available', async () => {
    const info = await getModelInfo('openai:gpt-5.5');

    expect(info.contextLimit).toBe(922_000);
    expect(info.totalContextLimit).toBe(1_050_000);
    expect(info.outputLimit).toBe(128_000);
  });

  it('resolves real limits for opencode-go and bedrock (not the fallback)', async () => {
    // Regression: these first-class providers used to collapse to the fallback
    // window because only anthropic/openai/openrouter were in the registry.
    const og = await getModelInfo('opencode-go:kimi-k2.6');
    expect(og.contextLimit).toBeGreaterThan(200_000);

    const bedrock = await getModelInfo('bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(bedrock.contextLimit).toBe(200_000);
  });

  it('resolves bedrock ids across region prefixes not listed on models.dev', async () => {
    // eu./apac. cross-region profiles resolve to the same base model's window
    // via region-strip, instead of falling back.
    const eu = await getModelInfo('bedrock:eu.anthropic.claude-sonnet-4-5-20250929-v1:0');
    const apac = await getModelInfo('bedrock:apac.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(eu.contextLimit).toBe(200_000);
    expect(apac.contextLimit).toBe(200_000);
  });

  describe('unknown-model fallback', () => {
    afterEach(() => { delete process.env.AGENTUSE_FALLBACK_CONTEXT_LIMIT; });

    it('defaults to a generous 200k window so unknown models do not compact early', async () => {
      const info = await getModelInfo('ollama:some-local-model');
      expect(info.contextLimit).toBe(200_000);
    });

    it('honors AGENTUSE_FALLBACK_CONTEXT_LIMIT for local models with a known window', async () => {
      process.env.AGENTUSE_FALLBACK_CONTEXT_LIMIT = '8000';
      const info = await getModelInfo('ollama:tiny-local-model');
      expect(info.contextLimit).toBe(8000);
    });
  });
});
