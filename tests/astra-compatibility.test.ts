import { describe, expect, it } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { parseAgentContent } from '../src/parser';
import { resolveReasoningCompatibility } from '../src/model-compatibility';
import { openAIOptionsWithCacheDefaults, resolveReasoning } from '../src/runner/execution';
import { getVersionAliases } from '../src/utils/model-alias';
import { MODELS, SUGGESTED_MODEL_IDS } from '../src/generated/models';

const agent = (settings: string) => parseAgentContent(`---\nmodel: openai:gpt-6-astra\n${settings}\n---\nTest`, 'astra-test');

describe('GPT-6 Astra', () => {
  it('registers published limits and preserves lower-cost suggested tiers', () => {
    expect(getVersionAliases()['openai:gpt-astra']).toBe('openai:gpt-6-astra');
    expect(getVersionAliases()['openai:gpt-mini']).toBe('openai:gpt-5.4-mini');
    expect(MODELS.openai['gpt-6-astra'].limit).toEqual({ context: 1050000, input: 922000, output: 128000 });
    expect(MODELS.openai['gpt-6-astra'].cost).toEqual({ input: 10, output: 50 });
    for (const id of ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(SUGGESTED_MODEL_IDS).toContain(`openai:${id}`);
    }
  });

  it('normalizes unsupported efforts on native and OpenRouter routes', () => {
    for (const effort of ['none', 'minimal'] as const) {
      expect(resolveReasoningCompatibility('openai:gpt-6-astra', effort)).toEqual({ reasoning: 'low' });
      expect(resolveReasoningCompatibility('openrouter:openai/gpt-6-astra', effort)).toEqual({
        providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
      });
      expect(openAIOptionsWithCacheDefaults(agent(`openai:\n  reasoningEffort: ${effort}`)).reasoningEffort).toBe('low');
    }
    expect(resolveReasoningCompatibility('openai:gpt-5.6', 'none')).toEqual({ reasoning: 'none' });
  });

  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    it(`serializes ${effort} through the installed Responses SDK`, async () => {
      let body: any;
      let url = '';
      const provider = createOpenAI({ apiKey: 'test-only', fetch: async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body));
        throw new Error('captured-request');
      } });
      const parsed = agent(`reasoning: ${effort}`);
      const resolved = resolveReasoning(parsed);
      await expect(generateText({
        model: provider.responses('gpt-6-astra'),
        prompt: 'Test',
        temperature: 0.3,
        maxRetries: 0,
        reasoning: resolved.reasoning,
        providerOptions: { openai: {
          ...openAIOptionsWithCacheDefaults(parsed),
          ...resolved.providerOptions?.openai,
        } },
      })).rejects.toThrow('captured-request');
      expect(url).toEndWith('/responses');
      expect(body.reasoning.effort).toBe(['none', 'minimal'].includes(effort) ? 'low' : effort);
      expect(body.reasoning.summary).toBe('auto');
      expect(body.temperature).toBeUndefined();
    });
  }
});
