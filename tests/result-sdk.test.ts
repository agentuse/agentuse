import { expect, it, mock } from 'bun:test';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
process.env.CONTEXT_COMPACTION = 'false';
let request: any;
let calls = 0;
const model = new MockLanguageModelV3({ doStream: async (options: any) => {
  request = options; calls++;
  return { stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: '{"status":"generated","output":"New draft"}' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } },
  ] as any) };
} });
mock.module('../src/models', () => ({
  createModel: async () => model,
  AuthenticationError: class AuthenticationError extends Error {},
}));
const { executeAgentCore } = await import('../src/runner/execution');
const { processAgentStream } = await import('../src/runner/stream');
it('closed result generation uses the real SDK without Code Mode, workflow tools, or outcome recovery', async () => {
  const result = await processAgentStream(executeAgentCore({ name: 'writer', instructions: 'Write a draft', config: {
    model: 'demo:test', approval: true, tools: { bash: { gated: ['publish *'] } }, verify: { criteria: 'must not execute', maxRedos: 2 },
  } } as any, {}, { userMessage: 'Write using fixed evidence', systemMessages: [{ role: 'system', content: 'Return a result only' }], maxSteps: 1,
    replay: { stopped: () => false } }), { quiet: true });
  expect(result.finishReason).toBe('stop');
  expect(JSON.parse(result.text).output).toBe('New draft');
  expect(calls).toBe(1);
  expect(request.tools ?? []).toEqual([]);
});
