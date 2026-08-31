import { describe, expect, it } from 'bun:test';
import {
  REASONING_LEVELS,
  resolveModelRouteCompatibility,
  resolveReasoningCompatibility,
} from '../src/model-compatibility';

describe('model compatibility registry', () => {
  it('keeps OpenCode Go Responses routes stateless without changing other routes', () => {
    expect(resolveModelRouteCompatibility('opencode-go:grok-4.6')).toEqual({ supportsStore: false });
    expect(resolveModelRouteCompatibility('opencode-go:gpt-5.6-luna')).toEqual({ supportsStore: false });
    expect(resolveModelRouteCompatibility('opencode-go:glm-5.3')).toEqual({ supportsStore: true });
    expect(resolveModelRouteCompatibility('openai:gpt-5.6')).toEqual({ supportsStore: true });
  });

  it('maps GPT-5.6 minimal to low on native and routed variants', () => {
    expect(resolveReasoningCompatibility('openai:gpt-5.6', 'minimal')).toEqual({ reasoning: 'low' });
    expect(resolveReasoningCompatibility('opencode-go:gpt-5.6-luna', 'minimal')).toEqual({ reasoning: 'low' });
  });

  it('uses native provider options for GPT-5.6 max', () => {
    expect(resolveReasoningCompatibility('openai:gpt-5.6-terra', 'max')).toEqual({
      providerOptions: { openai: { reasoningEffort: 'max' } },
    });
  });

  it('uses adaptive thinking for modern Claude max', () => {
    expect(resolveReasoningCompatibility('anthropic:claude-sonnet-4-6', 'max')).toEqual({
      providerOptions: {
        anthropic: { thinking: { type: 'adaptive' }, effort: 'max' },
      },
    });
  });

  it('clamps unconfirmed max support to the previous strongest common tier', () => {
    expect(resolveReasoningCompatibility('opencode-go:qwen3.7-plus', 'max')).toEqual({ reasoning: 'xhigh' });
  });

  it('resolves every public reasoning level instead of silently dropping one', () => {
    for (const level of REASONING_LEVELS) {
      expect(resolveReasoningCompatibility('openai:gpt-5.6', level)).not.toEqual({});
      expect(resolveReasoningCompatibility('anthropic:claude-opus-4-8', level)).not.toEqual({});
    }
  });
});
