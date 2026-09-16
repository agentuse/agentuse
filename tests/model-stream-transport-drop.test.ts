/**
 * Transport drops under a live model stream.
 *
 * Production incident (2026-09-09): quora-engage-answer died 26s into a
 * reasoning segment with the bare message "terminated" -- undici's signal that
 * the response socket was cut mid-stream. The daemon had not restarted and the
 * worker outlived the run by two hours, so nothing local was at fault; the SDK
 * simply does not retry a stream that has already opened. 17 runs across 8
 * agents ended this way in eight weeks. These tests pin the recovery: retry the
 * active step from its checkpoint while it has committed nothing, never replay
 * a settled tool, and fail with a message that names the drop once the budget
 * is spent.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

process.env.CONTEXT_COMPACTION = 'false';

import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
}));

import { executeAgentCore } from '../src/runner/execution';
import {
  isModelStreamTransportDrop,
  ModelStreamStallError,
  ModelStreamTransportError,
} from '../src/runner/model-stall';
import type { AgentChunk } from '../src/runner/types';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const RETRY_DELAY_ENV_VAR = 'AGENTUSE_MODEL_STALL_RETRY_BASE_DELAY';
let savedRetryDelayEnv: string | undefined;

beforeEach(() => {
  savedRetryDelayEnv = process.env[RETRY_DELAY_ENV_VAR];
  process.env[RETRY_DELAY_ENV_VAR] = '0';
});

afterEach(() => {
  if (savedRetryDelayEnv === undefined) delete process.env[RETRY_DELAY_ENV_VAR];
  else process.env[RETRY_DELAY_ENV_VAR] = savedRetryDelayEnv;
});

/** The exact shape undici produces when a response body is cut mid-stream. */
function undiciTerminated(): TypeError {
  const cause = Object.assign(new Error('other side closed'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET',
  });
  return Object.assign(new TypeError('terminated'), { cause });
}

/**
 * A stream that emits `parts`, then dies the way a cut socket does.
 *
 * The pause matters: on the wire those parts arrived seconds before the drop,
 * so the consumer has already seen them and knows whether the step committed
 * anything. Erroring in the same tick would race that and make every drop look
 * like it happened before the first byte.
 */
function droppingStream(parts: unknown[]) {
  return new ReadableStream<any>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      for (const part of parts) controller.enqueue(part);
      await Bun.sleep(20);
      controller.error(undiciTerminated());
    },
  });
}

function completionStream(text: string) {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: 'stop', usage: USAGE },
  ] as any);
}

const agent = {
  name: 'transport-drop-test',
  description: 'test agent',
  instructions: 'test',
  config: { model: 'anthropic:mock-model' },
} as any;

async function runCore(tools: Record<string, unknown> = {}): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  const generator = executeAgentCore(agent, tools as any, {
    userMessage: 'go',
    systemMessages: [],
    maxSteps: 5,
  });
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

function errorMessages(chunks: AgentChunk[]): string[] {
  return chunks
    .filter((chunk) => chunk.type === 'error')
    .map((chunk) => ((chunk as { error: unknown }).error as Error)?.message ?? '');
}

function textOf(chunks: AgentChunk[]): string {
  return chunks.filter((chunk) => chunk.type === 'text').map((chunk) => (chunk as { text: string }).text).join('');
}

describe('isModelStreamTransportDrop', () => {
  test('claims undici terminated and its socket cause', () => {
    expect(isModelStreamTransportDrop(undiciTerminated())).toBe(true);
    expect(isModelStreamTransportDrop(new TypeError('terminated'))).toBe(true);
  });

  test('claims socket codes reported without a recognizable message', () => {
    expect(isModelStreamTransportDrop(Object.assign(new Error('read failure'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isModelStreamTransportDrop(new Error('socket hang up'))).toBe(true);
    expect(isModelStreamTransportDrop(new Error('Premature close'))).toBe(true);
  });

  test('finds a drop wrapped by an SDK error', () => {
    const wrapped = Object.assign(new Error('Cannot connect to API'), {
      name: 'AI_APICallError',
      cause: undiciTerminated(),
    });
    expect(isModelStreamTransportDrop(wrapped)).toBe(true);
  });

  test('leaves cancellation and stalls to their own paths', () => {
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(isModelStreamTransportDrop(aborted)).toBe(false);
    expect(isModelStreamTransportDrop(new ModelStreamStallError(300_000))).toBe(false);
    const abortedSocket = Object.assign(new Error('terminated'), {
      name: 'AbortError',
      code: 'UND_ERR_ABORTED',
    });
    expect(isModelStreamTransportDrop(abortedSocket)).toBe(false);
  });

  test('leaves real model verdicts alone', () => {
    expect(isModelStreamTransportDrop(new Error('Bad Request'))).toBe(false);
    expect(isModelStreamTransportDrop(new Error('context_length_exceeded'))).toBe(false);
    expect(isModelStreamTransportDrop(new Error('the job was terminated by the operator'))).toBe(false);
    expect(isModelStreamTransportDrop(undefined)).toBe(false);
  });

  test('survives a self-referential cause chain', () => {
    const looping: any = new Error('Bad Request');
    looping.cause = looping;
    expect(isModelStreamTransportDrop(looping)).toBe(false);
  });
});

describe('agent loop transport-drop handling', () => {
  test('a drop before any committed output retries and the run completes', async () => {
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        if (calls === 1) {
          return {
            stream: droppingStream([
              { type: 'reasoning-start', id: 'reasoning-1' },
              { type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking' },
            ]),
          };
        }
        return { stream: completionStream('recovered') };
      },
    });

    const chunks = await runCore();

    expect(calls).toBe(2);
    expect(errorMessages(chunks)).toEqual([]);
    expect(textOf(chunks)).toBe('recovered');
  });

  test('partial tool input is not committed before the tool call', async () => {
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        if (calls === 1) {
          return {
            stream: droppingStream([
              { type: 'reasoning-start', id: 'reasoning-1' },
              { type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking' },
              { type: 'tool-input-start', id: 'partial-1', toolName: 'partial_probe' },
              { type: 'tool-input-delta', id: 'partial-1', delta: '{"query":"par' },
            ]),
          };
        }
        return { stream: completionStream('recovered') };
      },
    });

    const chunks = await runCore({
      partial_probe: {
        description: 'partial input probe',
        inputSchema: z.object({ query: z.string().optional() }),
        execute: async () => 'never called',
      },
    });

    expect(calls).toBe(2);
    expect(errorMessages(chunks)).toEqual([]);
    expect(textOf(chunks)).toBe('recovered');
  });

  test('a drop after committed text fails without retrying', async () => {
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: droppingStream([
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'half an answer' },
          ]),
        };
      },
    });

    const chunks = await runCore();

    expect(calls).toBe(1);
    const messages = errorMessages(chunks);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe('Model stream connection dropped: terminated (1 attempt)');
  });

  test('repeated drops spend the budget, then fail naming the drop', async () => {
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return { stream: droppingStream([]) };
      },
    });

    const chunks = await runCore();

    expect(calls).toBe(3);
    const messages = errorMessages(chunks);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe('Model stream connection dropped: terminated (3 attempts)');
  });

  test('a drop in a later step resumes from its checkpoint without replaying a settled tool', async () => {
    const previousCodeMode = process.env.AGENTUSE_CODE_MODE;
    process.env.AGENTUSE_CODE_MODE = '0';
    try {
    let modelCalls = 0;
    let toolCalls = 0;
    const prompts: unknown[] = [];
    currentModel = new MockLanguageModelV3({
      doStream: async (options: any) => {
        modelCalls++;
        prompts.push(options.prompt);
        if (modelCalls === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'checkpoint-1', toolName: 'checkpoint_tool', input: '{}' },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ] as any),
          };
        }
        if (modelCalls === 2) return { stream: droppingStream([]) };
        return { stream: completionStream('recovered') };
      },
    });

    const chunks = await runCore({
      checkpoint_tool: {
        description: 'checkpoint test tool',
        inputSchema: z.object({}),
        execute: async () => {
          toolCalls++;
          return 'settled result';
        },
      },
    });

    expect(modelCalls).toBe(3);
    expect(toolCalls).toBe(1);
    expect(errorMessages(chunks)).toEqual([]);
    expect(JSON.stringify(prompts[2])).toContain('settled result');
    expect(textOf(chunks)).toBe('recovered');
    } finally {
      if (previousCodeMode === undefined) delete process.env.AGENTUSE_CODE_MODE;
      else process.env.AGENTUSE_CODE_MODE = previousCodeMode;
    }
  });

  test('a cancelled run still reports cancellation, not a transport retry', async () => {
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return { stream: droppingStream([]) };
      },
    });

    const controller = new AbortController();
    controller.abort();
    const chunks: AgentChunk[] = [];
    const generator = executeAgentCore(agent, {} as any, {
      userMessage: 'go',
      systemMessages: [],
      maxSteps: 5,
      abortSignal: controller.signal,
    });
    for await (const chunk of generator) chunks.push(chunk);

    expect(errorMessages(chunks).some((message) => message.includes('connection dropped'))).toBe(false);
  });
});

describe('ModelStreamTransportError', () => {
  test('names the underlying drop and the attempts spent', () => {
    expect(new ModelStreamTransportError('terminated', 1).message)
      .toBe('Model stream connection dropped: terminated (1 attempt)');
    expect(new ModelStreamTransportError('socket hang up', 3).message)
      .toBe('Model stream connection dropped: socket hang up (3 attempts)');
    expect(new ModelStreamTransportError('terminated').message)
      .toBe('Model stream connection dropped: terminated');
  });
});
