/**
 * Integration tests for lease-enforced effectful commands (agentuse-lab#165,
 * Phase 2) against the REAL AI SDK v7 `toolApproval` machinery.
 *
 * The permanent fix for the ghost-post class: commands matching human-authored
 * `tools.bash.gated` patterns are consulted against the lease derived from the latest
 * approved `await_human.changes[]` BEFORE the SDK dispatches execute. Uncovered
 * -> auto-denied with a redirect reason (the model re-gates); covered -> runs
 * with zero interruption. Unlike Phase 0's abort (a race the runtime usually
 * wins), denial is deterministic: the effect can never happen.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, rm } from 'fs/promises';

process.env.CONTEXT_COMPACTION = 'false';

import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
}));

import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { executeAgentCore } from '../src/runner/execution';
import { EffectWAL, EFFECT_WAL_FILENAME } from '../src/runner/effect-wal';
import { LeaseStore, LEASE_FILENAME } from '../src/runner/approval-lease';
import { createAwaitHumanTool } from '../src/tools/await-human';
import { maybeMockAwaitHuman } from '../src/runner/mock-tools';
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
  return { model, calls: () => count, promptAt: (index) => prompts[index] };
}

describe('lease enforcement (agentuse-lab#165 Phase 2)', () => {
  let projectRoot: string;
  let sessionManager: SessionManager;
  let sessionID: string;
  let sessionDir: string;
  let wal: EffectWAL;
  const agentId = 'agents/leased';

  const agent = {
    name: 'lease-test-agent',
    description: 'test agent',
    instructions: 'test',
    config: {
      model: 'anthropic:mock-model',
      approval: true,
      tools: { bash: { commands: ['touch *', 'echo *', 'birdc *'], gated: ['touch *', 'birdc reply *'] } },
    },
  } as any;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'lease-enforce-'));
    process.env.XDG_DATA_HOME = projectRoot;
    await initStorage(projectRoot);
    sessionManager = new SessionManager();
    sessionID = await sessionManager.createSession({
      agent: { id: agentId, name: 'leased', isSubAgent: false },
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

  function makeTools() {
    return {
      await_human: createAwaitHumanTool(sessionID),
      tools__bash: createBashTool(
        { commands: ['touch *', 'echo *', 'birdc *'] },
        projectRoot,
        { projectRoot, effectAudit: wal }
      ),
    };
  }

  async function runCore(tools: Record<string, unknown>): Promise<AgentChunk[]> {
    const chunks: AgentChunk[] = [];
    const generator = executeAgentCore(agent, tools as any, {
      userMessage: 'go',
      systemMessages: [],
      maxSteps: 5,
      sessionManager,
      sessionID,
      agentId,
      effectWal: wal,
    });
    for await (const chunk of generator) {
      chunks.push(chunk);
    }
    return chunks;
  }

  function readWAL(): Array<Record<string, unknown>> {
    const file = path.join(sessionDir, EFFECT_WAL_FILENAME);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  test('THE INCIDENT, replayed: effectful sibling beside the gate is denied deterministically - nothing posts', async () => {
    const marker = path.join(projectRoot, 'ghost-marker.txt');
    const { model, calls } = makeModel([
      turn([
        toolCallPart('gate-1', 'await_human', { prompt: 'Approve this reply?' }),
        toolCallPart('bash-1', 'tools__bash', { command: `touch ${marker}` }),
      ]),
    ]);
    currentModel = model;

    const chunks = await runCore(makeTools());
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Denied BEFORE execute: the effect never happened - no race, no kill
    // timing, deterministic.
    expect(fs.existsSync(marker)).toBe(false);
    expect(chunks[chunks.length - 1].type).toBe('suspended');
    expect(calls()).toBe(1);

    const records = readWAL();
    expect(records.some((r) => r.event === 'lease-denied' && r.callId === 'bash-1')).toBe(true);
    // Execute never ran: no bash-spawn, no tool-start for the denied call.
    expect(records.some((r) => r.event === 'bash-spawn')).toBe(false);
    expect(records.some((r) => r.event === 'tool-start' && r.callId === 'bash-1')).toBe(false);
  });

  test('gate rides alone: a non-effectful sibling after the gate is denied pre-dispatch', async () => {
    // echo is allowlisted but NOT in gated[], so the lease never governs it.
    // The barrier must still deny it because it streams in AFTER await_human in
    // the same step (the gate-first order). This is the row #169 adds on top of
    // the lease: an allowed-but-ungated sibling can no longer leak beside a gate.
    const { model, calls } = makeModel([
      turn([
        toolCallPart('gate-1', 'await_human', { prompt: 'Approve this reply?' }),
        toolCallPart('bash-1', 'tools__bash', { command: 'echo hello' }),
      ]),
    ]);
    currentModel = model;

    const chunks = await runCore(makeTools());
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(chunks[chunks.length - 1].type).toBe('suspended');
    expect(calls()).toBe(1);

    const records = readWAL();
    // Denied by the barrier, not the lease (echo is not effectful).
    expect(records.some((r) => r.event === 'gate-barrier-denied' && r.callId === 'bash-1')).toBe(true);
    expect(records.some((r) => r.event === 'lease-denied' && r.callId === 'bash-1')).toBe(false);
    // Execute never ran: no bash-spawn, no tool-start for the denied sibling.
    expect(records.some((r) => r.event === 'bash-spawn')).toBe(false);
    expect(records.some((r) => r.event === 'tool-start' && r.callId === 'bash-1')).toBe(false);
  });

  test('covered command runs straight through (approved plan, zero interruptions)', async () => {
    const marker = path.join(projectRoot, 'approved-marker.txt');
    const command = `touch ${marker}`;

    // The human approved a plan whose changes[] carried this exact command.
    new LeaseStore(sessionDir).grant({ version: 1, grantedAt: Date.now(), entries: [{ content: command }] });

    const { model, calls } = makeModel([
      turn([toolCallPart('bash-1', 'tools__bash', { command })]),
      turn([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'posted' },
        { type: 'text-end', id: 't1' },
      ], 'stop'),
    ]);
    currentModel = model;

    const chunks = await runCore(makeTools());

    expect(fs.existsSync(marker)).toBe(true);
    expect(calls()).toBe(2);
    expect(chunks.some((c) => c.type === 'suspended')).toBe(false);
    // The grant belongs to this resumed segment only. A later continuation
    // must start without authority from the earlier human decision.
    expect(fs.existsSync(path.join(sessionDir, LEASE_FILENAME))).toBe(false);

    const records = readWAL();
    expect(records.some((r) => r.event === 'lease-approved' && r.callId === 'bash-1')).toBe(true);
    expect(records.some((r) => r.event === 'bash-spawn')).toBe(true);
  });

  test('abandoning a segment consumes its lease before a later continuation', async () => {
    const store = new LeaseStore(sessionDir);
    store.grant({
      version: 1,
      grantedAt: Date.now(),
      entries: [{ content: 'touch previously-approved' }],
    });
    const { model } = makeModel([
      turn([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'partial output' },
        { type: 'text-end', id: 't1' },
      ], 'stop'),
    ]);
    currentModel = model;

    const generator = executeAgentCore(agent, makeTools() as any, {
      userMessage: 'go',
      systemMessages: [],
      maxSteps: 5,
      sessionManager,
      sessionID,
      agentId,
      effectWal: wal,
    });
    expect((await generator.next()).done).toBe(false);
    await generator.return(undefined);

    expect(fs.existsSync(path.join(sessionDir, LEASE_FILENAME))).toBe(false);
  });

  test('uncovered effectful command is denied and the model is told to re-gate', async () => {
    const marker = path.join(projectRoot, 'denied-marker.txt');
    const { model, calls, promptAt } = makeModel([
      turn([toolCallPart('bash-1', 'tools__bash', { command: `touch ${marker}` })]),
      turn([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'understood, gating' },
        { type: 'text-end', id: 't1' },
      ], 'stop'),
    ]);
    currentModel = model;

    const chunks = await runCore(makeTools());

    expect(fs.existsSync(marker)).toBe(false);
    expect(calls()).toBe(2);

    // The second model call carries the denial redirect so the model re-gates.
    const secondPrompt = JSON.stringify(promptAt(1));
    expect(secondPrompt).toContain('not covered by an approved plan');
    expect(secondPrompt).toContain('await_human');

    // The denial is journaled in the session chunk stream too.
    const denied = chunks.find(
      (c) => c.type === 'tool-result' && typeof c.toolResult === 'string' && c.toolResult.includes('denied')
    );
    expect(denied).toBeDefined();
  });

  test('non-effectful commands are untouched by lease enforcement', async () => {
    const { model, calls } = makeModel([
      turn([toolCallPart('bash-1', 'tools__bash', { command: 'echo hello-leases' })]),
      turn([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'done' },
        { type: 'text-end', id: 't1' },
      ], 'stop'),
    ]);
    currentModel = model;

    const chunks = await runCore(makeTools());

    expect(calls()).toBe(2);
    const result = chunks.find((c) => c.type === 'tool-result' && c.toolName === 'tools__bash');
    expect(result).toBeDefined();
    expect(String(result!.toolResult)).toContain('hello-leases');
    const records = readWAL();
    expect(records.some((r) => r.event === 'lease-denied')).toBe(false);
    expect(records.some((r) => r.event === 'lease-approved')).toBe(false);
  });

  test('a new gate revokes the active lease (stale approvals cannot leak forward)', async () => {
    const store = new LeaseStore(sessionDir);
    store.grant({ version: 1, grantedAt: Date.now(), entries: [{ content: 'touch something-previously-approved' }] });
    expect(fs.existsSync(path.join(sessionDir, LEASE_FILENAME))).toBe(true);

    const { model } = makeModel([
      turn([toolCallPart('gate-1', 'await_human', { prompt: 'Approve v2?' })]),
    ]);
    currentModel = model;

    const chunks = await runCore(makeTools());

    expect(chunks[chunks.length - 1].type).toBe('suspended');
    expect(fs.existsSync(path.join(sessionDir, LEASE_FILENAME))).toBe(false);
  });

  describe('mocked approval (--mock-approval)', () => {
    beforeEach(() => {
      process.env.AGENTUSE_MOCK_MODE = '1';
      process.env.AGENTUSE_MOCK_MODEL = 'anthropic:mock';
      process.env.AGENTUSE_MOCK_APPROVAL = 'approve';
    });
    afterEach(() => {
      delete process.env.AGENTUSE_MOCK_MODE;
      delete process.env.AGENTUSE_MOCK_MODEL;
      delete process.env.AGENTUSE_MOCK_APPROVAL;
    });

    function makeMockedTools() {
      const tools = makeTools();
      // Production wraps via wrapToolsWithLLMMock's await_human special case;
      // maybeMockAwaitHuman is the same deterministic wrapper (also used on the
      // sub-agent rebuild path). Bash stays real here to prove the granted
      // lease actually lets the gated command through.
      return { ...tools, await_human: maybeMockAwaitHuman(tools.await_human) };
    }

    test('auto-approve grants the lease from changes[] and the gated flow completes end-to-end', async () => {
      const marker = path.join(projectRoot, 'mock-approved.txt');
      const command = `touch ${marker}`;
      const { model, calls } = makeModel([
        turn([toolCallPart('gate-1', 'await_human', { prompt: 'Run it?', changes: [{ label: 'Touch', content: command }] })]),
        turn([toolCallPart('bash-1', 'tools__bash', { command })]),
        turn([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'done' },
          { type: 'text-end', id: 't1' },
        ], 'stop'),
      ]);
      currentModel = model;

      const chunks = await runCore(makeMockedTools());

      // Never suspended: the gate resolved inline with a deterministic approve.
      expect(chunks.some((c) => c.type === 'suspended')).toBe(false);
      expect(calls()).toBe(3);
      // The gated command really ran, covered by the mock-granted lease.
      expect(fs.existsSync(marker)).toBe(true);
      // The model saw a real decision payload.
      const gateResult = chunks.find((c) => c.type === 'tool-result' && c.toolName === 'await_human');
      expect(gateResult).toBeDefined();
      expect(String((gateResult as any).toolResult)).toContain('approved');

      const records = readWAL();
      expect(records.some((r) => r.event === 'mock-gate-decision' && r.status === 'approved')).toBe(true);
      expect(records.some((r) => r.event === 'lease-approved' && r.callId === 'bash-1')).toBe(true);
      expect(records.some((r) => r.event === 'lease-denied')).toBe(false);
    });

    test('forced reject seals the gate: gated commands stay denied and a re-gate hits the terminal denial', async () => {
      process.env.AGENTUSE_MOCK_APPROVAL = 'reject';
      const marker = path.join(projectRoot, 'mock-rejected.txt');
      const command = `touch ${marker}`;
      const { model, calls } = makeModel([
        turn([toolCallPart('gate-1', 'await_human', { prompt: 'Run it?', changes: [{ content: command }] })]),
        turn([toolCallPart('bash-1', 'tools__bash', { command })]),
        turn([toolCallPart('gate-2', 'await_human', { prompt: 'Please?' })]),
        turn([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'cleaning up' },
          { type: 'text-end', id: 't1' },
        ], 'stop'),
      ]);
      currentModel = model;

      const chunks = await runCore(makeMockedTools());

      expect(chunks.some((c) => c.type === 'suspended')).toBe(false);
      expect(calls()).toBe(4);
      expect(fs.existsSync(marker)).toBe(false);

      const records = readWAL();
      expect(records.some((r) => r.event === 'mock-gate-decision' && r.status === 'rejected')).toBe(true);
      // The gated command was never authorized...
      expect(records.some((r) => r.event === 'lease-denied' && r.callId === 'bash-1')).toBe(true);
      // ...and the re-gate hit the terminal seal, exactly like a human reject.
      expect(records.some((r) => r.event === 'gate-sealed-denied' && r.callId === 'gate-2')).toBe(true);
    });
  });
});
