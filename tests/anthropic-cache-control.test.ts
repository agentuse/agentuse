import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SuspendSignal } from '../src/runner/suspend';

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

  it('compacts active context before emitting an approval suspension snapshot at the boundary threshold', async () => {
    process.env.APPROVAL_COMPACTION_MIN_TOKENS = '1';
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'call-approval',
          toolName: 'await_human',
          input: { prompt: 'Approve?' },
        };
        yield {
          type: 'tool-error',
          toolCallId: 'call-approval',
          toolName: 'await_human',
          error: new SuspendSignal({
            kind: 'await_human',
            prompt: 'Approve?',
            resumeToken: 'token-1',
          }),
        };
      })(),
    }));
    // Compaction summarizes via completeText(), i.e. a second streamText call.
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'compacted' };
        yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      })(),
    }));

    try {
      const chunks: any[] = [];

      for await (const chunk of executeAgentCore(
        {
          name: 'approval-boundary',
          config: {
            model: 'demo:test',
          },
        } as any,
        {},
        {
          userMessage: 'unused because messages are prebuilt',
          systemMessages: [],
          messages: [
            { role: 'system', content: 'old system context' },
            { role: 'user', content: 'old user context' },
            { role: 'assistant', content: 'old middle 1' },
            { role: 'user', content: 'old middle 2' },
            { role: 'assistant', content: 'recent assistant context 1' },
            { role: 'tool', content: [{ type: 'tool-result', output: 'recent tool context' }] },
            { role: 'user', content: 'recent user context 2' },
          ] as any,
          maxSteps: 3,
          messageID: 'message-1',
        }
      )) {
        chunks.push(chunk);
      }

      const suspended = chunks.find((chunk) => chunk.type === 'suspended');
      expect(suspended).toBeTruthy();
      // Main stream + one compaction (completeText) stream.
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(suspended.contextSnapshot).toMatchObject({
        messageID: 'message-1',
        usage: {
          compacted: true,
          compactions: 1,
        },
      });
      // Head (system + original task) preserved verbatim, the middle folded into
      // a user-role summary, and the recent tail kept intact.
      expect(suspended.contextSnapshot.messages).toHaveLength(6);
      expect(suspended.contextSnapshot.messages[0]).toEqual({
        role: 'system',
        content: 'old system context',
      });
      expect(suspended.contextSnapshot.messages[1]).toEqual({
        role: 'user',
        content: 'old user context',
      });
      expect(suspended.contextSnapshot.messages[2]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('[Context Summary]\ncompacted\n[End Summary]'),
      });
      expect(suspended.contextSnapshot.messages.slice(3)).toEqual([
        { role: 'assistant', content: 'recent assistant context 1' },
        { role: 'tool', content: [{ type: 'tool-result', output: 'recent tool context' }] },
        { role: 'user', content: 'recent user context 2' },
      ]);
    } finally {
      delete process.env.APPROVAL_COMPACTION_MIN_TOKENS;
    }
  });

  it('emits step usage before an approval suspension when the final finish event is absent', async () => {
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'call-approval',
          toolName: 'await_human',
          input: { prompt: 'Approve?' },
        };
        yield {
          type: 'finish-step',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 76_000,
            outputTokens: 120,
            totalTokens: 76_120,
          },
        };
        yield {
          type: 'tool-error',
          toolCallId: 'call-approval',
          toolName: 'await_human',
          error: new SuspendSignal({
            kind: 'await_human',
            prompt: 'Approve?',
            resumeToken: 'token-1',
          }),
        };
      })(),
    }));

    const chunks: any[] = [];
    for await (const chunk of executeAgentCore(
      {
        name: 'approval-usage',
        config: {
          model: 'demo:test',
        },
      } as any,
      {},
      {
        userMessage: 'Ask for approval',
        systemMessages: [],
        maxSteps: 3,
      }
    )) {
      chunks.push(chunk);
    }

    const usage = chunks.find((chunk) => chunk.type === 'usage');
    const suspended = chunks.find((chunk) => chunk.type === 'suspended');
    expect(usage).toMatchObject({
      type: 'usage',
      usageKind: 'step',
      usage: {
        inputTokens: 76_000,
        outputTokens: 120,
        totalTokens: 76_120,
      },
    });
    expect(chunks.indexOf(usage)).toBeLessThan(chunks.indexOf(suspended));
  });

  it('compacts long-run context at model step boundaries after the first tool call', async () => {
    process.env.STEP_COMPACTION_MIN_TOKENS = '1';
    streamTextMock.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'call-read',
          toolName: 'read_file',
          input: { path: 'large.log' },
        };
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        };
      })(),
    }));

    try {
      for await (const _ of executeAgentCore(
        {
          name: 'step-boundary',
          config: {
            model: 'demo:test',
          },
        } as any,
        {
          read_file: {
            description: 'Read a file',
          } as any,
        },
        {
          userMessage: 'Initial task',
          systemMessages: [
            { role: 'system', content: 'static instructions' },
          ],
          maxSteps: 3,
        }
      )) {
        // Consume the stream so stepCount observes the tool call.
      }

      const streamConfig = streamTextMock.mock.calls[0][0] as any;
      // Compaction summarizes via completeText(), i.e. the next streamText call.
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'compacted' };
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
      }));
      const prepared = await streamConfig.prepareStep({
        messages: [
          { role: 'system', content: 'old system context' },
          { role: 'user', content: 'old user context' },
          { role: 'assistant', content: 'old middle 1' },
          { role: 'user', content: 'old middle 2' },
          { role: 'assistant', content: 'recent assistant context 1' },
          { role: 'tool', content: [{ type: 'tool-result', output: 'recent tool context' }] },
          { role: 'user', content: 'recent user context 2' },
        ],
      });

      // Head (system + original task) preserved, middle folded into a user-role
      // summary, recent tail kept intact.
      expect(prepared.messages).toHaveLength(6);
      expect(prepared.messages[0]).toEqual({ role: 'system', content: 'old system context' });
      expect(prepared.messages[1]).toEqual({ role: 'user', content: 'old user context' });
      expect(prepared.messages[2]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('[Context Summary]\ncompacted\n[End Summary]'),
      });
      expect(prepared.messages.slice(3)).toEqual([
        { role: 'assistant', content: 'recent assistant context 1' },
        { role: 'tool', content: [{ type: 'tool-result', output: 'recent tool context' }] },
        { role: 'user', content: 'recent user context 2' },
      ]);
    } finally {
      delete process.env.STEP_COMPACTION_MIN_TOKENS;
    }
  });

  it('persists oversized tool results while returning a bounded model-facing preview', async () => {
    process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = '60';
    const fullOutput = `head-${'x'.repeat(2000)}-tail`;
    const rawResult = { output: fullOutput, metadata: { exitCode: 0 } };
    const writeToolOutputArtifact = mock(async () => ({
      kind: 'tool-output' as const,
      path: 'session-1-agents-review/message-1/artifact/tool-output-verbose.json',
      absolutePath: '/tmp/tool-output-verbose.json',
      bytes: 256,
      originalChars: fullOutput.length,
    }));

    try {
      for await (const _ of executeAgentCore(
        {
          name: 'tool-output-artifacts',
          config: {
            model: 'demo:test',
          },
        } as any,
        {
          verbose: {
            description: 'Return verbose output',
            execute: mock(async () => rawResult),
          } as any,
        },
        {
          userMessage: 'Run verbose tool',
          systemMessages: [],
          maxSteps: 3,
          sessionManager: { writeToolOutputArtifact } as any,
          sessionID: 'session-1',
          agentId: 'agents/review',
          messageID: 'message-1',
        }
      )) {
        // Consume the stream.
      }

      const streamConfig = streamTextMock.mock.calls[0][0] as any;
      const result = await streamConfig.tools.verbose.execute({});

      expect(writeToolOutputArtifact).toHaveBeenCalledTimes(1);
      expect(writeToolOutputArtifact.mock.calls[0]).toEqual([
        'session-1',
        'agents/review',
        'message-1',
        'verbose',
        rawResult,
      ]);
      expect(result.output).toContain('chars truncated');
      expect(result.metadata.exitCode).toBe(0);
      expect(result.metadata.fullOutputArtifact).toMatchObject({
        kind: 'tool-output',
        path: 'session-1-agents-review/message-1/artifact/tool-output-verbose.json',
        bytes: 256,
        originalChars: fullOutput.length,
      });
      expect(result.metadata.fullOutputArtifact).not.toHaveProperty('absolutePath');
      expect(JSON.stringify(result)).not.toContain('/tmp/tool-output-verbose.json');
      expect(result.output.length).toBeLessThan(fullOutput.length);
    } finally {
      delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    }
  });
});
