import { beforeAll, expect, it, mock } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';
import type { AgentChunk } from '../src/runner/types';
import type { RunOutcome } from '../src/tools/report-outcome';
import { classifyFailure } from '../src/runner/failure';

let sdkChunks: Record<string, unknown>[] = [];
let calls = 0;
mock.module('../src/models', () => ({ createModel: async () => ({ modelId: 'mock' }) }));
mock.module('ai', () => ({
  ...aiSdkErrorMocks(),
  isStepCount: (n: number) => ({ isStepCount: n }),
  streamText: () => {
    calls++;
    return {
      stream: (async function* () { yield* sdkChunks; })(),
      response: Promise.resolve({ messages: [] }),
      responseMessages: Promise.resolve([]),
    };
  },
}));
let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;
let processAgentStream: typeof import('../src/runner/stream').processAgentStream;
beforeAll(async () => {
  ({ executeAgentCore } = await import('../src/runner/execution'));
  ({ processAgentStream } = await import('../src/runner/stream'));
});
async function run() {
  calls = 0;
  const chunks: AgentChunk[] = [];
  const agent = { name: 'filter-test', instructions: 'test', config: { model: 'openai:mock' } };
  for await (const chunk of executeAgentCore(agent as Parameters<typeof executeAgentCore>[0], {}, {
    userMessage: 'go', systemMessages: [], maxSteps: 3,
    runOutcome: { complete: { headline: 'done' } } as RunOutcome,
  })) chunks.push(chunk);
  return chunks;
}
it('classifies a terminal provider filter and does not start a recovery segment', async () => {
  sdkChunks = [
    { type: 'finish-step', finishReason: 'content-filter' },
    { type: 'finish', finishReason: 'content-filter' },
  ];
  const chunks = await run();
  const error = chunks.find(chunk => chunk.type === 'error');
  expect(error).toBeDefined();
  expect(classifyFailure(error!.error)).toMatchObject({ code: 'CONTENT_FILTER', cause: 'provider_content_filter' });
  expect(chunks.some(chunk => chunk.type === 'finish' && chunk.finishReason === 'stop')).toBe(false);
  expect(calls).toBe(1);
});
it('retains a usage-less intermediate filter through later success and session persistence', async () => {
  sdkChunks = [
    { type: 'tool-call', toolName: 'read', toolCallId: 'filtered', input: {} },
    { type: 'tool-error', toolName: 'read', toolCallId: 'filtered', error: new Error('Invalid JSON') },
    { type: 'finish-step', finishReason: 'content-filter' },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ];
  const chunks = await run();
  expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
  expect(chunks.find(chunk => chunk.finishReason === 'content-filter')).toMatchObject({ type: 'usage', usageKind: 'step' });
  expect(chunks.filter(chunk => chunk.type === 'finish').at(-1)?.finishReason).toBe('stop');
  const parts: Array<Record<string, unknown>> = [];
  const updates: unknown[][] = [];
  const manager = {
    addPart: async (_s: string, _a: string, _m: string, part: Record<string, unknown>) => { parts.push(part); return String(part.callID ?? 'text'); },
    updatePart: async (...args: unknown[]) => { updates.push(args); },
    updateMessage: async () => {},
  };
  await processAgentStream((async function* () { yield* chunks; })(), {
    sessionManager: manager as unknown as NonNullable<Parameters<typeof processAgentStream>[1]>['sessionManager'],
    sessionID: 'session', agentId: 'agent', messageID: 'message', quiet: true,
  });
  expect(parts.filter(p => p.type === 'step-finish').map(p => p.modelStepUsage)).toEqual([
    expect.objectContaining({ finishReason: 'content-filter' }),
    expect.objectContaining({ finishReason: 'stop' }),
  ]);
  expect(updates.filter(u => u[3] === 'filtered').at(-1)?.[4]).toMatchObject({ state: {
    error: expect.stringContaining('Provider content filter'),
    metadata: { modelStepUsage: { finishReason: 'content-filter' } },
  } });
  expect(calls).toBe(1);
});
