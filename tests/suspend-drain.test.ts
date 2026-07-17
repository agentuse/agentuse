/**
 * Regression tests for agentuse-lab#165: the suspend race that ghost-posted
 * un-approved drafts.
 *
 * Mechanism under test: the model emits `await_human` and an effect tool call
 * in ONE assistant turn. The AI SDK dispatches both executes eagerly; the gate
 * throws SuspendSignal. The old runner returned from the stream on the suspend
 * chunk, abandoning the sibling call: it still executed (posted to X) but was
 * never journaled anywhere.
 *
 * The fix (Phase 0) must guarantee, against the REAL AI SDK:
 *  1. the sibling execute is journaled in the effect WAL no matter what,
 *  2. the runner aborts the SDK so no further steps run after a gate registers,
 *  3. abort-respecting tools (bash) are actually killed before their effect,
 *  4. the suspension still surfaces (last chunk, with the gate's payload).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

// Disable the context manager: these tests exercise the suspend/drain path,
// not compaction (buildContextSnapshot is exercised by compaction tests).
process.env.CONTEXT_COMPACTION = 'false';

import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
}));

import { executeAgentCore } from '../src/runner/execution';
import { EffectWAL, EFFECT_WAL_FILENAME } from '../src/runner/effect-wal';
import { createAwaitHumanTool } from '../src/tools/await-human';
import { createBashTool } from '../src/tools/bash';
import type { AgentChunk } from '../src/runner/types';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallPart(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) };
}

function turn(parts: unknown[], finishReason = 'tool-calls') {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp', modelId: 'mock-model', timestamp: new Date(0) },
    ...parts,
    { type: 'finish', finishReason, usage: USAGE },
  ];
}

function makeModel(turns: unknown[][]): { model: MockLanguageModelV3; calls: () => number } {
  let count = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const parts = turns[Math.min(count, turns.length - 1)];
      count++;
      return { stream: convertArrayToReadableStream(parts as any) };
    },
  });
  return { model, calls: () => count };
}

const agent = {
  name: 'suspend-drain-test',
  description: 'test agent',
  instructions: 'test',
  config: { model: 'anthropic:mock-model', approval: true },
} as any;

async function runCore(tools: Record<string, unknown>, effectWal: EffectWAL): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  const generator = executeAgentCore(agent, tools as any, {
    userMessage: 'go',
    systemMessages: [],
    maxSteps: 5,
    effectWal,
  });
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

function readWAL(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, EFFECT_WAL_FILENAME);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('suspend drain (agentuse-lab#165)', () => {
  let dir: string;
  let wal: EffectWAL;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suspend-drain-'));
    wal = new EffectWAL(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ghost scenario: sibling effect tool beside the gate is fully journaled and the run still suspends', async () => {
    const executed: string[] = [];
    const postTool = {
      description: 'simulates an irreversible external post (ignores abort, like birdc)',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }: { text: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        executed.push(text);
        return { output: 'posted' };
      },
    };

    const { model, calls } = makeModel([
      // Second turn would post AGAIN — it must never run.
      turn([
        toolCallPart('gate-1', 'await_human', { prompt: 'Approve this post?' }),
        toolCallPart('post-1', 'post_tool', { text: 'ghost draft v3' }),
      ]),
      turn([toolCallPart('post-2', 'post_tool', { text: 'second post' })]),
    ]);
    currentModel = model;

    const tools = {
      await_human: createAwaitHumanTool('test-session'),
      post_tool: postTool,
    };

    const chunks = await runCore(tools, wal);
    // Let the abort-ignoring execute settle so its WAL exit record lands.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The suspension surfaced, exactly once, as the final chunk.
    const suspendedChunks = chunks.filter((c) => c.type === 'suspended');
    expect(suspendedChunks).toHaveLength(1);
    expect(chunks[chunks.length - 1].type).toBe('suspended');
    expect(suspendedChunks[0].toolName).toBe('await_human');
    expect((suspendedChunks[0].toolResultRaw as any).kind).toBe('await_human');

    // The model was never called again after the gate registered.
    expect(calls()).toBe(1);
    expect(executed).toEqual(['ghost draft v3']);

    // The sibling call is visible in the yielded chunks (drained, not dropped).
    const siblingCall = chunks.find((c) => c.type === 'tool-call' && c.toolName === 'post_tool');
    expect(siblingCall).toBeDefined();

    // The WAL has the full ghost trail regardless of consumer behavior.
    const records = readWAL(dir);
    const events = records.map((r) => `${r.event}:${r.tool ?? r.gateTool ?? ''}`);
    expect(events).toContain('tool-start:post_tool');
    expect(events).toContain('tool-end:post_tool');
    expect(events).toContain('tool-suspend:await_human');
    expect(events).toContain('gate-registered:await_human');

    const suspendedRecord = records.find((r) => r.event === 'suspended');
    expect(suspendedRecord).toBeDefined();
    expect(suspendedRecord!.gateCallId).toBe('gate-1');
    const turnToolCalls = suspendedRecord!.turnToolCalls as Array<Record<string, unknown>>;
    expect(turnToolCalls.map((c) => c.callId).sort()).toEqual(['gate-1', 'post-1']);
  });

  test('real bash sibling is killed before its effect lands', async () => {
    const marker = path.join(dir, 'ghost-marker.txt');
    const { model, calls } = makeModel([
      turn([
        toolCallPart('gate-1', 'await_human', { prompt: 'Approve?' }),
        toolCallPart('bash-1', 'tools__bash', { command: `sleep 5 && touch ${marker}` }),
      ]),
    ]);
    currentModel = model;

    const tools = {
      await_human: createAwaitHumanTool('test-session'),
      tools__bash: createBashTool(
        { commands: ['sleep *', 'touch *'] },
        dir,
        { projectRoot: dir, effectAudit: wal }
      ),
    };

    const started = Date.now();
    const chunks = await runCore(tools, wal);
    const elapsed = Date.now() - started;

    // Suspension surfaced promptly — not after bash's 5s sleep.
    expect(chunks[chunks.length - 1].type).toBe('suspended');
    expect(elapsed).toBeLessThan(4000);
    expect(calls()).toBe(1);

    // The bash effect never happened, even after its original schedule.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.existsSync(marker)).toBe(false);

    const records = readWAL(dir);
    const spawn = records.find((r) => r.event === 'bash-spawn');
    const exit = records.find((r) => r.event === 'bash-exit');
    // No effect escaped, by any of the layered defenses: the spawn was aborted
    // mid-run, the signal landed before spawn (bash-refused-aborted), or — since
    // the gate streams before the sibling here (gate-first order) — the #169
    // gate-rides-alone barrier denied it pre-dispatch so it never spawned. The
    // abort paths remain the coverage for the reverse order the barrier can't see.
    if (spawn) {
      expect(exit).toBeDefined();
      expect(exit!.aborted).toBe(true);
    } else {
      expect(
        records.some((r) => r.event === 'gate-barrier-denied' || r.event === 'bash-refused-aborted')
      ).toBe(true);
    }
  }, 15000);

  test('gate alone still suspends cleanly (no siblings, no postSuspend chunks)', async () => {
    const { model, calls } = makeModel([
      turn([toolCallPart('gate-1', 'await_human', { prompt: 'Approve?' })]),
    ]);
    currentModel = model;

    const chunks = await runCore({ await_human: createAwaitHumanTool('test-session') }, wal);

    expect(chunks[chunks.length - 1].type).toBe('suspended');
    expect(chunks[chunks.length - 1].toolCallId).toBe('gate-1');
    expect(chunks.some((c) => c.postSuspend)).toBe(false);
    expect(calls()).toBe(1);

    const records = readWAL(dir);
    expect(records.some((r) => r.event === 'gate-registered')).toBe(true);
    expect(records.some((r) => r.event === 'suspended')).toBe(true);
  });

  test('normal multi-step run is unaffected by the always-on abort signal', async () => {
    const executed: string[] = [];
    const workTool = {
      description: 'does some work',
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }: { what: string }) => {
        executed.push(what);
        return { output: `did ${what}` };
      },
    };

    const { model, calls } = makeModel([
      turn([toolCallPart('work-1', 'work_tool', { what: 'step one' })]),
      turn([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'all done' },
        { type: 'text-end', id: 't1' },
      ], 'stop'),
    ]);
    currentModel = model;

    const chunks = await runCore({ work_tool: workTool }, wal);

    expect(calls()).toBe(2);
    expect(executed).toEqual(['step one']);
    expect(chunks.some((c) => c.type === 'suspended')).toBe(false);
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('all done');
    const finishes = chunks.filter((c) => c.type === 'finish');
    expect(finishes.length).toBeGreaterThan(0);

    const records = readWAL(dir);
    expect(records.some((r) => r.event === 'tool-start' && r.tool === 'work_tool')).toBe(true);
    expect(records.some((r) => r.event === 'tool-end' && r.tool === 'work_tool')).toBe(true);
  });

  test('caller abort still works (external cancellation unchanged)', async () => {
    const slowTool = {
      description: 'slow tool',
      inputSchema: z.object({}),
      execute: async (_input: unknown, options?: { abortSignal?: AbortSignal }) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          options?.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
        return { output: 'done' };
      },
    };

    const { model } = makeModel([
      turn([toolCallPart('slow-1', 'slow_tool', {})]),
    ]);
    currentModel = model;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const chunks: AgentChunk[] = [];
    const started = Date.now();
    const generator = executeAgentCore(agent, { slow_tool: slowTool } as any, {
      userMessage: 'go',
      systemMessages: [],
      maxSteps: 5,
      abortSignal: controller.signal,
      effectWal: wal,
    });
    for await (const chunk of generator) {
      chunks.push(chunk);
    }
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(chunks.some((c) => c.type === 'suspended')).toBe(false);
  }, 10000);
});
