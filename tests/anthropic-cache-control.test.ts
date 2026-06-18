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
const generateTextMock = mock(async () => ({ text: 'compacted' }));

mock.module('ai', () => ({
  generateText: generateTextMock,
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
  generateTextMock.mockClear();
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

    const stepMessages = (await streamConfig.prepareStep({
      messages: [
        { role: 'system', content: 'static instructions' },
        { role: 'tool', content: [{ type: 'tool-result', output: 'large result' }] },
      ],
    })).messages;

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

  it('keeps dynamic user input after the cacheable instruction prefix', async () => {
    for await (const _ of executeAgentCore(
      {
        name: 'cache-test',
        config: {
          model: 'anthropic:claude-haiku-4-5',
        },
      } as any,
      {},
      {
        userMessage: 'Stable agent instructions\n\nChanged run request',
        cacheableUserMessage: 'Stable agent instructions',
        systemMessages: [
          { role: 'system', content: 'static system instructions' },
        ],
        maxSteps: 3,
      }
    )) {
      // Consume the stream.
    }

    const streamConfig = streamTextMock.mock.calls[0][0] as any;
    const userMessage = streamConfig.messages[1];
    expect(userMessage.providerOptions).toBeUndefined();
    expect(userMessage.content).toEqual([
      {
        type: 'text',
        text: 'Stable agent instructions',
        providerOptions: {
          anthropic: {
            cacheControl: { type: 'ephemeral' },
          },
        },
      },
      {
        type: 'text',
        text: '\n\nChanged run request',
      },
    ]);

    const stepMessages = (await streamConfig.prepareStep({
      messages: streamConfig.messages,
    })).messages;

    expect(stepMessages[1].providerOptions).toBeUndefined();
    expect(stepMessages[1].content[1].providerOptions).toBeUndefined();
  });

  it('adds OpenAI prompt cache routing without Anthropic cache control', async () => {
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
    expect(streamConfig.providerOptions.openai.promptCacheKey).toMatch(/^agentuse-cache-test-[a-f0-9]{16}$/);
    expect(streamConfig.messages[0].providerOptions).toBeUndefined();
    expect(streamConfig.tools.bash.providerOptions).toBeUndefined();
    expect(streamConfig.prepareStep).toBeFunction();
    const stepMessages = (await streamConfig.prepareStep({
      messages: streamConfig.messages,
    })).messages;
    expect(stepMessages[0].providerOptions).toBeUndefined();
  });

  it('preserves explicit OpenAI prompt cache options', async () => {
    for await (const _ of executeAgentCore(
      {
        name: 'cache-test',
        config: {
          model: 'openai:gpt-5',
          openai: {
            promptCacheKey: 'support-batch-cache',
            promptCacheRetention: '24h',
            textVerbosity: 'low',
          },
        },
      } as any,
      {},
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
    expect(streamConfig.providerOptions.openai).toMatchObject({
      promptCacheKey: 'support-batch-cache',
      promptCacheRetention: '24h',
      textVerbosity: 'low',
    });
  });
});
