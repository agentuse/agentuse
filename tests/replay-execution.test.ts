import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';

mock.module('../src/models', () => ({ createModel: mock(async () => ({ modelId: 'mock-model' })), AuthenticationError: class extends Error {} }));
const configs: any[] = [];
let toolName = 'await_human';
const streamMock = mock((config: any) => {
  configs.push(config);
  return {
    stream: (async function* () {
      const input = toolName === 'await_human' ? { changes: [{ content: 'malformed "command', displayContent: 'NEW' }] } : { command: 'unrecorded read' };
      const output = await config.tools[toolName].execute(input);
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
beforeEach(() => { configs.length = 0; streamMock.mockClear(); });

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
    });
  }
});
