import { describe, expect, it } from 'bun:test';
import {
  REASONING_LEVELS,
  prepareThinkingReplay,
  resolveModelRouteCompatibility,
  resolveReasoningCompatibility,
  transformOpenAICompatibleRequest,
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

  it('uses OpenRouter reasoning objects for every effort level', () => {
    expect(resolveReasoningCompatibility('openrouter:openai/gpt-5.6-luna', 'minimal')).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
    });
    expect(resolveReasoningCompatibility('openrouter:openai/gpt-5.6-sol', 'max')).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: 'max' } } },
    });
    expect(resolveReasoningCompatibility('openrouter:anthropic/claude-sonnet-4.6', 'none')).toEqual({
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    });
  });

  it('adds empty signatures only for Anthropic-compatible thinking replay', () => {
    const messages = [{
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'consider this' }, { type: 'text', text: 'done' }],
    }];
    expect(prepareThinkingReplay('opencode-go:qwen3.7-plus', messages)).toEqual([{
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'consider this', providerOptions: { anthropic: { signature: '' } } },
        { type: 'text', text: 'done' },
      ],
    }]);
    expect(prepareThinkingReplay('anthropic:claude-sonnet-4-6', messages)).toBe(messages);
    expect(prepareThinkingReplay('opencode-go:glm-5.3', messages)).toBe(messages);
  });

  it('applies configured OpenAI-compatible request deviations together', () => {
    expect(transformOpenAICompatibleRequest({
      max_tokens: 2048,
      reasoning_effort: 'minimal',
      store: false,
      messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hello' }],
    }, {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: 'max_completion_tokens',
    })).toEqual({
      max_completion_tokens: 2048,
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }],
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
