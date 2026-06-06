import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const streamTextMock = mock(() => ({
  fullStream: (async function* () {
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };
  })(),
}));

const stepCountIsMock = mock((steps: number) => ({ steps }));
const createModelMock = mock(async () => ({ modelId: 'mock-model' }));

mock.module('ai', () => ({
  streamText: streamTextMock,
  stepCountIs: stepCountIsMock,
}));

mock.module('../src/models', () => ({
  createModel: createModelMock,
  AuthenticationError: class AuthenticationError extends Error {},
}));

let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;

beforeAll(async () => {
  ({ executeAgentCore } = await import('../src/runner/execution'));
});

beforeEach(() => {
  streamTextMock.mockClear();
  stepCountIsMock.mockClear();
  createModelMock.mockClear();
});

describe('executeAgentCore Anthropic cache control', () => {
  it('marks Anthropic system, latest step message, and final tool as cacheable', async () => {
    const chunks: any[] = [];

    for await (const chunk of executeAgentCore(
      {
        name: 'cache-test',
        config: {
          model: 'anthropic:claude-haiku-4-5',
        },
      } as any,
      {
        read_file: {
          description: 'Read a file',
        } as any,
        bash: {
          description: 'Run a command',
        } as any,
      },
      {
        userMessage: 'Check cache usage',
        systemMessages: [
          { role: 'system', content: 'static instructions' },
        ],
        maxSteps: 3,
      }
    )) {
      chunks.push(chunk);
    }

    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true);
    expect(streamTextMock).toHaveBeenCalledTimes(1);

    const streamConfig = streamTextMock.mock.calls[0][0] as any;
    expect(streamConfig.messages[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    });
    expect(streamConfig.tools.read_file.providerOptions).toBeUndefined();
    expect(streamConfig.tools.bash.providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    });

    const stepMessages = streamConfig.prepareStep({
      messages: [
        { role: 'system', content: 'static instructions' },
        { role: 'tool', content: [{ type: 'tool-result', output: 'large result' }] },
      ],
    }).messages;

    expect(stepMessages[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    });
    expect(stepMessages[1].providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    });
  });

  it('does not add Anthropic cache control to non-Anthropic models', async () => {
    for await (const _ of executeAgentCore(
      {
        name: 'cache-test',
        config: {
          model: 'openai:gpt-5',
        },
      } as any,
      {
        bash: {
          description: 'Run a command',
        } as any,
      },
      {
        userMessage: 'Check cache usage',
        systemMessages: [
          { role: 'system', content: 'static instructions' },
        ],
        maxSteps: 3,
      }
    )) {
      // Consume the stream.
    }

    const streamConfig = streamTextMock.mock.calls[0][0] as any;
    expect(streamConfig.messages[0].providerOptions).toBeUndefined();
    expect(streamConfig.tools.bash.providerOptions).toBeUndefined();
    expect(streamConfig.prepareStep).toBeUndefined();
  });
});
