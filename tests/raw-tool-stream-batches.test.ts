/**
 * Offline evaluation of a whole-response refusal policy beside the native one.
 * Uses the real provider SSE parser, runner, Code Mode guest and dispatcher.
 * Only createModel and the provider transport are replaced. No live tools run.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { OpenAICompatibleStreamAdapter, createToolCallExecutionGate } from 'prefix-safe-json';
import { z } from 'zod';

const savedEnvironment = {
  CONTEXT_COMPACTION: process.env.CONTEXT_COMPACTION,
  AGENTUSE_CODE_MODE: process.env.AGENTUSE_CODE_MODE,
  AGENTUSE_MODEL_STALL_RETRY_BASE_DELAY: process.env.AGENTUSE_MODEL_STALL_RETRY_BASE_DELAY,
};
process.env.CONTEXT_COMPACTION = 'false';
process.env.AGENTUSE_CODE_MODE = '1';
process.env.AGENTUSE_MODEL_STALL_RETRY_BASE_DELAY = '0';
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let selected: LanguageModel;
const models = await import('../src/models');
mock.module('../src/models', () => ({ ...models, createModel: async () => selected }));
const { executeAgentCore } = await import('../src/runner/execution');

type Scenario = 'complete' | 'duplicate' | 'malformed-sibling' | 'length';
type FixtureFetch = NonNullable<OpenAICompatibleProviderSettings['fetch']>;
type RequestBody = {
  tools: Array<{ function: { name: string; parameters: object } }>;
  messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>;
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta: unknown, finish_reason: string | null = null) => frame({
  id: 'fixture-response', object: 'chat.completion.chunk', created: 0, model: 'fixture',
  choices: [{ index: 0, delta, finish_reason }],
});
const argumentsFor = (note: string) => JSON.stringify({
  intent: `Record ${note} fixture note`,
  code: `return await tools.write_note({note:${JSON.stringify(note)}});`,
});
function firstResponse(scenario: Scenario): string {
  return chunk({ tool_calls: [
    { index: 0, id: 'call-one', type: 'function', function: { name: 'code_exec', arguments: argumentsFor('first') } },
    { index: 1, id: scenario === 'duplicate' ? 'call-one' : 'call-two', type: 'function', function: {
      name: 'code_exec', arguments: scenario === 'malformed-sibling' ? '{"code":' : argumentsFor('second'),
    } },
  ] }) + chunk({}, scenario === 'length' ? 'length' : 'tool_calls') + 'data: [DONE]\n\n';
}
const finalResponse = chunk({ content: 'Fixture complete.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';

/**
 * Test-only policy for these finite authored response bodies. This buffers the
 * entire fixture before giving its unchanged bytes to the SDK. It is not a
 * production fetch adapter, a transport-error simulator or an approval layer.
 */
function preflightFixture(body: string, request: RequestBody): void {
  const schemas = Object.fromEntries(request.tools.map(tool => [tool.function.name, tool.function.parameters]));
  const adapter = new OpenAICompatibleStreamAdapter();
  const gate = createToolCallExecutionGate(undefined, undefined, schemas);
  for (const event of body.trimEnd().split('\n\n')) {
    const data = event.slice('data: '.length);
    if (data === '[DONE]') continue;
    for (const part of adapter.push(JSON.parse(data))) gate.push(part);
  }
  for (const part of adapter.finish()) gate.push(part);
  const result = gate.finish();
  if (result.decisions.some(decision => decision.action !== 'execute')) {
    throw new Error('PSJ fixture policy refused the entire raw tool batch');
  }
}

for (const scenario of ['complete', 'duplicate', 'malformed-sibling', 'length'] as const) {
  for (const guarded of [false, true]) {
    test(`${scenario}: ${guarded ? 'whole-response preflight' : 'native runner'}`, async () => {
      const notes: string[] = [];
      const requests: RequestBody[] = [];
      const fetch: FixtureFetch = Object.assign(async (_url: Parameters<FixtureFetch>[0], init?: Parameters<FixtureFetch>[1]) => {
        const request = JSON.parse(init!.body as string) as RequestBody;
        requests.push(request);
        // A retry without tool results sees the same original failure, not a
        // successful second response that would hide a repeated bad request.
        const body = request.messages.some(message => message.role === 'tool')
          ? finalResponse : firstResponse(scenario);
        if (guarded) preflightFixture(body, request);
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }, { preconnect() { throw new Error('Fixture transport must not preconnect'); } });
      selected = createOpenAICompatible({
        name: 'fixture', baseURL: 'https://fixture.invalid/v1', apiKey: 'fixture', fetch,
      }).chatModel('fixture');
      const tools = {
        write_note: {
          description: 'Memory-only fixture counter; no files, shell or network.',
          inputSchema: z.object({ note: z.string() }),
          outputSchema: z.object({ recorded: z.string() }),
          execute: async ({ note }: { note: string }) => { notes.push(note); return { recorded: note }; },
        },
      };
      const output: Array<{ type: string; text?: string; toolCallId?: string; error?: unknown }> = [];
      for await (const part of executeAgentCore({
        name: 'wire-fixture', description: 'Offline raw-stream fixture', instructions: 'Test only',
        config: { model: 'openrouter:fixture' },
      } as any, tools, { userMessage: 'go', systemMessages: [], maxSteps: 3 })) output.push(part);

      if (scenario === 'complete') {
        expect(notes.toSorted()).toEqual(['first', 'second']);
        expect(requests).toHaveLength(2);
        const results = requests[1]!.messages.filter(message => message.role === 'tool');
        expect(results.map(message => message.tool_call_id).toSorted()).toEqual(['call-one', 'call-two']);
        expect(JSON.stringify(results)).toContain('first');
        expect(JSON.stringify(results)).toContain('second');
        expect(output.filter(part => part.type === 'text').map(part => part.text).join('')).toBe('Fixture complete.');
        expect(output.filter(part => part.type === 'error')).toHaveLength(0);
      } else if (guarded) {
        expect(notes).toEqual([]);
        expect(requests.some(request => request.messages.some(message => message.role === 'tool'))).toBe(false);
        expect(output.filter(part => part.type === 'error').length).toBeGreaterThan(0);
      } else {
        // Reviewed native policies, not assertions that each difference is a bug.
        expect(notes.length).toBe(scenario === 'duplicate' ? 2 : scenario === 'malformed-sibling' ? 1 : 0);
      }
    }, 20_000);
  }
}
