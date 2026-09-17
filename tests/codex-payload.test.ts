import { describe, expect, it } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage } from 'ai';

async function captureCodexBody(messages: ModelMessage[]): Promise<any> {
  let body: any;
  const openai = createOpenAI({
    apiKey: 'test-only',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        error: { message: 'intentional test stop', type: 'test_error' },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = streamText({
    model: openai.responses('gpt-5'),
    messages,
    allowSystemInMessages: true,
    maxRetries: 0,
    providerOptions: {
      openai: {
        instructions: 'first policy\n\nsecond policy',
        systemMessageMode: 'remove',
        store: false,
      },
    },
    onError: () => {},
  });

  try {
    for await (const _ of result.fullStream) {
      // The fake provider response intentionally ends the request.
    }
  } catch {
    // The serialized request body is the assertion target.
  }
  return body;
}

describe('Codex Responses payload', () => {
  it('sends ordered system policy once, only through instructions', async () => {
    const body = await captureCodexBody([
      { role: 'system', content: 'first policy' },
      { role: 'system', content: 'second policy' },
      { role: 'user', content: 'initial task' },
    ]);

    expect(body.instructions).toBe('first policy\n\nsecond policy');
    expect(body.input).toEqual([{
      role: 'user',
      content: [{ type: 'input_text', text: 'initial task' }],
    }]);
  });

  it('preserves the previous serialized input as an exact prefix', async () => {
    const first = await captureCodexBody([
      { role: 'system', content: 'first policy' },
      { role: 'system', content: 'second policy' },
      { role: 'user', content: 'initial task' },
    ]);
    const next = await captureCodexBody([
      { role: 'system', content: 'first policy' },
      { role: 'system', content: 'second policy' },
      { role: 'user', content: 'initial task' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow-up' },
    ]);

    expect(next.input.slice(0, first.input.length)).toEqual(first.input);
    expect(next.input.map((item: any) => item.role)).toEqual(['user', 'assistant', 'user']);
  });
});
