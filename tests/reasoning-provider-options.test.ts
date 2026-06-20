import { describe, expect, it } from 'bun:test';
import { parseAgentContent } from '../src/parser';
import { openAIOptionsWithCacheDefaults, resolveAnthropicThinking } from '../src/runner/execution';

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
