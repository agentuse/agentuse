/**
 * Stall watchdog on model streams.
 *
 * Production incident (2026-09-08): a model call opened a stream and emitted
 * nothing for ~400s. Only the session timeout stopped it, and the run reported
 * a generic "execution timeout or manual cancellation". These tests pin the
 * watchdog: a silent model step is aborted per attempt, retried from its
 * checkpoint while that step has produced nothing, and finally reported with
 * a message that names the stall.
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
import { completeText } from '../src/complete-text';
import {
  createStallWatchdog,
  modelStallRetryDelayMs,
  ModelStreamStallError,
  resolveModelStallPolicy,
} from '../src/runner/model-stall';
import type { AgentChunk } from '../src/runner/types';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const ENV_VAR = 'AGENTUSE_MODEL_IDLE_TIMEOUT';
const RETRY_DELAY_ENV_VAR = 'AGENTUSE_MODEL_STALL_RETRY_BASE_DELAY';
let savedEnv: string | undefined;
let savedRetryDelayEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_VAR];
  savedRetryDelayEnv = process.env[RETRY_DELAY_ENV_VAR];
  process.env[RETRY_DELAY_ENV_VAR] = '0';
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
  if (savedRetryDelayEnv === undefined) delete process.env[RETRY_DELAY_ENV_VAR];
  else process.env[RETRY_DELAY_ENV_VAR] = savedRetryDelayEnv;
});

/** A stream that emits `parts`, then goes silent until the attempt is aborted. */
function stallingStream(parts: unknown[], signal: AbortSignal | undefined) {
  return new ReadableStream<any>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      for (const part of parts) controller.enqueue(part);
      const end = () => {
        try {
          controller.close();
        } catch {
          // Already closed by the SDK's own abort handling.
        }
      };
      if (!signal) return;
      if (signal.aborted) end();
      else signal.addEventListener('abort', end, { once: true });
    },
  });
}

function stallingModel(parts: unknown[] = []): { model: MockLanguageModelV3; calls: () => number } {
  let count = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options: any) => {
      count++;
      return { stream: stallingStream(parts, options?.abortSignal) };
    },
  });
  return { model, calls: () => count };
}

const agent = {
  name: 'idle-timeout-test',
  description: 'test agent',
  instructions: 'test',
  config: { model: 'anthropic:mock-model' },
} as any;

async function runCore(abortSignal?: AbortSignal): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  const generator = executeAgentCore(agent, {} as any, {
    userMessage: 'go',
    systemMessages: [],
    maxSteps: 5,
    ...(abortSignal && { abortSignal }),
  });
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

function errorMessages(chunks: AgentChunk[]): string[] {
  return chunks
    .filter((chunk) => chunk.type === 'error')
    .map((chunk) => ((chunk as { error: unknown }).error as Error)?.message ?? '');
}

describe('resolveModelStallPolicy', () => {
  test('uses five minutes for a generic model call', () => {
    expect(resolveModelStallPolicy({ modelString: 'anthropic:claude-haiku', env: {} })).toEqual({
      firstProgressMs: 300_000,
      idleMs: 300_000,
      hardTimeoutMs: 1_500_000,
    });
  });

  test('gives high reasoning six minutes, or nine minutes above 50k tokens', () => {
    expect(resolveModelStallPolicy({
      modelString: 'openai:gpt-5.6-sol', reasoning: 'high', contextTokens: 50_000, env: {},
    }).firstProgressMs).toBe(600_000);
    expect(resolveModelStallPolicy({
      modelString: 'openai:gpt-5.6-sol', reasoning: 'high', contextTokens: 50_001, env: {},
    }).firstProgressMs).toBe(900_000);
  });

  test('treats Codex OAuth as reasoning and preserves the explicit legacy override', () => {
    expect(resolveModelStallPolicy({
      modelString: 'openai:gpt-5.6-sol', codexBackend: true, contextTokens: 80_000, env: {},
    }).firstProgressMs).toBe(900_000);
    expect(resolveModelStallPolicy({
      modelString: 'openai:gpt-5.6-sol', codexBackend: true,
      env: { [ENV_VAR]: '42' },
    })).toEqual({ firstProgressMs: 42_000, idleMs: 42_000, hardTimeoutMs: 0 });
    expect(resolveModelStallPolicy({
      modelString: 'openai:gpt-5.6-sol', env: { [ENV_VAR]: '0' },
    })).toEqual({ firstProgressMs: 0, idleMs: 0, hardTimeoutMs: 0 });
  });

  test('ignores an invalid legacy override', () => {
    expect(resolveModelStallPolicy({
      modelString: 'anthropic:claude-haiku', env: { [ENV_VAR]: 'soon' },
    }).idleMs).toBe(300_000);
  });

  test('uses capped exponential retry delays', () => {
    expect(modelStallRetryDelayMs(1, {})).toBe(2_000);
    expect(modelStallRetryDelayMs(2, {})).toBe(4_000);
    expect(modelStallRetryDelayMs(9, {})).toBe(60_000);
  });
});

describe('createStallWatchdog', () => {
  test('aborts its own signal after the idle window', async () => {
    const watchdog = createStallWatchdog(30);
    await Bun.sleep(80);
    expect(watchdog.stalled).toBe(true);
    expect(watchdog.signal.aborted).toBe(true);
    expect((watchdog.signal.reason as Error).name).toBe('ModelStreamStallError');
    watchdog.dispose();
  });

  test('notify() re-arms, and a disabled watchdog never fires', async () => {
    const active = createStallWatchdog(60);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(25);
      active.notify();
    }
    expect(active.stalled).toBe(false);
    active.dispose();

    const disabled = createStallWatchdog(0);
    await Bun.sleep(60);
    expect(disabled.stalled).toBe(false);
    expect(disabled.signal.aborted).toBe(false);
  });

  test('keeps the long first-progress budget until substantive progress arrives', async () => {
    const watchdog = createStallWatchdog({ firstProgressMs: 100, idleMs: 30, hardTimeoutMs: 0 });
    await Bun.sleep(45);
    watchdog.notify(false);
    await Bun.sleep(45);
    expect(watchdog.stalled).toBe(false);

    watchdog.notify(true);
    await Bun.sleep(60);
    expect(watchdog.stalled).toBe(true);
    expect(watchdog.failure?.phase).toBe('idle');
    watchdog.dispose();
  });

  test('enforces a per-step hard ceiling and resets it at the next step', async () => {
    const policy = { firstProgressMs: 200, idleMs: 200, hardTimeoutMs: 80 };
    const watchdog = createStallWatchdog(policy);
    await Bun.sleep(45);
    watchdog.beginStep(policy);
    await Bun.sleep(45);
    expect(watchdog.stalled).toBe(false);
    await Bun.sleep(55);
    expect(watchdog.stalled).toBe(true);
    expect(watchdog.failure?.phase).toBe('hard-limit');
    watchdog.dispose();
  });

  test('pause() excludes tool execution from the model-idle window', async () => {
    const watchdog = createStallWatchdog(40);
    watchdog.pause();
    await Bun.sleep(100);
    expect(watchdog.stalled).toBe(false);
    expect(watchdog.signal.aborted).toBe(false);

    watchdog.resume();
    await Bun.sleep(80);
    expect(watchdog.stalled).toBe(true);
    watchdog.dispose();
  });

  test('an upstream abort passes through without being called a stall', () => {
    const upstream = new AbortController();
    const watchdog = createStallWatchdog(0, upstream.signal);
    upstream.abort();
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.stalled).toBe(false);
    watchdog.dispose();
  });
});

describe('agent loop stall handling', () => {
  test('a long tool call does not count as a stalled model stream', async () => {
    process.env[ENV_VAR] = '0.05';
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream((calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'slow-1', toolName: 'slow_tool', input: '{}' },
                { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text-1' },
                { type: 'text-delta', id: 'text-1', delta: 'done' },
                { type: 'text-end', id: 'text-1' },
                { type: 'finish', finishReason: 'stop', usage: USAGE },
              ]) as any),
        };
      },
    });

    const chunks: AgentChunk[] = [];
    const generator = executeAgentCore(agent, {
      slow_tool: {
        description: 'slow test tool',
        inputSchema: z.object({}),
        execute: async () => {
          await Bun.sleep(140);
          return 'ok';
        },
      },
    } as any, {
      userMessage: 'go',
      systemMessages: [],
      maxSteps: 5,
    });
    for await (const chunk of generator) chunks.push(chunk);

    expect(calls).toBe(2);
    expect(errorMessages(chunks)).toEqual([]);
  });

  test('a silent later model step retries from its checkpoint without replaying completed tools', async () => {
    process.env[ENV_VAR] = '0.15';
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
        if (modelCalls === 2) {
          return { stream: stallingStream([], options?.abortSignal) };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'recovered' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ] as any),
        };
      },
    });

    const chunks: AgentChunk[] = [];
    const generator = executeAgentCore(agent, {
      checkpoint_tool: {
        description: 'checkpoint test tool',
        inputSchema: z.object({}),
        execute: async () => {
          toolCalls++;
          return 'settled result';
        },
      },
    } as any, {
      userMessage: 'go',
      systemMessages: [],
      maxSteps: 5,
    });
    for await (const chunk of generator) chunks.push(chunk);

    expect(modelCalls).toBe(3);
    expect(toolCalls).toBe(1);
    expect(errorMessages(chunks)).toEqual([]);
    expect(JSON.stringify(prompts[2])).toContain('settled result');
    expect(chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text).join('')).toBe('recovered');
    const finalUsage = chunks.filter((chunk) => chunk.type === 'finish').at(-1)?.usage;
    expect(finalUsage?.inputTokens).toBe(20);
    expect(finalUsage?.outputTokens).toBe(10);
  });

  test('a silent stream is retried, then fails naming the stall', async () => {
    process.env[ENV_VAR] = '0.5';
    const { model, calls } = stallingModel();
    currentModel = model;

    const chunks = await runCore();

    expect(calls()).toBe(3);
    const messages = errorMessages(chunks);
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatch(/^Model stream stalled: no model progress for \d+s \(3 attempts\)$/);
  });

  test('a reasoning-only stall retries because no visible output or tool call was committed', async () => {
    process.env[ENV_VAR] = '0.15';
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async (options: any) => {
        calls++;
        if (calls < 3) {
          return {
            stream: stallingStream([
              { type: 'reasoning-start', id: `reasoning-${calls}` },
              { type: 'reasoning-delta', id: `reasoning-${calls}`, delta: `attempt ${calls}` },
            ], options?.abortSignal),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'recovered' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ] as any),
        };
      },
    });

    const chunks = await runCore();

    expect(calls).toBe(3);
    expect(errorMessages(chunks)).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text).join('')).toBe('recovered');
  });

  test('a stall after the model produced output is not retried', async () => {
    process.env[ENV_VAR] = '0.3';
    const { model, calls } = stallingModel([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'partial answer' },
    ]);
    currentModel = model;

    const chunks = await runCore();

    expect(calls()).toBe(1);
    const messages = errorMessages(chunks);
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatch(/^Model stream stalled: no output for \d+s \(1 attempt\)$/);
  });

  test('a stream that keeps emitting under the limit is left alone', async () => {
    process.env[ENV_VAR] = '0.4';
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: new ReadableStream<any>({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              for (let i = 0; i < 4; i++) {
                await Bun.sleep(120);
                controller.enqueue({ type: 'text-delta', id: 'text-1', delta: `chunk ${i} ` });
              }
              controller.enqueue({ type: 'text-end', id: 'text-1' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
              controller.close();
            },
          }),
        };
      },
    });

    const chunks = await runCore();

    expect(calls).toBe(1);
    expect(errorMessages(chunks)).toEqual([]);
    const text = chunks
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => (chunk as { text?: string }).text ?? '')
      .join('');
    expect(text).toContain('chunk 3');
  });

  test('AGENTUSE_MODEL_IDLE_TIMEOUT=0 disables the watchdog', async () => {
    process.env[ENV_VAR] = '0';
    let calls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        calls++;
        return {
          stream: new ReadableStream<any>({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              // Longer than any of the enabled windows used above.
              await Bun.sleep(600);
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
              controller.close();
            },
          }),
        };
      },
    });

    const chunks = await runCore();

    expect(calls).toBe(1);
    expect(errorMessages(chunks)).toEqual([]);
  });

  test('a caller abort is still reported as an abort, not a stall', async () => {
    process.env[ENV_VAR] = '30';
    const { model } = stallingModel();
    currentModel = model;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const chunks = await runCore(controller.signal);

    const messages = errorMessages(chunks);
    expect(messages.length).toBe(1);
    expect(messages[0]).not.toMatch(/stalled/);
    expect(messages[0]).toMatch(/aborted|cancel/i);
  });
});

describe('completeText stall handling', () => {
  test('throws an error naming the stall', async () => {
    const { model, calls } = stallingModel();
    currentModel = model;

    await expect(
      completeText('anthropic:mock-model', {
        instructions: 'you are a helper',
        prompt: 'summarize',
        idleTimeoutMs: 120,
        maxRetries: 0,
      })
    ).rejects.toThrow(/^Model stream stalled: no model progress for \d+s$/);
    expect(calls()).toBe(1);
  });

  test('a stall error is a ModelStreamStallError', async () => {
    const { model } = stallingModel();
    currentModel = model;

    const error = await completeText('anthropic:mock-model', {
      instructions: 'you are a helper',
      prompt: 'summarize',
      idleTimeoutMs: 120,
      maxRetries: 0,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ModelStreamStallError);
  });

  test('a normal stream still completes', async () => {
    currentModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'hello' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: 'stop', usage: USAGE },
        ] as any),
      }),
    });

    const text = await completeText('anthropic:mock-model', {
      instructions: 'you are a helper',
      prompt: 'greet',
      idleTimeoutMs: 5_000,
      maxRetries: 0,
    });

    expect(text).toBe('hello');
  });
});
