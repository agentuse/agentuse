import { describe, expect, it } from 'bun:test';
import { parseAgentContent } from '../src/parser';
import {
  openAIOptionsWithCacheDefaults,
  resolveAnthropicThinking,
  resolveMaxOutputTokens
} from '../src/runner/execution';

// Build a ParsedAgent from frontmatter so the tests exercise the real config
// path (zod parse + defaults) without mocking, and without a live model call.
function agent(frontmatter: string) {
  return parseAgentContent(`---\n${frontmatter}\n---\n\nTest agent`, 'test-agent');
}

describe('openAIOptionsWithCacheDefaults — reasoningSummary gating', () => {
  it('defaults reasoningSummary to auto on a reasoning-capable model', () => {
    const opts = openAIOptionsWithCacheDefaults(agent('model: openai:gpt-5.5'));
    expect(opts.reasoningSummary).toBe('auto');
  });

  it('omits reasoningSummary for a non-reasoning / unknown model (avoids API rejection)', () => {
    const opts = openAIOptionsWithCacheDefaults(agent('model: openai:gpt-4o'));
    expect(opts.reasoningSummary).toBeUndefined();
  });

  it('lets explicit user config override the auto default', () => {
    const opts = openAIOptionsWithCacheDefaults(
      agent('model: openai:gpt-5.5\nopenai:\n  reasoningSummary: detailed')
    );
    expect(opts.reasoningSummary).toBe('detailed');
  });

  it('always sets a stable promptCacheKey', () => {
    const opts = openAIOptionsWithCacheDefaults(agent('model: openai:gpt-5.5'));
    expect(typeof opts.promptCacheKey).toBe('string');
    expect((opts.promptCacheKey as string).length).toBeGreaterThan(0);
  });
});

describe('resolveAnthropicThinking', () => {
  it('returns undefined when thinking is not configured', () => {
    expect(resolveAnthropicThinking(agent('model: anthropic:claude-opus-4-8'))).toBeUndefined();
  });

  it('resolves budget and reserves max_tokens above the budget', () => {
    const r = resolveAnthropicThinking(
      agent('model: anthropic:claude-opus-4-8\nanthropic:\n  thinking:\n    budgetTokens: 4096')
    );
    expect(r).toBeDefined();
    expect(r!.budgetTokens).toBe(4096);
    // Must exceed budget (Anthropic requires max_tokens > thinking.budget_tokens).
    expect(r!.maxOutputTokens).toBeGreaterThan(r!.budgetTokens);
    // budget + 8192 reserve, well within the opus output limit.
    expect(r!.maxOutputTokens).toBe(4096 + 8192);
  });

  it('clamps max_tokens to the model output limit while staying above the budget', () => {
    // claude-haiku-4-5 output limit is 64000; budget 60000 -> desired 68192 clamps to 64000.
    const r = resolveAnthropicThinking(
      agent('model: anthropic:claude-haiku-4-5\nanthropic:\n  thinking:\n    budgetTokens: 60000')
    );
    expect(r!.maxOutputTokens).toBe(64000);
    expect(r!.maxOutputTokens).toBeGreaterThan(r!.budgetTokens);
  });
});

describe('resolveMaxOutputTokens', () => {
  it('caps a first-class Anthropic model at the default, never the SDK 4096', () => {
    // claude-sonnet-5 registry output is 128000 -> min(128000, 32000). Regression
    // guard: the AI SDK would otherwise silently cap this unknown-to-it id at 4096.
    expect(resolveMaxOutputTokens(agent('model: anthropic:claude-sonnet-5'))).toBe(32000);
  });

  it("uses a small model's own output limit when it is at or below the default cap", () => {
    // The full-catalog registry no longer lists a sub-32k Anthropic model (the
    // old 8192-output ids were dropped), so pin the boundary instead:
    // claude-opus-4-1 output is exactly 32000 -> min(32000, 32000), not inflated.
    expect(resolveMaxOutputTokens(agent('model: anthropic:claude-opus-4-1'))).toBe(32000);
  });

  it("honors an explicit override, clamped to the model's real ceiling", () => {
    expect(
      resolveMaxOutputTokens(agent('model: anthropic:claude-sonnet-5\nmaxOutputTokens: 50000'))
    ).toBe(50000);
    // 200000 clamps down to sonnet-5's real 128000 output limit.
    expect(
      resolveMaxOutputTokens(agent('model: anthropic:claude-sonnet-5\nmaxOutputTokens: 200000'))
    ).toBe(128000);
  });

  it('lets extended thinking win with its budget-aware ceiling', () => {
    // opus budget 4096 -> 4096 + 8192 reserve.
    expect(
      resolveMaxOutputTokens(
        agent('model: anthropic:claude-opus-4-8\nanthropic:\n  thinking:\n    budgetTokens: 4096')
      )
    ).toBe(12288);
  });

  it('leaves OpenAI alone by default so the SDK uses the model max', () => {
    expect(resolveMaxOutputTokens(agent('model: openai:gpt-5'))).toBeUndefined();
  });

  it("applies an override to non-Anthropic providers too, clamped to the model's limit", () => {
    // gpt-5 output limit is 128000, so 20000 passes through unclamped.
    expect(
      resolveMaxOutputTokens(agent('model: openai:gpt-5\nmaxOutputTokens: 20000'))
    ).toBe(20000);
  });

  it('falls back to the SDK default for an Anthropic model unknown to the registry', () => {
    expect(
      resolveMaxOutputTokens(agent('model: anthropic:claude-does-not-exist-9'))
    ).toBeUndefined();
  });

  it('gives custom/local gateways a fixed conservative cap', () => {
    expect(resolveMaxOutputTokens(agent('model: mycustomgw:some-model'))).toBe(16384);
  });
});
