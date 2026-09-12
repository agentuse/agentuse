/**
 * Black-box invariants for failures before the tool effect boundary.
 *
 * Model-supplied input errors must become model-visible tool results, whether
 * the provider transport catches them or canonical validation catches them in
 * toolApproval. They must never terminate the session, execute the tool, or
 * leave approval-input state behind.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import * as aiSdk from 'ai';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';

process.env.CONTEXT_COMPACTION = 'false';
process.env.AGENTUSE_CODE_MODE = '0';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
}));

import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { executeAgentCore } from '../src/runner/execution';
import { APPROVAL_INPUT_LEDGER_DIR } from '../src/runner/approval-input-ledger';
import { EffectWAL, EFFECT_WAL_FILENAME } from '../src/runner/effect-wal';
import { createAwaitHumanTool } from '../src/tools/await-human';
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

function stopTurn() {
  return turn([
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
  ], 'stop');
}

function makeModel(turns: unknown[][]): {
  model: MockLanguageModelV3;
  calls: () => number;
  promptAt: (index: number) => unknown;
} {
  let count = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options: any) => {
      prompts.push(options.prompt);
      const parts = turns[Math.min(count, turns.length - 1)];
      count++;
      return { stream: convertArrayToReadableStream(parts as any) };
    },
  });
  return { model, calls: () => count, promptAt: index => prompts[index] };
}

function deferredRuntimeSchema(runtimeInputSchema: aiSdk.Tool['inputSchema']): aiSdk.Tool['inputSchema'] {
  const runtime = aiSdk.asSchema(runtimeInputSchema);
  return aiSdk.jsonSchema({ type: 'object' }, {
    // Refinements and historical snapshots can make the provider-facing
    // contract weaker than the canonical runtime validator.
    validate: value => runtime.validate!(value),
  });
}

function priorCommentHistory(): ModelMessage[] {
  return [
    { role: 'user', content: 'Prepare the draft.' },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'prior-gate',
        toolName: 'await_human',
        input: { prompt: 'Approve the first draft?' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'prior-gate',
        toolName: 'await_human',
        output: { type: 'json', value: { status: 'comment', comment: 'Revise the ending.' } },
      }],
    },
  ] as ModelMessage[];
}

describe('pre-effect failure recovery', () => {
  let projectRoot: string;
  let sessionManager: SessionManager;
  let sessionID: string;
  let sessionDir: string;
  let wal: EffectWAL;
  const agentId = 'agents/pre-effect-recovery';
  const agent = {
    name: 'pre-effect-recovery',
    config: { model: 'anthropic:mock-model' },
  } as any;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'pre-effect-recovery-'));
    process.env.XDG_DATA_HOME = projectRoot;
    await initStorage(projectRoot);
    sessionManager = new SessionManager();
    sessionID = await sessionManager.createSession({
      agent: { id: agentId, name: 'pre-effect-recovery', isSubAgent: false },
      model: 'anthropic:mock-model',
      version: 'test',
      config: {},
      project: { root: projectRoot, cwd: projectRoot },
    });
    sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    wal = new EffectWAL(sessionDir);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    delete process.env.XDG_DATA_HOME;
  });

  async function runCore(
    tools: Record<string, unknown>,
    options: { messages?: ModelMessage[]; pluginEvents?: any } = {},
  ): Promise<AgentChunk[]> {
    const chunks: AgentChunk[] = [];
    for await (const chunk of executeAgentCore(agent, tools as any, {
      userMessage: 'Run the action.',
      systemMessages: [],
      maxSteps: 5,
      sessionManager,
      sessionID,
      agentId,
      effectWal: wal,
      ...(options.messages && { messages: options.messages }),
      ...(options.pluginEvents && { pluginEvents: options.pluginEvents }),
    })) chunks.push(chunk);
    return chunks;
  }

  function records(): Array<Record<string, unknown>> {
    const file = path.join(sessionDir, EFFECT_WAL_FILENAME);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
  }

  function expectNoApprovalResidue(): void {
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.readdirSync(ledgerDir).filter(
      name => name.endsWith('.json') || name.endsWith('.lock')
    )).toHaveLength(0);
  }

  function deniedResult(chunks: AgentChunk[], callId: string): AgentChunk | undefined {
    return chunks.find(chunk => chunk.type === 'tool-result' && chunk.toolCallId === callId);
  }

  test('returns a deferred semantic refinement failure to the model for correction', async () => {
    const runtimeSchema = z.object({
      response: z.string(),
      reference: z.object({ author: z.string(), excerpt: z.string() }).optional(),
    }).superRefine((value, context) => {
      if (!value.reference) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reference'],
          message: 'the complete original is required for a response',
        });
      }
    });
    const execute = mock(async (input: unknown) => input);
    const corrected = {
      response: 'A useful response.',
      reference: { author: '@someone', excerpt: 'The complete original.' },
    };
    const { model, calls, promptAt } = makeModel([
      turn([toolCallPart('semantic-invalid', 'respond', { response: 'A useful response.' })]),
      turn([toolCallPart('semantic-valid', 'respond', corrected)]),
      stopTurn(),
    ]);
    currentModel = model;

    const chunks = await runCore({
      respond: { inputSchema: deferredRuntimeSchema(runtimeSchema), execute },
    });

    expect(calls()).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(corrected);
    expect(deniedResult(chunks, 'semantic-invalid')).toMatchObject({
      toolSuccess: false,
      toolResultRaw: { success: false, denied: true },
    });
    expect(deniedResult(chunks, 'semantic-invalid')?.toolResultRaw.reason)
      .toContain('the complete original is required for a response');
    expect(JSON.stringify(promptAt(1))).toContain('the complete original is required for a response');
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'semantic-invalid')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'semantic-valid')).toBe(true);
    expectNoApprovalResidue();
  });

  test('recovers the empty await_human placeholders emitted after a resumed comment', async () => {
    const inputSchema = deferredRuntimeSchema(createAwaitHumanTool().inputSchema);
    const execute = mock(async (input: unknown) => input);
    const corrected = {
      prompt: 'Approve publishing this revised note?',
      changes: [{ label: 'Publish Note', content: 'A useful note.' }],
      risk: 'This posts publicly.',
    };
    const { model, calls, promptAt } = makeModel([
      turn([toolCallPart('placeholders-invalid', 'review', {
        prompt: 'Approve publishing this revised note?',
        changes: [{ label: 'Publish Note', content: 'A useful note.', optionId: '' }],
        reference: { label: '', author: '', title: '', url: '', excerpt: '' },
        draft_url: '',
        artifact_url: '',
        options: [],
      })]),
      turn([toolCallPart('placeholders-valid', 'review', corrected)]),
      stopTurn(),
    ]);
    currentModel = model;

    const chunks = await runCore(
      { review: { inputSchema, execute } },
      { messages: priorCommentHistory() },
    );

    expect(calls()).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(corrected);
    const denied = deniedResult(chunks, 'placeholders-invalid');
    expect(denied).toMatchObject({
      toolSuccess: false,
      toolResultRaw: { success: false, denied: true },
    });
    expect(denied?.toolResultRaw.reason).toContain('String must contain at least 1 character');
    expect(denied?.toolResultRaw.reason).toContain('Invalid url');
    expect(denied?.toolResultRaw.reason).toContain('Array must contain at least 2 element');
    expect(denied?.toolResultRaw.reason)
      .toContain('reference.excerpt is required whenever reference is present');
    expect(JSON.stringify(promptAt(1)))
      .toContain('reference.excerpt is required whenever reference is present');
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'placeholders-invalid')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'placeholders-valid')).toBe(true);
    expectNoApprovalResidue();
  });

  test('keeps native transport validation failures inside the model loop', async () => {
    const execute = mock(async (input: unknown) => input);
    const corrected = { count: 1 };
    const { model, calls, promptAt } = makeModel([
      turn([toolCallPart('structural-invalid', 'count', { count: 0 })]),
      turn([toolCallPart('structural-valid', 'count', corrected)]),
      stopTurn(),
    ]);
    currentModel = model;

    const chunks = await runCore({
      count: { inputSchema: z.object({ count: z.number().min(1) }), execute },
    });

    expect(calls()).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(corrected);
    const failure = deniedResult(chunks, 'structural-invalid');
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.toolResultRaw)).toContain('count');
    expect(JSON.stringify(promptAt(1))).toContain('count');
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'structural-invalid')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'structural-valid')).toBe(true);
    expectNoApprovalResidue();
  });

  test('returns plugin-mutated invalid input without executing or retaining approval state', async () => {
    const execute = mock(async (input: unknown) => input);
    const corrected = { value: 'corrected' };
    const { model, calls, promptAt } = makeModel([
      turn([toolCallPart('plugin-invalid', 'write', { value: 'draft' })]),
      turn([toolCallPart('plugin-valid', 'write', corrected)]),
      stopTurn(),
    ]);
    currentModel = model;
    const pluginCalls: string[] = [];

    const chunks = await runCore({
      write: { inputSchema: z.object({ value: z.string().min(1) }), execute },
    }, {
      pluginEvents: {
        toolCall: async (event: any) => {
          pluginCalls.push(event.toolCallId);
          if (event.toolCallId === 'plugin-invalid') event.input.value = '';
          return {};
        },
      },
    });

    expect(calls()).toBe(3);
    expect(pluginCalls).toEqual(['plugin-invalid', 'plugin-valid']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(corrected);
    expect(deniedResult(chunks, 'plugin-invalid')).toMatchObject({
      toolSuccess: false,
      toolResultRaw: { success: false, denied: true },
    });
    expect(deniedResult(chunks, 'plugin-invalid')?.toolResultRaw.reason)
      .toContain('String must contain at least 1 character');
    expect(JSON.stringify(promptAt(1))).toContain('String must contain at least 1 character');
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'plugin-invalid')).toBe(false);
    expect(records().some(record => record.event === 'tool-start' && record.callId === 'plugin-valid')).toBe(true);
    expectNoApprovalResidue();
  });
});
