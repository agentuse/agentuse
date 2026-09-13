import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';

mock.module('../src/models', () => ({ createModel: mock(async () => ({ modelId: 'mock-model' })), AuthenticationError: class extends Error {} }));
const configs: any[] = [];
let toolName = 'await_human';
let lastToolOutput: unknown;
const streamMock = mock((config: any) => {
  configs.push(config);
  return {
    stream: (async function* () {
      const input = toolName === 'await_human' ? { changes: [{ content: 'malformed "command', displayContent: 'NEW' }] } : { command: 'unrecorded read' };
      const output = await config.tools[toolName].execute(input);
      lastToolOutput = output;
      yield { type: 'tool-call', toolName, toolCallId: 'call-1', input };
      yield { type: 'tool-result', toolName, toolCallId: 'call-1', output };
      yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    })(),
    response: Promise.resolve({ messages: [] }), responseMessages: Promise.resolve([]),
  };
});
mock.module('ai', () => ({ streamText: streamMock, isStepCount: (n: number) => ({ n }), jsonSchema: (s: unknown) => ({ jsonSchema: s }), ...aiSdkErrorMocks() }));
let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;
let ReplayDispatcher: typeof import('../src/replay/recording').ReplayDispatcher;
beforeAll(async () => {
  ({ executeAgentCore } = await import('../src/runner/execution'));
  ({ ReplayDispatcher } = await import('../src/replay/recording'));
});
beforeEach(() => { configs.length = 0; lastToolOutput = undefined; streamMock.mockClear(); });

describe('replay execution boundary', () => {
  for (const name of ['await_human', 'tools__bash']) {
    it(`stops on ${name} without review, gate preflight, or an outcome recovery call`, async () => {
      toolName = name;
      const dispatcher = new ReplayDispatcher({ sessionId: 'source', model: 'demo:test', createdAt: 1, cwd: '/project', calls: [], original: { text: 'OLD' }, tools: { tools: [
        { name: 'await_human', inputSchema: { type: 'object' } },
        { name: 'tools__bash', inputSchema: { type: 'object' } },
        { name: 'report_complete', inputSchema: { type: 'object' } },
      ] } }, [], '/project');
      const agent = { name: 'replay', instructions: 'CURRENT', config: { model: 'demo:test', approval: true, tools: { bash: { gated: ['publish *'] } }, verify: { criteria: 'MUST NOT RUN', maxRedos: 2 } } } as any;
      for await (const _ of executeAgentCore(agent, dispatcher.tools(), { userMessage: 'CURRENT', systemMessages: [{ role: 'system', content: 'Test' }], maxSteps: 10, replay: { stopped: () => !!dispatcher.stop } })) { /* drain */ }
      expect(streamMock).toHaveBeenCalledTimes(1);
      expect(dispatcher.stop?.kind).toBe(name === 'await_human' ? 'proposal' : 'missing');
      expect(configs[0].stopWhen.some((p: unknown) => typeof p === 'function' && (p as Function)({ steps: [] }))).toBe(true);
      expect(JSON.stringify(configs[0].messages)).not.toContain('OLD');
      expect(configs[0].toolChoice).toBe('auto');
      expect(configs[0].tools.code_exec).toBeUndefined();
    });
  }

  it('keeps oversized replay outputs in the replay path without storing reusable results', async () => {
    const previous = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = '64';
    toolName = 'load';
    const fullOutput = { items: Array.from({ length: 20 }, (_, index) => ({ id: index, body: 'x'.repeat(20) })) };
    const recordDirectToolResult = mock(async () => {
      throw new Error('replay must not persist a reusable result');
    });
    const agent = { name: 'replay', instructions: 'CURRENT', config: { model: 'demo:test' } } as any;

    try {
      for await (const _ of executeAgentCore(agent, {
        load: {
          inputSchema: { type: 'object', additionalProperties: true },
          execute: async () => fullOutput,
        },
      } as any, {
        userMessage: 'CURRENT',
        systemMessages: [{ role: 'system', content: 'Test' }],
        maxSteps: 1,
        replay: { stopped: () => false },
        sessionManager: { recordDirectToolResult } as any,
        sessionID: '01J00000000000000000000000',
        agentId: 'replay',
        messageID: '01J00000000000000000000001',
      })) { /* drain */ }

      expect(recordDirectToolResult).not.toHaveBeenCalled();
      expect(lastToolOutput).not.toHaveProperty('resultId');
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previous;
    }
  });
});
