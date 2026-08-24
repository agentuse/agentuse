import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';

const createModelMock = mock(async (model: string) => ({ modelId: model }));
const streamTextMock = mock((_config: any): any => ({
  stream: (async function* () {
    yield { type: 'finish', finishReason: 'stop' };
  })(),
  response: Promise.resolve({ messages: [] }),
}));

mock.module('../src/models', () => ({
  createModel: createModelMock,
  AuthenticationError: class AuthenticationError extends Error {},
}));

mock.module('ai', () => ({
  streamText: streamTextMock,
  isStepCount: mock((steps: number) => ({ steps })),
  ...aiSdkErrorMocks(),
  APICallError: { isInstance: (error: any) => error?.__apiCallError === true },
}));

let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;
let resetModelCooldowns: typeof import('../src/runner/model-fallback').resetModelCooldowns;
let availableModelCandidates: typeof import('../src/runner/model-fallback').availableModelCandidates;
let markModelCooldown: typeof import('../src/runner/model-fallback').markModelCooldown;

beforeAll(async () => {
  ({ executeAgentCore } = await import('../src/runner/execution'));
  ({ resetModelCooldowns, availableModelCandidates, markModelCooldown } = await import('../src/runner/model-fallback'));
});

beforeEach(() => {
  createModelMock.mockClear();
  createModelMock.mockImplementation(async (model: string) => ({ modelId: model }));
  streamTextMock.mockReset();
  resetModelCooldowns();
});

function agent() {
  return {
    name: 'fallback-test',
    config: {
      model: 'anthropic:claude-opus-5',
      modelAlias: '@judgment',
      modelSource: 'user-alias',
      modelCandidates: ['anthropic:claude-opus-5', 'openai:gpt-5.6'],
      modelFallbackCooldownMs: 300_000,
    },
    instructions: 'Complete the task.',
  } as any;
}

const options = {
  userMessage: 'Complete the task.',
  systemMessages: [{ role: 'system', content: 'base system' }],
  maxSteps: 3,
};

async function drain(generator: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

describe('model alias fallback execution', () => {
  it('expires cooldowns and keeps them keyed by concrete model', () => {
    markModelCooldown('anthropic:claude-opus-5', 1_000, 10_000);
    expect(availableModelCandidates(
      ['anthropic:claude-opus-5', 'openai:gpt-5.6'],
      10_500
    )).toEqual(['openai:gpt-5.6']);
    expect(availableModelCandidates(
      ['anthropic:claude-opus-5', 'openai:gpt-5.6'],
      11_000
    )).toEqual(['anthropic:claude-opus-5', 'openai:gpt-5.6']);
  });

  it('falls back on a transient error before model output', async () => {
    streamTextMock
      .mockImplementationOnce(() => ({
        stream: (async function* () { yield { type: 'error', error: new Error('429 rate limit') }; })(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () {
          yield { type: 'text-delta', text: 'recovered' };
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        response: Promise.resolve({ messages: [] }),
      }));

    const runAgent = agent();
    const chunks = await drain(executeAgentCore(runAgent, {}, options));

    expect(createModelMock.mock.calls.map((call) => call[0])).toEqual([
      'anthropic:claude-opus-5',
      'openai:gpt-5.6',
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(0);
    expect(chunks.find((chunk) => chunk.type === 'text')?.text).toBe('recovered');
    expect(runAgent.config.model).toBe('openai:gpt-5.6');
    const fallbackConfig = streamTextMock.mock.calls[1][0] as any;
    expect(fallbackConfig.messages.some((message: any) =>
      message.content === "You are Claude Code, Anthropic's official CLI for Claude."
    )).toBe(false);
  });

  it('does not fall back after visible output', async () => {
    streamTextMock.mockImplementationOnce(() => ({
      stream: (async function* () {
        yield { type: 'text-delta', text: 'partial' };
        yield { type: 'error', error: new Error('503 unavailable') };
      })(),
    }));

    const chunks = await drain(executeAgentCore(agent(), {}, options));
    expect(createModelMock).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
  });

  it('does not fall back after a tool call', async () => {
    streamTextMock.mockImplementationOnce(() => ({
      stream: (async function* () {
        yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: {} };
        yield { type: 'error', error: new Error('503 unavailable') };
      })(),
    }));

    const chunks = await drain(executeAgentCore(agent(), { read_file: {} as any }, options));
    expect(createModelMock).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.type === 'tool-call')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
  });

  it('falls back when the first candidate has no usable credentials', async () => {
    const authError = new Error('No authentication found for Anthropic');
    authError.name = 'AuthenticationError';
    createModelMock.mockImplementationOnce(async () => { throw authError; });
    streamTextMock.mockImplementationOnce(() => ({
      stream: (async function* () {
        yield { type: 'text-delta', text: 'recovered' };
        yield { type: 'finish', finishReason: 'stop' };
      })(),
      response: Promise.resolve({ messages: [] }),
    }));

    const runAgent = agent();
    const chunks = await drain(executeAgentCore(runAgent, {}, options));

    expect(createModelMock.mock.calls.map((call) => call[0])).toEqual([
      'anthropic:claude-opus-5',
      'openai:gpt-5.6',
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(0);
    expect(chunks.find((chunk) => chunk.type === 'text')?.text).toBe('recovered');
    expect(runAgent.config.model).toBe('openai:gpt-5.6');
  });

  it('falls back when a stored OAuth token cannot be refreshed', async () => {
    const refreshError = new Error('Anthropic OAuth token refresh failed (HTTP 529)');
    refreshError.name = 'AnthropicRefreshFailed';
    createModelMock.mockImplementationOnce(async () => { throw refreshError; });
    streamTextMock.mockImplementationOnce(() => ({
      stream: (async function* () { yield { type: 'finish', finishReason: 'stop' }; })(),
      response: Promise.resolve({ messages: [] }),
    }));

    const runAgent = agent();
    await drain(executeAgentCore(runAgent, {}, options));

    expect(createModelMock.mock.calls.map((call) => call[0])).toEqual([
      'anthropic:claude-opus-5',
      'openai:gpt-5.6',
    ]);
    expect(runAgent.config.model).toBe('openai:gpt-5.6');
  });

  it('raises the auth error when no candidate can authenticate', async () => {
    const authError = new Error('No authentication found for Anthropic');
    authError.name = 'AuthenticationError';
    createModelMock.mockImplementation(async () => { throw authError; });

    await expect(drain(executeAgentCore(agent(), {}, options)))
      .rejects.toThrow('No authentication found for Anthropic');
    expect(createModelMock).toHaveBeenCalledTimes(2);
  });

  it('skips a cooling candidate on the next run', async () => {
    let call = 0;
    streamTextMock.mockImplementation(() => {
      call++;
      if (call === 1) {
        return {
          stream: (async function* () { yield { type: 'error', error: new Error('503 unavailable') }; })(),
        };
      }
      return {
        stream: (async function* () { yield { type: 'finish', finishReason: 'stop' }; })(),
        response: Promise.resolve({ messages: [] }),
      };
    });

    await drain(executeAgentCore(agent(), {}, options));
    createModelMock.mockClear();
    await drain(executeAgentCore(agent(), {}, options));

    expect(createModelMock.mock.calls.map((call) => call[0])).toEqual(['openai:gpt-5.6']);
  });

  it('persists the selected fallback model for session resume', async () => {
    streamTextMock
      .mockImplementationOnce(() => ({
        stream: (async function* () { yield { type: 'error', error: new Error('429 rate limit') }; })(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () { yield { type: 'finish', finishReason: 'stop' }; })(),
        response: Promise.resolve({ messages: [] }),
      }));
    const updateSession = mock(async () => {});
    const updateMessage = mock(async () => {});
    const sessionOptions = {
      ...options,
      sessionManager: {
        updateSession,
        updateMessage,
        getSessionDirectory: mock(async () => '/tmp/fallback-session'),
      } as any,
      sessionID: 'session-1',
      agentId: 'agent-1',
      messageID: 'message-1',
    };

    await drain(executeAgentCore(agent(), {}, sessionOptions));

    expect(updateSession.mock.calls.at(-1)?.[2]).toMatchObject({ model: 'openai:gpt-5.6' });
    expect(updateMessage.mock.calls.at(-1)?.[3]).toMatchObject({
      assistant: { modelID: 'openai:gpt-5.6', providerID: 'openai' },
    });
  });

  it('falls back after an approval resume before the resumed segment emits output', async () => {
    const forbidden = Object.assign(new Error('OAuth authentication is not allowed for this organization'), {
      __apiCallError: true,
      statusCode: 403,
      url: 'https://api.anthropic.com/v1/messages',
    });
    streamTextMock
      .mockImplementationOnce(() => ({
        stream: (async function* () { yield { type: 'error', error: forbidden }; })(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () {
          yield { type: 'text-delta', text: 'resumed on fallback' };
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        response: Promise.resolve({ messages: [] }),
      }));

    const resumedOptions = {
      ...options,
      messages: [
        {
          role: 'system',
          content: "You are Claude Code, Anthropic's official CLI for Claude.",
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        { role: 'user', content: 'Complete the task.' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'gate-1', toolName: 'await_human', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'gate-1', toolName: 'await_human', output: { type: 'json', value: { status: 'approved' } } }] },
      ] as any,
    };

    const chunks = await drain(executeAgentCore(agent(), {}, resumedOptions));

    expect(createModelMock.mock.calls.map((call) => call[0])).toEqual([
      'anthropic:claude-opus-5',
      'openai:gpt-5.6',
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(0);
    expect(chunks.find((chunk) => chunk.type === 'text')?.text).toBe('resumed on fallback');
    const fallbackMessages = (streamTextMock.mock.calls[1][0] as any).messages;
    expect(fallbackMessages.some((message: any) =>
      message.content === "You are Claude Code, Anthropic's official CLI for Claude."
    )).toBe(false);
    expect(fallbackMessages.some((message: any) => message.providerOptions?.anthropic)).toBe(false);
  });

  it('continues fallback forward from the model already selected for a resumed session', async () => {
    const runAgent = agent();
    runAgent.config.model = 'openai:gpt-5.6';
    runAgent.config.modelCandidates = [
      'anthropic:claude-opus-5',
      'openai:gpt-5.6',
      'google:gemini-3-pro',
    ];
    streamTextMock
      .mockImplementationOnce(() => ({
        stream: (async function* () { yield { type: 'error', error: new Error('503 unavailable') }; })(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () { yield { type: 'finish', finishReason: 'stop' }; })(),
        response: Promise.resolve({ messages: [] }),
      }));

    await drain(executeAgentCore(runAgent, {}, {
      ...options,
      messages: [{ role: 'user', content: 'Continue after approval.' }] as any,
    }));

    expect(createModelMock.mock.calls.map((call) => call[0])).toEqual([
      'openai:gpt-5.6',
      'google:gemini-3-pro',
    ]);
  });

  it('keeps an approval lease alive across candidate attempts, then revokes it after the segment', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'agentuse-fallback-lease-'));
    const leasePath = join(sessionDir, 'approval-lease.json');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(leasePath, JSON.stringify({
      version: 1,
      grantedAt: Date.now(),
      entries: [{ content: 'bash scripts/substack/ego.sh publish-note approved' }],
    }));
    let leasePresentDuringFallback = false;
    try {
      streamTextMock
        .mockImplementationOnce(() => ({
          stream: (async function* () { yield { type: 'error', error: new Error('503 unavailable') }; })(),
        }))
        .mockImplementationOnce(() => {
          leasePresentDuringFallback = existsSync(leasePath);
          return {
            stream: (async function* () { yield { type: 'finish', finishReason: 'stop' }; })(),
            response: Promise.resolve({ messages: [] }),
          };
        });
      const runAgent = agent();
      runAgent.config.tools = { bash: { gated: ['bash scripts/substack/ego.sh *'] } };

      await drain(executeAgentCore(runAgent, {}, {
        ...options,
        messages: [{ role: 'user', content: 'Continue after approval.' }] as any,
        sessionManager: {
          getSessionDirectory: mock(async () => sessionDir),
          updateSession: mock(async () => {}),
          updateMessage: mock(async () => {}),
        } as any,
        sessionID: 'session-lease',
        agentId: 'agent-lease',
        messageID: 'message-lease',
      }));

      expect(leasePresentDuringFallback).toBe(true);
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
