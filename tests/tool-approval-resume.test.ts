import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { z } from 'zod';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { ModelMessage } from 'ai';

process.env.CONTEXT_COMPACTION = 'false';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
}));

import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { executeAgentCore } from '../src/runner/execution';
import { processAgentStream } from '../src/runner/stream';
import { APPROVAL_TOOL_CONTRACT, approvalToolContract } from '../src/tools/tool-contract';
import { APPROVAL_INPUT_LEDGER_DIR, approvalInputDigest } from '../src/runner/approval-input-ledger';
import { bindToolsToSnapshot } from '../src/runner/tool-snapshot';
import { applyResumeToolResult } from '../src/runner/resume';
import { rehydrateMessages } from '../src/session/rehydrate';

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function modelWithTurns(turns: unknown[][], prompts: unknown[] = []): MockLanguageModelV3 {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async (options: any) => {
      prompts.push(options.prompt);
      const stream = turns[Math.min(index, turns.length - 1)]!;
      index++;
      return { stream: convertArrayToReadableStream(stream as any) };
    },
  });
}

function toolCallTurn(toolCallId: string, toolName: string, input: unknown): unknown[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp', modelId: 'mock-model', timestamp: new Date(0) },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
  ];
}

function twoToolCallTurn(calls: Array<{ toolCallId: string; toolName: string; input: unknown }>): unknown[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp', modelId: 'mock-model', timestamp: new Date(0) },
    ...calls.map(call => ({
      type: 'tool-call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    })),
    { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
  ];
}

function stopTurn(): unknown[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp-2', modelId: 'mock-model', timestamp: new Date(0) },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: 'stop', usage: USAGE },
  ];
}

function approvedHistory(toolCallId: string, toolName: string, input: unknown): ModelMessage[] {
  const approvalId = `approval-${toolCallId}`;
  return [
    { role: 'user', content: 'Run the approved action.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId, toolName, input },
        { type: 'tool-approval-request', approvalId, toolCallId },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId, approved: true }],
    },
  ] as ModelMessage[];
}

describe('needsApproval canonical input resume', () => {
  let projectRoot: string;
  let sessionManager: SessionManager;
  let sessionID: string;
  const agentId = 'agents/approval-transform';
  const agent = {
    name: 'approval-transform',
    config: { model: 'anthropic:mock-model' },
  } as any;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tool-approval-resume-'));
    process.env.XDG_DATA_HOME = projectRoot;
    await initStorage(projectRoot);
    sessionManager = new SessionManager();
    sessionID = await sessionManager.createSession({
      agent: { id: agentId, name: 'approval-transform', isSubAgent: false },
      model: 'anthropic:mock-model',
      version: 'test',
      config: {},
      project: { root: projectRoot, cwd: projectRoot },
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    delete process.env.XDG_DATA_HOME;
  });

  async function run(tools: Record<string, unknown>, messages?: ModelMessage[], pluginEvents?: any) {
    const chunks: any[] = [];
    for await (const chunk of executeAgentCore(agent, tools as any, {
      userMessage: 'Run the action.',
      systemMessages: [],
      ...(messages && { messages }),
      maxSteps: 3,
      sessionManager,
      sessionID,
      agentId,
      ...(pluginEvents && { pluginEvents }),
    })) chunks.push(chunk);
    return chunks;
  }

  test('restores a root Date transform once across two real SDK invocations', async () => {
    const rawInput = { iso: '2026-09-12T00:00:00.000Z' };
    let transforms = 0;
    const approvals: unknown[] = [];
    const executed: unknown[] = [];
    const tools = {
      // Its presence installs the core gate callback, exercising composition
      // with this tool's own needsApproval policy.
      await_human: {
        inputSchema: z.object({ prompt: z.string() }),
        execute: async () => ({ unused: true }),
      },
      publish_at: {
        inputSchema: z.object({ iso: z.string() }).transform(({ iso }) => {
          transforms++;
          return new Date(iso);
        }),
        [APPROVAL_TOOL_CONTRACT]: 'approval-transform:v1',
        needsApproval: (input: unknown) => {
          approvals.push(input);
          return true;
        },
        execute: async (input: unknown) => {
          executed.push(input);
          return { receivedDate: input instanceof Date };
        },
      },
    };

    currentModel = modelWithTurns([toolCallTurn('publish-1', 'publish_at', rawInput), stopTurn()]);
    await run(tools);
    expect(transforms).toBe(1);
    expect(approvals).toHaveLength(1);
    expect(executed).toHaveLength(0);
    expect(rawInput).toEqual({ iso: '2026-09-12T00:00:00.000Z' });

    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    expect(fs.readdirSync(path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR)).filter(name => name.endsWith('.json'))).toHaveLength(1);

    currentModel = modelWithTurns([stopTurn()]);
    const history = approvedHistory('publish-1', 'publish_at', rawInput);
    await run(tools, history);

    expect(transforms).toBe(1);
    expect(approvals).toHaveLength(2);
    expect(approvals[1]).toBeInstanceOf(Date);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toBeInstanceOf(Date);
    expect((executed[0] as Date).toISOString()).toBe(rawInput.iso);
    expect((history[1] as any).content[0].input).toEqual(rawInput);
    expect(fs.readdirSync(path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR)).filter(name => name.endsWith('.json'))).toHaveLength(0);
  });

  test('persists resumed root falsy canonical values as completed session tool parts', async () => {
    const cases: Array<[string, unknown]> = [
      ['null', null],
      ['false', false],
      ['zero', 0],
      ['empty', ''],
      ['undefined', undefined],
    ];
    for (const [name, canonical] of cases) {
      const raw = { case: name };
      const callID = `falsy-${name}`;
      const tools = {
        publish: {
          inputSchema: z.object({ case: z.string() }).transform(() => canonical),
          [APPROVAL_TOOL_CONTRACT]: 'falsy:v1',
          needsApproval: true,
          execute: async () => ({ ok: true }),
        },
      };
      currentModel = modelWithTurns([toolCallTurn(callID, 'publish', raw), stopTurn()]);
      const initial = await run(tools);
      currentModel = modelWithTurns([stopTurn()]);
      const resumed = await run(tools, approvedHistory(callID, 'publish', raw));
      const messageID = await sessionManager.createMessage(sessionID, agentId, {
        user: { prompt: { task: `Persist ${name}` } },
        assistant: {
          system: [], modelID: 'anthropic:mock-model', providerID: 'anthropic', mode: 'build',
          path: { cwd: projectRoot, root: projectRoot }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      async function* chunks() { yield* initial; yield* resumed; }
      await processAgentStream(chunks(), { sessionManager, sessionID, agentId, messageID, quiet: true });
      const parts = await sessionManager.getMessageParts(sessionID, agentId, messageID);
      const state = (parts.find(part => part.type === 'tool' && (part as any).callID === callID) as any)?.state;
      expect(state).toMatchObject({
        status: 'completed',
        input: canonical === undefined ? { __type: 'Undefined' } : canonical,
        rawApprovedInput: raw,
      });
      if (canonical === undefined) expect(Object.prototype.hasOwnProperty.call(state, 'input')).toBe(true);
    }
  });

  test('denies approved history when the canonical record is absent', async () => {
    let executions = 0;
    const prompts: unknown[] = [];
    currentModel = modelWithTurns([stopTurn()], prompts);
    await run({
      publish_at: {
        inputSchema: z.object({ iso: z.string() }).transform(({ iso }) => new Date(iso)),
        [APPROVAL_TOOL_CONTRACT]: 'approval-transform:v1',
        needsApproval: true,
        execute: async () => { executions++; return { ok: true }; },
      },
    }, approvedHistory('missing-1', 'publish_at', { iso: '2026-09-12T00:00:00.000Z' }));

    expect(executions).toBe(0);
    expect(JSON.stringify(prompts[0])).toContain('no matching canonical input was persisted');
  });

  test('does not inherit Object.prototype context for a constructor-named tool', async () => {
    const contexts: unknown[] = [];
    let executions = 0;
    currentModel = modelWithTurns([
      toolCallTurn('constructor-1', 'constructor', { value: 'safe' }),
      stopTurn(),
    ]);

    await run({
      constructor: {
        inputSchema: z.object({ value: z.string() }),
        needsApproval: (_input: unknown, options: { context: unknown }) => {
          contexts.push(options.context);
          return false;
        },
        execute: async () => { executions++; return { ok: true }; },
      },
    });

    expect(executions).toBe(1);
    expect(contexts).toEqual([undefined]);
  });

  test('denies and consumes an approval when current plugin policy mutates signed input', async () => {
    const rawInput = { title: 'Approved title' };
    let executions = 0;
    const tools = {
      publish: {
        inputSchema: z.object({ title: z.string() }),
        [APPROVAL_TOOL_CONTRACT]: 'approval-transform:v1',
        needsApproval: true,
        execute: async () => { executions++; return { ok: true }; },
      },
    };
    currentModel = modelWithTurns([toolCallTurn('publish-2', 'publish', rawInput), stopTurn()]);
    await run(tools);

    const prompts: unknown[] = [];
    currentModel = modelWithTurns([stopTurn()], prompts);
    await run(tools, approvedHistory('publish-2', 'publish', rawInput), {
      toolCall: async (event: any) => {
        event.input.title = 'Changed after approval';
        return {};
      },
    });

    expect(executions).toBe(0);
    expect(JSON.stringify(prompts[0])).toContain('request a new approval');
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    expect(fs.readdirSync(path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR)).filter(name => name.endsWith('.json'))).toHaveLength(0);
  });

  test('signs the post-plugin raw input and executes its canonical value after approval', async () => {
    const providerInput = { title: 'provider draft' };
    const signedInput = { title: 'policy reviewed draft' };
    let transforms = 0;
    let executed: unknown;
    const tools = {
      publish: {
        inputSchema: z.object({ title: z.string() }).transform(input => {
          transforms++;
          return { ...input, canonical: true };
        }),
        [APPROVAL_TOOL_CONTRACT]: 'approval-transform:v1',
        needsApproval: true,
        execute: async (input: unknown) => { executed = input; return { ok: true }; },
      },
    };
    const policy = {
      toolCall: async (event: any) => {
        event.input.title = signedInput.title;
        return {};
      },
    };

    currentModel = modelWithTurns([
      toolCallTurn('publish-3', 'publish', providerInput),
      stopTurn(),
    ]);
    const initialChunks = await run(tools, undefined, policy);

    expect(transforms).toBe(1);
    expect(executed).toBeUndefined();
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    const record = JSON.parse(fs.readFileSync(
      path.join(ledgerDir, fs.readdirSync(ledgerDir).find(name => name.endsWith('.json'))!),
      'utf8',
    ));
    expect(record.rawDigest).toBe(approvalInputDigest(signedInput));
    expect(record.rawDigest).not.toBe(approvalInputDigest(providerInput));

    const history = approvedHistory('publish-3', 'publish', signedInput);
    currentModel = modelWithTurns([stopTurn()]);
    await run(tools, history, policy);

    expect(transforms).toBe(1);
    expect(executed).toEqual({ title: signedInput.title, canonical: true });
    expect((history[1] as any).content[0].input).toEqual(signedInput);

    const call = initialChunks.find(chunk => chunk.type === 'tool-call' && chunk.toolCallId === 'publish-3');
    expect(call?.toolInput).toEqual({ title: signedInput.title, canonical: true });
    expect(call?.rawApprovedInput).toEqual(signedInput);

    const messageID = await sessionManager.createMessage(sessionID, agentId, {
      user: { prompt: { task: 'Record approved execution.' } },
      assistant: {
        system: [], modelID: 'anthropic:mock-model', providerID: 'anthropic', mode: 'build',
        path: { cwd: projectRoot, root: projectRoot }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    async function* recordedChunks() { yield* initialChunks; }
    await processAgentStream(recordedChunks(), { sessionManager, sessionID, agentId, messageID, quiet: true });
    const parts = await sessionManager.getMessageParts(sessionID, agentId, messageID);
    const state = (parts.find(part => part.type === 'tool' && (part as any).callID === 'publish-3') as any)?.state;
    expect(state).toMatchObject({
      status: 'pending',
      input: { title: signedInput.title, canonical: true },
      rawApprovedInput: signedInput,
      resumePayload: { kind: 'tool_approval', toolCallId: 'publish-3', toolName: 'publish' },
    });
  });

  test('persists, approves, rehydrates, and executes a generic SDK approval exactly once', async () => {
    const rawInput = { title: 'x'.repeat(20_000) };
    const canonicalInput = { titleLength: rawInput.title.length, canonical: true };
    const executed: unknown[] = [];
    const tools = {
      publish: {
        inputSchema: z.object({ title: z.string() }).transform(input => ({ titleLength: input.title.length, canonical: true })),
        [APPROVAL_TOOL_CONTRACT]: 'generic-e2e:v1',
        needsApproval: true,
        execute: async (input: unknown) => { executed.push(input); return false; },
      },
    };
    currentModel = modelWithTurns([toolCallTurn('generic-approve', 'publish', rawInput), stopTurn()]);
    const initialChunks = await run(tools);
    const suspended = initialChunks.find(chunk => chunk.type === 'suspended');
    expect(suspended).toBeDefined();
    expect(initialChunks.filter(chunk => chunk.type === 'suspended')).toHaveLength(1);
    expect(suspended.toolResultRaw).toMatchObject({
      kind: 'tool_approval',
      toolCallId: 'generic-approve',
      toolName: 'publish',
      approvalRequest: {
        type: 'tool-approval-request',
        toolCallId: 'generic-approve',
      },
    });
    expect(typeof suspended.toolResultRaw.approvalId).toBe('string');
    expect(typeof suspended.toolResultRaw.resumeToken).toBe('string');
    expect(suspended.toolResultRaw.signedRawInputDisplay.length).toBeGreaterThan(20_000);
    expect(suspended.toolResultRaw.signedRawInputDisplay).toContain(rawInput.title);
    expect(suspended.toolResultRaw.signedRawInputDisplay).not.toContain('[truncated for display]');
    expect(suspended.toolResultRaw.signedRawInputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(suspended.toolResultRaw.canonicalInputDisplay).toContain('"titleLength": 20000');
    expect(suspended.toolResultRaw.canonicalInputDigest).toMatch(/^[a-f0-9]{64}$/);

    const messageID = await sessionManager.createMessage(sessionID, agentId, {
      user: { prompt: { task: 'Approve the generic action.' } },
      assistant: {
        system: [], modelID: 'anthropic:mock-model', providerID: 'anthropic', mode: 'build',
        path: { cwd: projectRoot, root: projectRoot }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    async function* initialStream() { yield* initialChunks; }
    const initialResult = await processAgentStream(initialStream(), {
      sessionManager, sessionID, agentId, messageID, quiet: true,
    });
    expect(initialResult.suspended).toBe(true);
    await sessionManager.setSessionSuspended(sessionID, agentId);

    const pending = await sessionManager.findPendingTool(sessionID, agentId);
    expect(pending?.part.state).toMatchObject({
      status: 'pending',
      input: canonicalInput,
      rawApprovedInput: rawInput,
      resumePayload: {
        kind: 'tool_approval',
        approvalId: suspended.toolResultRaw.approvalId,
        toolCallId: 'generic-approve',
        toolName: 'publish',
        resumeToken: suspended.toolResultRaw.resumeToken,
        approvalRequest: suspended.toolResultRaw.approvalRequest,
        signedRawInputDisplay: suspended.toolResultRaw.signedRawInputDisplay,
        signedRawInputDigest: suspended.toolResultRaw.signedRawInputDigest,
        canonicalInputDisplay: suspended.toolResultRaw.canonicalInputDisplay,
        canonicalInputDigest: suspended.toolResultRaw.canonicalInputDigest,
      },
    });
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json'))).toHaveLength(1);

    await applyResumeToolResult({
      sessionManager,
      sessionId: sessionID,
      toolResult: { status: 'approve', reviewer: { username: 'test' } },
      resumeToken: suspended.toolResultRaw.resumeToken,
    });
    await sessionManager.setSessionRunning(sessionID, agentId);
    const history = await rehydrateMessages(sessionManager, sessionID, agentId);
    const serializedHistory = JSON.stringify(history);
    expect(serializedHistory).toContain(`\"approvalId\":\"${suspended.toolResultRaw.approvalId}\"`);
    expect(serializedHistory).toContain('\"approved\":true');
    expect(serializedHistory).toContain(rawInput.title);

    currentModel = modelWithTurns([stopTurn()]);
    const resumedChunks = await run(tools, history);
    async function* resumedStream() { yield* resumedChunks; }
    await processAgentStream(resumedStream(), {
      sessionManager, sessionID, agentId, messageID, quiet: true,
    });

    expect(executed).toEqual([canonicalInput]);
    const parts = await sessionManager.getMessageParts(sessionID, agentId, messageID);
    const completed = parts.find(part => part.type === 'tool' && (part as any).callID === 'generic-approve') as any;
    expect(completed.state).toMatchObject({
      status: 'completed',
      input: canonicalInput,
      rawApprovedInput: rawInput,
      output: false,
      metadata: {
        resumePayload: {
          kind: 'tool_approval',
          approvalId: suspended.toolResultRaw.approvalId,
        },
        approvalResponse: {
          type: 'tool-approval-response',
          approvalId: suspended.toolResultRaw.approvalId,
          approved: true,
        },
        approvalReviewer: { username: 'test' },
      },
    });
    expect(fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json') || name.endsWith('.lock'))).toHaveLength(0);

    const continuation = await rehydrateMessages(sessionManager, sessionID, agentId);
    const genericCall = (continuation as any[]).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(part => part.type === 'tool-call' && part.toolCallId === 'generic-approve');
    const approvalResponse = (continuation as any[]).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(part => part.type === 'tool-approval-response' && part.approvalId === suspended.toolResultRaw.approvalId);
    const toolResult = (continuation as any[]).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(part => part.type === 'tool-result' && part.toolCallId === 'generic-approve');
    expect(genericCall.input).toEqual(rawInput);
    expect(approvalResponse.approved).toBe(true);
    expect(toolResult.output).toEqual({ type: 'json', value: false });
  });

  test('rejects a generic SDK approval without execution and preserves the reason and large signed input', async () => {
    const rawInput = { title: 'r'.repeat(20_000) };
    let executions = 0;
    const tools = {
      publish: {
        inputSchema: z.object({ title: z.string() }).transform(input => ({ length: input.title.length })),
        [APPROVAL_TOOL_CONTRACT]: 'generic-reject:v1',
        needsApproval: true,
        execute: async () => { executions++; return { shouldNotRun: true }; },
      },
    };
    currentModel = modelWithTurns([toolCallTurn('generic-reject', 'publish', rawInput), stopTurn()]);
    const initialChunks = await run(tools);
    const suspended = initialChunks.find(chunk => chunk.type === 'suspended');
    const messageID = await sessionManager.createMessage(sessionID, agentId, {
      user: { prompt: { task: 'Reject the generic action.' } },
      assistant: {
        system: [], modelID: 'anthropic:mock-model', providerID: 'anthropic', mode: 'build',
        path: { cwd: projectRoot, root: projectRoot }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    async function* initialStream() { yield* initialChunks; }
    await processAgentStream(initialStream(), { sessionManager, sessionID, agentId, messageID, quiet: true });
    await sessionManager.setSessionSuspended(sessionID, agentId);
    await applyResumeToolResult({
      sessionManager,
      sessionId: sessionID,
      toolResult: {
        status: 'reject',
        comment: 'Policy owner declined this publish.',
        reviewer: { username: 'reject-reviewer' },
      },
      resumeToken: suspended.toolResultRaw.resumeToken,
    });
    await sessionManager.setSessionRunning(sessionID, agentId);
    const history = await rehydrateMessages(sessionManager, sessionID, agentId);
    expect(JSON.stringify(history)).toContain('Policy owner declined this publish.');

    currentModel = modelWithTurns([stopTurn()]);
    const resumedChunks = await run(tools, history);
    expect(resumedChunks.some(chunk => chunk.type === 'suspended')).toBe(false);
    expect(JSON.stringify(resumedChunks)).toContain('Policy owner declined this publish.');
    async function* resumedStream() { yield* resumedChunks; }
    await processAgentStream(resumedStream(), { sessionManager, sessionID, agentId, messageID, quiet: true });

    expect(executions).toBe(0);
    const parts = await sessionManager.getMessageParts(sessionID, agentId, messageID);
    const rejected = parts.find(part => part.type === 'tool' && (part as any).callID === 'generic-reject') as any;
    expect(rejected.state.status).toBe('error');
    expect(rejected.state.rawApprovedInput).toEqual(rawInput);
    expect(rejected.state.metadata.approvalResponse).toMatchObject({ approved: false, reason: 'Policy owner declined this publish.' });
    expect(rejected.state.metadata.approvalReviewer).toEqual({ username: 'reject-reviewer' });
    expect(rejected.state.error).toContain('Policy owner declined this publish.');
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json') || name.endsWith('.lock'))).toHaveLength(0);
    expect((await sessionManager.findSession(sessionID))?.session.status).toBe('running');
  });

  test('allows only one manual generic approval in a model step and denies the later request', async () => {
    const executions: string[] = [];
    const approvalTool = (name: string) => ({
      inputSchema: z.object({ value: z.string() }),
      [APPROVAL_TOOL_CONTRACT]: `${name}:v1`,
      needsApproval: true,
      execute: async () => { executions.push(name); return { ok: true }; },
    });
    currentModel = modelWithTurns([
      twoToolCallTurn([
        { toolCallId: 'manual-first', toolName: 'publish_first', input: { value: 'first' } },
        { toolCallId: 'manual-second', toolName: 'publish_second', input: { value: 'second' } },
      ]),
      stopTurn(),
    ]);

    const chunks = await run({
      publish_first: approvalTool('publish_first'),
      publish_second: approvalTool('publish_second'),
    });

    expect(executions).toHaveLength(0);
    expect(chunks.filter(chunk => chunk.type === 'suspended')).toHaveLength(1);
    expect(chunks.find(chunk => chunk.type === 'suspended')?.toolCallId).toBe('manual-first');
    const denied = chunks.find(chunk => chunk.type === 'tool-result' && chunk.toolCallId === 'manual-second');
    expect(denied).toMatchObject({
      toolSuccess: false,
      toolResultRaw: { success: false, denied: true },
    });
    expect(denied?.toolResultRaw.reason).toContain('another tool call in this step already requires manual approval');
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json'))).toHaveLength(1);
    expect(fs.readdirSync(ledgerDir).filter(name => name.endsWith('.lock'))).toHaveLength(0);
  });

  test('captures complete tagged displays for special canonical values before session persistence', async () => {
    const backing = new Uint8Array([91, 1, 2, 3, 92]);
    const sparse: any[] = new Array(2);
    sparse.extra = 'array-suffix-secret';
    const canonical: any = {
      count: 12n,
      invalidAt: new Date(Number.NaN),
      schedule: new Map([['days', new Set(['monday', 'friday'])]]),
      view: new Uint8Array(backing.buffer, 1, 3),
      sparse,
    };
    canonical.self = canonical;
    const tools = {
      publish: {
        inputSchema: z.object({ request: z.string() }).transform(() => canonical),
        [APPROVAL_TOOL_CONTRACT]: 'special-display:v1',
        needsApproval: true,
        execute: async () => ({ ok: true }),
      },
    };
    currentModel = modelWithTurns([
      toolCallTurn('special-display', 'publish', { request: 'review special input' }),
      stopTurn(),
    ]);

    const chunks = await run(tools);
    const display = chunks.find(chunk => chunk.type === 'suspended')?.toolResultRaw.canonicalInputDisplay;

    expect(display).toContain('"__type": "BigInt"');
    expect(display).toContain('"invalid": true');
    expect(display).toContain('"__type": "Map"');
    expect(display).toContain('"__type": "Set"');
    expect(display).toContain('"__type": "Hole"');
    expect(display).toContain('array-suffix-secret');
    expect(display).toContain('"byteOffset": 1');
    expect(display).toContain('"base64": "WwECA1w="');
    expect(display).toContain('"__type": "Reference"');
  });

  test('rejects plugin-added array metadata before it can survive an approval resume', async () => {
    const rawInput = { drafts: [{ title: 'provider draft' }] };
    const transformed: unknown[] = [];
    let executions = 0;
    const tools = {
      publish: {
        // Deliberately inspect the non-JSON property so this proves a digest
        // cannot silently authorize a different canonical input than history.
        inputSchema: z.object({ drafts: z.any() }).transform(({ drafts }) => {
          const canonical = { title: drafts[0].title, reviewed: drafts.reviewed === true };
          transformed.push(canonical);
          return canonical;
        }),
        [APPROVAL_TOOL_CONTRACT]: 'approval-transform:v1',
        needsApproval: true,
        execute: async () => { executions++; return { ok: true }; },
      },
    };
    const policy = {
      toolCall: async (event: any) => {
        // Keep a provider-compatible object root while adding hidden array state.
        Object.defineProperty(event.input.drafts, 'reviewed', { value: true, enumerable: false });
        return {};
      },
    };

    currentModel = modelWithTurns([toolCallTurn('array-metadata', 'publish', rawInput), stopTurn()]);
    const chunks = await run(tools, undefined, policy);
    expect(transformed).toEqual([{ title: 'provider draft', reviewed: true }]);
    expect(chunks.find(chunk => chunk.type === 'error')?.error.message)
      .toContain('nonordinary array property');
    expect(executions).toBe(0);
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json')) : []).toHaveLength(0);

    const prompts: unknown[] = [];
    currentModel = modelWithTurns([stopTurn()], prompts);
    await run(tools, approvedHistory('array-metadata', 'publish', rawInput));
    expect(executions).toBe(0);
    expect(JSON.stringify(prompts[0])).toContain('no matching canonical input was persisted');
  });

  test('preserves the first canonical value when a duplicate approval identity is rejected', async () => {
    const rawInput = { title: 'same signed input' };
    let transforms = 0;
    const executed: unknown[] = [];
    const tools = {
      publish: {
        inputSchema: z.object({ title: z.string() }).transform(input => ({
          ...input,
          canonicalSequence: ++transforms,
        })),
        [APPROVAL_TOOL_CONTRACT]: 'approval-transform:v1',
        needsApproval: true,
        execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
      },
    };

    currentModel = modelWithTurns([toolCallTurn('duplicate-approval', 'publish', rawInput), stopTurn()]);
    await run(tools);
    currentModel = modelWithTurns([toolCallTurn('duplicate-approval', 'publish', rawInput), stopTurn()]);
    await run(tools);
    // The duplicate is rejected before policy/schema work can observe it.
    expect(transforms).toBe(1);

    currentModel = modelWithTurns([stopTurn()]);
    await run(tools, approvedHistory('duplicate-approval', 'publish', rawInput));
    expect(executed).toEqual([{ title: rawInput.title, canonicalSequence: 1 }]);
  });

  test('rejects duplicate identities before invalid schema, plugin denial, or dynamic approval work', async () => {
    const rawInput = { title: 'first canonical value' };
    let transforms = 0;
    let pluginCalls = 0;
    let approvalCalls = 0;
    let denyPlugin = false;
    let requireApproval = true;
    const executed: unknown[] = [];
    const tools = { publish: {
      inputSchema: z.object({ title: z.string() }).transform(input => ({ ...input, sequence: ++transforms })),
      [APPROVAL_TOOL_CONTRACT]: 'publish:v1',
      needsApproval: () => { approvalCalls++; return requireApproval; },
      execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
    } };
    const plugin = { toolCall: async () => {
      pluginCalls++;
      return denyPlugin ? { block: true, reason: 'would deny if reached' } : {};
    } };
    currentModel = modelWithTurns([toolCallTurn('duplicate-preflight', 'publish', rawInput), stopTurn()]);
    await run(tools, undefined, plugin);
    expect([transforms, pluginCalls, approvalCalls]).toEqual([1, 1, 1]);

    currentModel = modelWithTurns([toolCallTurn('duplicate-preflight', 'publish', { invalid: true }), stopTurn()]);
    await run(tools, undefined, plugin);
    denyPlugin = true;
    currentModel = modelWithTurns([toolCallTurn('duplicate-preflight', 'publish', rawInput), stopTurn()]);
    await run(tools, undefined, plugin);
    requireApproval = false;
    currentModel = modelWithTurns([toolCallTurn('duplicate-preflight', 'publish', rawInput), stopTurn()]);
    await run(tools, undefined, plugin);
    const removedApprovalTools = { publish: {
      inputSchema: z.object({ title: z.string() }),
      [APPROVAL_TOOL_CONTRACT]: 'publish:v1',
      execute: async (input: unknown) => { executed.push({ bypass: input }); return { ok: true }; },
    } };
    currentModel = modelWithTurns([toolCallTurn('duplicate-preflight', 'publish', rawInput), stopTurn()]);
    await run(removedApprovalTools, undefined, plugin);
    expect([transforms, pluginCalls, approvalCalls]).toEqual([1, 1, 1]);

    denyPlugin = false;
    currentModel = modelWithTurns([stopTurn()]);
    await run(tools, approvedHistory('duplicate-preflight', 'publish', rawInput), plugin);
    expect(executed).toEqual([{ title: rawInput.title, sequence: 1 }]);
  });

  test('consumes and denies approved history when its explicit contract revision changes', async () => {
    const rawInput = { title: 'revisioned' };
    const executed: unknown[] = [];
    const tool = (revision: string) => ({
      inputSchema: z.object({ title: z.string() }),
      [APPROVAL_TOOL_CONTRACT]: revision,
      needsApproval: true,
      execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
    });
    currentModel = modelWithTurns([toolCallTurn('revision-change', 'publish', rawInput), stopTurn()]);
    await run({ publish: tool('publish:v1') });
    const prompts: unknown[] = [];
    currentModel = modelWithTurns([stopTurn()], prompts);
    await run({ publish: tool('publish:v2') }, approvedHistory('revision-change', 'publish', rawInput));
    expect(executed).toHaveLength(0);
    expect(JSON.stringify(prompts[0])).toContain('incompatible tool contract');
    currentModel = modelWithTurns([stopTurn()], prompts);
    await run({ publish: tool('publish:v1') }, approvedHistory('revision-change', 'publish', rawInput));
    expect(executed).toHaveLength(0);
  });

  test('consumes and denies approved history when the input schema changes', async () => {
    const rawInput = { title: 'schema' };
    const executed: unknown[] = [];
    const tools = (schema: any) => ({
      publish: {
        inputSchema: schema,
        [APPROVAL_TOOL_CONTRACT]: 'publish:v1',
        needsApproval: true,
        execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
      },
    });
    currentModel = modelWithTurns([toolCallTurn('schema-change', 'publish', rawInput), stopTurn()]);
    await run(tools(z.object({ title: z.string() })));
    const prompts: unknown[] = [];
    currentModel = modelWithTurns([stopTurn()], prompts);
    await run(tools(z.object({ title: z.string(), optional: z.boolean().optional() })), approvedHistory('schema-change', 'publish', rawInput));
    expect(executed).toHaveLength(0);
    expect(JSON.stringify(prompts[0])).toContain('incompatible tool contract');
  });

  test('does not require a contract version when dynamic approval resolves false', async () => {
    const executed: unknown[] = [];
    const tools = { publish: {
      inputSchema: z.object({ title: z.string() }),
      needsApproval: () => false,
      execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
    } };
    currentModel = modelWithTurns([toolCallTurn('no-approval-contract', 'publish', { title: 'safe' }), stopTurn()]);
    await run(tools);
    expect(executed).toEqual([{ title: 'safe' }]);
  });

  test('denies a user-approval tool without a stable contract before it persists or executes', async () => {
    const executed: unknown[] = [];
    const tools = { publish: {
      inputSchema: z.object({ title: z.string() }),
      needsApproval: true,
      execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
    } };
    const prompts: unknown[] = [];
    currentModel = modelWithTurns([toolCallTurn('missing-contract', 'publish', { title: 'blocked' }), stopTurn()], prompts);
    const chunks = await run(tools);
    expect(executed).toHaveLength(0);
    expect(JSON.stringify(chunks)).toContain('explicit stable approval contract version');
    const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
    const ledgerDir = path.join(sessionDir, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json')) : []).toHaveLength(0);
  });

  test('hashes resolved deferred JSON schemas and aborts a schema that never resolves', async () => {
    const deferred = (jsonSchema: unknown) => ({
      inputSchema: () => ({ jsonSchema: Promise.resolve(jsonSchema) }),
      [APPROVAL_TOOL_CONTRACT]: 'deferred:v1',
    }) as any;
    const one = await approvalToolContract(deferred({ type: 'object', properties: { a: { type: 'string' } } }), 'publish');
    const two = await approvalToolContract(deferred({ type: 'object', properties: { b: { type: 'string' } } }), 'publish');
    expect(one).not.toBe(two);

    const controller = new AbortController();
    const blocked = approvalToolContract({
      inputSchema: () => ({ jsonSchema: new Promise(() => {}) }),
      [APPROVAL_TOOL_CONTRACT]: 'deferred:v1',
    } as any, 'publish', controller.signal);
    controller.abort(new Error('cancel deferred schema'));
    await expect(blocked).rejects.toThrow('cancel deferred schema');
  });

  test('uses the current runtime schema for approval compatibility after binding a historical snapshot', async () => {
    const oldTool = {
      inputSchema: z.object({ title: z.string() }),
      [APPROVAL_TOOL_CONTRACT]: 'publish:v1',
      execute: async () => ({ ok: true }),
    } as any;
    const currentTool = {
      inputSchema: z.object({ title: z.string(), category: z.string().optional() }),
      [APPROVAL_TOOL_CONTRACT]: 'publish:v1',
      execute: async () => ({ ok: true }),
    } as any;
    const snapshot = { tools: [{ name: 'publish', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }] } as any;
    const bound = bindToolsToSnapshot({ publish: currentTool }, snapshot).publish as any;
    expect(await approvalToolContract(bound, 'publish')).toBe(await approvalToolContract(currentTool, 'publish'));
    expect(await approvalToolContract(bound, 'publish')).not.toBe(await approvalToolContract(oldTool, 'publish'));
  });

  test('runs the current transform for a fresh call after consuming historical approved input', async () => {
    let requireApproval = true;
    let transforms = 0;
    const executed: unknown[] = [];
    const currentTools = {
      publish: {
        inputSchema: z.object({ title: z.string() }).transform(input => ({ ...input, transformed: ++transforms })),
        [APPROVAL_TOOL_CONTRACT]: 'publish:v1',
        needsApproval: () => requireApproval,
        execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
      },
    } as any;
    const bound = bindToolsToSnapshot(currentTools, {
      tools: [{ name: 'publish', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }],
    } as any) as any;
    const first = { title: 'historical' };
    currentModel = modelWithTurns([toolCallTurn('snapshot-first', 'publish', first), stopTurn()]);
    await run(bound);
    currentModel = modelWithTurns([stopTurn()]);
    await run(bound, approvedHistory('snapshot-first', 'publish', first));
    expect(executed).toEqual([{ title: 'historical', transformed: 1 }]);

    requireApproval = false;
    currentModel = modelWithTurns([toolCallTurn('snapshot-fresh', 'publish', { title: 'fresh' }), stopTurn()]);
    await run(bound);
    expect(executed).toEqual([
      { title: 'historical', transformed: 1 },
      { title: 'fresh', transformed: 2 },
    ]);
  });
});
