import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// Pin a small context window so a single oversized tool result crosses the
// compaction threshold (10000 * 0.7 = 7000 tokens).
mock.module('../src/utils/models-api', () => ({
  getModelInfo: mock(async () => ({
    modelId: 'test-model',
    contextLimit: 10000,
    outputLimit: 4096,
  })),
}));

mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

let mainCalls = 0;
let summarizerCalls = 0;

function mainSegmentOne() {
  // One tool round, then the model wants to continue (finishReason tool-calls).
  return {
    fullStream: (async function* () {
      yield { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: 'big.log' } };
      yield { type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: 'ok' };
      yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 8000, outputTokens: 50, totalTokens: 8050 } };
    })(),
    // Reconstructed conversation includes a huge tool result that blows past the
    // 7000-token threshold, so the loop must compact before the next segment.
    response: Promise.resolve({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: { type: 'text', value: 'x'.repeat(40000) } }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2', toolName: 'read_file', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'read_file', output: { type: 'text', value: 'ok' } }] },
        { role: 'assistant', content: 'analysis so far' },
      ],
    }),
  };
}

function mainSegmentTwo() {
  // After compaction the model finishes cleanly.
  return {
    fullStream: (async function* () {
      yield { type: 'text-delta', text: 'all done' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1200, outputTokens: 10, totalTokens: 1210 } };
    })(),
    response: Promise.resolve({ messages: [{ role: 'assistant', content: 'all done' }] }),
  };
}

function summarizerStream() {
  return {
    fullStream: (async function* () {
      yield { type: 'text-delta', text: 'folded summary' };
      yield { type: 'finish', finishReason: 'stop' };
    })(),
  };
}

const streamTextMock = mock((config: any) => {
  const system = config?.messages?.[0]?.content;
  const isSummarizer = typeof system === 'string' && system.includes('summarizer');
  if (isSummarizer) {
    summarizerCalls++;
    return summarizerStream();
  }
  mainCalls++;
  return mainCalls === 1 ? mainSegmentOne() : mainSegmentTwo();
});

mock.module('ai', () => ({
  streamText: streamTextMock,
  stepCountIs: mock((n: number) => ({ stepCountIs: n })),
}));

let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;

beforeAll(async () => {
  ({ executeAgentCore } = await import('../src/runner/execution'));
});

beforeEach(() => {
  mainCalls = 0;
  summarizerCalls = 0;
  streamTextMock.mockClear();
});

describe('executeAgentCore between-streams compaction loop', () => {
  it('compacts once between segments and runs a second segment (not per step)', async () => {
    const finishReasons: string[] = [];
    for await (const chunk of executeAgentCore(
      { name: 'loop-agent', config: { model: 'demo:test' } } as any,
      { read_file: { description: 'Read a file' } as any },
      {
        userMessage: 'Read the big log and summarize it',
        systemMessages: [{ role: 'system', content: 'you are an agent' }],
        maxSteps: 10,
      }
    )) {
      if (chunk.type === 'finish' && chunk.finishReason) {
        finishReasons.push(chunk.finishReason);
      }
    }

    // Exactly one compaction (summarizer call), not one per step.
    expect(summarizerCalls).toBe(1);
    // Two main segments: the loop restarted streamText from the compacted history.
    expect(mainCalls).toBe(2);
    // The run reached a natural stop in the second segment.
    expect(finishReasons.at(-1)).toBe('stop');
  });

  it('does not compact or loop when the context stays under the threshold', async () => {
    // Override: a single short segment that finishes immediately.
    streamTextMock.mockImplementation((config: any) => {
      const system = config?.messages?.[0]?.content;
      if (typeof system === 'string' && system.includes('summarizer')) {
        summarizerCalls++;
        return summarizerStream();
      }
      mainCalls++;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'quick answer' };
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } };
        })(),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'quick answer' }] }),
      };
    });

    for await (const _ of executeAgentCore(
      { name: 'short-agent', config: { model: 'demo:test' } } as any,
      {},
      {
        userMessage: 'hi',
        systemMessages: [{ role: 'system', content: 'you are an agent' }],
        maxSteps: 10,
      }
    )) {
      // consume
    }

    expect(summarizerCalls).toBe(0);
    expect(mainCalls).toBe(1);
  });
});
