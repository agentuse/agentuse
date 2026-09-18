import { describe, expect, it } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type ModelMessage } from 'ai';

describe('OpenAI SDK cache payload compatibility', () => {
  for (const output of [
    { type: 'text' as const, value: 'Reusable tool output' },
    { type: 'json' as const, value: { result: 'Reusable tool output' } },
  ]) {
    it(`preserves explicit cache breakpoints on ${output.type} tool results`, async () => {
      let body: any;
      const provider = createOpenAI({
        apiKey: 'test-only',
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({
            error: { message: 'intentional test stop', type: 'test_error' },
          }), { status: 400, headers: { 'content-type': 'application/json' } });
        },
      });
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Read the reference' },
        { role: 'assistant', content: [
          { type: 'tool-call', toolCallId: 'read-1', toolName: 'read', input: {} },
        ] },
        { role: 'tool', content: [
          {
            type: 'tool-result', toolCallId: 'read-1', toolName: 'read', output,
            providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
          },
        ] },
      ];

      await expect(generateText({
        model: provider.responses('gpt-5.6-sol'),
        messages,
        maxRetries: 0,
        providerOptions: { openai: {
          store: false,
          promptCacheKey: 'agentuse-cache-regression',
          promptCacheOptions: { mode: 'explicit', ttl: '30m' },
        } },
      })).rejects.toThrow('intentional test stop');

      expect(body.prompt_cache_key).toBe('agentuse-cache-regression');
      expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
      expect(body.input.find((item: any) => item.type === 'function_call_output')).toEqual({
        type: 'function_call_output',
        call_id: 'read-1',
        output: [{
          type: 'input_text',
          text: output.type === 'text' ? output.value : JSON.stringify(output.value),
          prompt_cache_breakpoint: { mode: 'explicit' },
        }],
      });
    });
  }
});
