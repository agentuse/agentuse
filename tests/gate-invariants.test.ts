/**
 * The verify gate's memory and the mocked reviewer must never let a gate reach
 * (or resolve past) the human on less than what was actually judged:
 *
 * - a settled pass covers the exact reviewed change (display text, exact
 *   command, media) under the request context it was judged in;
 * - the judge's whole-request failure is never rewritten into a pass, and
 *   settles nothing;
 * - an inline (mocked) resolution ends the gate cycle, follows the same
 *   decision rules as a real reviewer, and leaves no effect from a decision a
 *   machine bounce pre-empted.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

mock.restore();
process.env.CONTEXT_COMPACTION = 'false';

const judgeOutputMock = mock(async (_params: unknown): Promise<unknown> => ({
  status: 'verdict',
  verdict: { pass: true },
}));
mock.module('../src/verify/judge', () => ({
  judgeOutput: judgeOutputMock,
}));

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
  AuthenticationError: class AuthenticationError extends Error {},
}));

let withGateVerify: typeof import('../src/verify/gate').withGateVerify;
let renderGatePayload: typeof import('../src/verify/gate').renderGatePayload;
let extractGateCandidates: typeof import('../src/verify/candidates').extractGateCandidates;
let renderChangeForReview: typeof import('../src/verify/candidates').renderChangeForReview;
let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;
let processAgentStream: typeof import('../src/runner/stream').processAgentStream;
let createAwaitHumanTool: typeof import('../src/tools/await-human').createAwaitHumanTool;
let maybeMockAwaitHuman: typeof import('../src/runner/mock-tools').maybeMockAwaitHuman;
let resetMockGateDecisions: typeof import('../src/runner/mock-tools').__resetMockGateDecisions;
let initStorage: typeof import('../src/storage').initStorage;
let SessionManager: typeof import('../src/session').SessionManager;
let LEASE_FILENAME: string;
let GATE_SEAL_FILENAME: string;

beforeAll(async () => {
  ({ withGateVerify, renderGatePayload } = await import('../src/verify/gate'));
  ({ extractGateCandidates, renderChangeForReview } = await import('../src/verify/candidates'));
  ({ executeAgentCore } = await import('../src/runner/execution'));
  ({ processAgentStream } = await import('../src/runner/stream'));
  ({ createAwaitHumanTool } = await import('../src/tools/await-human'));
  ({ maybeMockAwaitHuman, __resetMockGateDecisions: resetMockGateDecisions } = await import('../src/runner/mock-tools'));
  ({ initStorage } = await import('../src/storage'));
  ({ SessionManager } = await import('../src/session'));
  ({ LEASE_FILENAME } = await import('../src/runner/approval-lease'));
  ({ GATE_SEAL_FILENAME } = await import('../src/runner/gate-seal'));
});

beforeEach(() => judgeOutputMock.mockReset());

const options = {
  config: { criteria: 'safe and accurate', maxRedos: 3 },
  agentModel: 'mock:model',
  task: 'Prepare two candidate posts with their exact media.',
};

function suspendingGate() {
  const suspend = mock(async () => {
    throw new Error('SUSPENDED');
  });
  return { gate: withGateVerify({ description: 'gate', inputSchema: {}, execute: suspend } as any, options), suspend };
}

const failB = {
  status: 'verdict',
  verdict: { pass: false, critique: 'B fails', candidates: [{ id: 'A', pass: true }, { id: 'B', pass: false, critique: 'B fails' }] },
};
const failA = {
  status: 'verdict',
  verdict: { pass: false, critique: 'A is wrong now', candidates: [{ id: 'A', pass: false, critique: 'A is wrong now' }, { id: 'B', pass: true }] },
};

const slate = (changes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  prompt: 'Pick a post',
  options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
  changes,
  ...extra,
});

describe('settled passes cover what the judge reviewed', () => {
  it('re-judges a settled candidate whose media changed', async () => {
    const { gate, suspend } = suspendingGate();
    judgeOutputMock.mockResolvedValueOnce(failB);
    const first = await gate.execute!(slate([
      { optionId: 'A', content: 'post A', media_urls: ['https://safe.example/a.png'] },
      { optionId: 'B', content: 'post B v1' },
    ]) as never, {} as never) as { status: string };
    expect(first.status).toBe('rejected');

    judgeOutputMock.mockResolvedValueOnce(failA);
    const second = await gate.execute!(slate([
      { optionId: 'A', content: 'post A', media_urls: ['https://changed.example/wrong.png'] },
      { optionId: 'B', content: 'post B v2' },
    ]) as never, {} as never) as { status: string; comment: string };
    expect(second.status).toBe('rejected');
    expect(second.comment).toContain('A is wrong now');
    expect(suspend).not.toHaveBeenCalled();
    expect((judgeOutputMock.mock.calls[1]![0] as any).input.settledCandidateIds).toBeUndefined();
  });

  it('re-judges a settled candidate whose exact command changed under the same display text', async () => {
    const { gate, suspend } = suspendingGate();
    judgeOutputMock.mockResolvedValueOnce(failB);
    await gate.execute!(slate([
      { optionId: 'A', content: "postctl publish --account @safe --body 'same visible post'", displayContent: 'same visible post' },
      { optionId: 'B', content: 'post B v1' },
    ]) as never, {} as never);

    judgeOutputMock.mockResolvedValueOnce(failA);
    const second = await gate.execute!(slate([
      { optionId: 'A', content: "postctl publish --account @wrong --body 'same visible post'", displayContent: 'same visible post' },
      { optionId: 'B', content: 'post B v2' },
    ]) as never, {} as never) as { status: string };
    expect(second.status).toBe('rejected');
    expect(suspend).not.toHaveBeenCalled();
    expect((judgeOutputMock.mock.calls[1]![0] as any).input.settledCandidateIds).toBeUndefined();
  });

  it('settles nothing once the request context changed, and judges an otherwise all-settled gate', async () => {
    const { gate, suspend } = suspendingGate();
    const changes = [{ optionId: 'A', content: 'post A' }, { optionId: 'B', content: 'post B' }];
    judgeOutputMock.mockResolvedValueOnce({
      status: 'verdict',
      verdict: { pass: true, candidates: [{ id: 'A', pass: true }, { id: 'B', pass: true }] },
    });
    await expect(gate.execute!(slate(changes, { reference: { url: 'https://example.com/right', excerpt: 'Right thread' } }) as never, {} as never))
      .rejects.toThrow('SUSPENDED');

    // Same candidates, different destination: the judge must look again.
    judgeOutputMock.mockResolvedValueOnce({
      status: 'verdict',
      verdict: { pass: false, critique: 'Wrong thread', candidates: [{ id: 'A', pass: false, critique: 'Wrong thread' }, { id: 'B', pass: false, critique: 'Wrong thread' }] },
    });
    const second = await gate.execute!(slate(changes, { reference: { url: 'https://example.com/wrong', excerpt: 'Wrong thread' } }) as never, {} as never) as { status: string };
    expect(judgeOutputMock).toHaveBeenCalledTimes(2);
    expect((judgeOutputMock.mock.calls[1]![0] as any).input.settledCandidateIds).toBeUndefined();
    expect(second.status).toBe('rejected');
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('composes the gate payload, the candidate identity and the card identity from one renderer', async () => {
    const toolChange = { optionId: 'A', label: 'Post', content: 'cmd --body x', displayContent: 'x', media_urls: ['https://m.example/a.png'] };
    const cardChange = { optionId: 'A', label: 'Post', content: 'cmd --body x', displayContent: 'x', mediaUrls: ['https://m.example/a.png'] };
    const text = renderChangeForReview(toolChange);
    expect(text).toBe('x\n\nExact command:\ncmd --body x\n\nMedia for review:\nhttps://m.example/a.png');
    expect(extractGateCandidates({ changes: [toolChange] })[0]!.text).toBe(text);
    expect(extractGateCandidates({ changes: [cardChange] })[0]!.text).toBe(text);
    expect(await renderGatePayload({ changes: [toolChange] })).toContain(`Reviewer choice: A [A]\n${text}`);
    // A plain content-only change keeps its old identity byte for byte.
    expect(renderChangeForReview({ content: '  post A  ' })).toBe('post A');
  });
});

describe('a whole-request judge failure', () => {
  const twoPosts = slate([{ optionId: 'A', content: 'post A' }, { optionId: 'B', content: 'post B' }], { prompt: 'Publish both to the wrong account?' });
  const requestFailure = {
    status: 'verdict',
    verdict: { pass: false, critique: 'The approval request targets the wrong destination.', candidates: [{ id: 'A', pass: true }, { id: 'B', pass: true }] },
  };

  it('stays a failure when every candidate row passed', async () => {
    const { gate, suspend } = suspendingGate();
    judgeOutputMock.mockResolvedValueOnce(requestFailure);
    const result = await gate.execute!(twoPosts as never, {} as never) as { status: string; comment: string };
    expect(result.status).toBe('rejected');
    expect(result.comment).toContain('wrong destination');
    expect(suspend).not.toHaveBeenCalled();
  });

  it('settles no row, so an identical resubmission is judged again', async () => {
    const { gate, suspend } = suspendingGate();
    judgeOutputMock.mockResolvedValueOnce(requestFailure);
    await gate.execute!(twoPosts as never, {} as never);
    judgeOutputMock.mockResolvedValueOnce(requestFailure);
    const second = await gate.execute!(twoPosts as never, {} as never) as { status: string };
    expect(judgeOutputMock).toHaveBeenCalledTimes(2);
    expect((judgeOutputMock.mock.calls[1]![0] as any).input.settledCandidateIds).toBeUndefined();
    expect(second.status).toBe('rejected');
    expect(suspend).not.toHaveBeenCalled();
  });

  it('blocks a fresh-mode gate instead of failing open', async () => {
    const suspend = mock(async () => {
      throw new Error('SUSPENDED');
    });
    const gate = withGateVerify(
      { description: 'gate', inputSchema: {}, execute: suspend } as any,
      { ...options, config: { ...options.config, gateReview: 'fresh' as const } },
    );
    judgeOutputMock.mockResolvedValueOnce(requestFailure);
    const result = await gate.execute!(twoPosts as never, {} as never) as { status: string; source: string };
    expect(result).toMatchObject({ status: 'rejected', source: 'pre-review' });
    expect(suspend).not.toHaveBeenCalled();
  });
});

describe('inline gate resolution', () => {
  afterEach(() => {
    delete process.env.AGENTUSE_MOCK_MODE;
    delete process.env.AGENTUSE_MOCK_MODEL;
    delete process.env.AGENTUSE_MOCK_APPROVAL;
  });

  it('ends the gate cycle: a later gate gets its own judge look', async () => {
    const approveInline = mock(async () => ({ status: 'approved' }));
    const gate = withGateVerify({ description: 'gate', inputSchema: {}, execute: approveInline } as any, options);
    const input = { prompt: 'Approve?', changes: [{ label: 'Post', content: 'same text' }] };
    judgeOutputMock.mockResolvedValue({ status: 'verdict', verdict: { pass: true, candidates: [{ id: 'change-1', pass: true }] } });

    expect(await gate.execute!(input as never, {} as never)).toEqual({ status: 'approved' });
    expect(await gate.execute!(input as never, {} as never)).toEqual({ status: 'approved' });
    expect(judgeOutputMock).toHaveBeenCalledTimes(2);
  });

  it('turns a mocked approve on an exhausted strict-review gate into revision guidance', async () => {
    process.env.AGENTUSE_MOCK_MODE = '1';
    process.env.AGENTUSE_MOCK_APPROVAL = 'approve';
    resetMockGateDecisions();
    const gate = withGateVerify(
      maybeMockAwaitHuman(createAwaitHumanTool()),
      { ...options, config: { ...options.config, gateReview: 'fresh' as const, maxRedos: 1 } },
    );
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'Unsafe draft.' } });
    const result = await gate.execute!({
      prompt: 'Approve?', changes: [{ label: 'Post', content: 'unsafe text' }],
    } as never, { toolCallId: 'gate-fresh' } as never);
    expect(result).toEqual({ status: 'commented', comment: 'Unsafe draft.' });
  });
});

describe('mocked decisions at the execution barrier', () => {
  let storageRoot: string;
  let sessionManager: InstanceType<typeof SessionManager>;
  let sessionID: string;
  let sessionDir: string;
  const agentId = 'agents/gate-invariants';
  const command = 'publish unsafe-draft';
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
  const turn = (parts: unknown[], finishReason = 'tool-calls') => [
    { type: 'stream-start', warnings: [] },
    ...parts,
    { type: 'finish', finishReason: { unified: finishReason, raw: finishReason }, usage },
  ];
  const toolCall = (toolCallId: string, toolName: string, input: unknown) => ({
    type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input),
  });
  const done = turn([
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'done' },
    { type: 'text-end', id: 't1' },
  ], 'stop');
  const gateCall = (id: string) => toolCall(id, 'await_human', { prompt: 'Publish?', changes: [{ label: 'Post', content: command }] });

  beforeEach(async () => {
    process.env.AGENTUSE_MOCK_MODE = '1';
    process.env.AGENTUSE_MOCK_MODEL = 'mock:model';
    process.env.AGENTUSE_MOCK_APPROVAL = 'approve';
    resetMockGateDecisions();
    storageRoot = await mkdtemp(join(tmpdir(), 'agentuse-gate-invariants-'));
    process.env.XDG_DATA_HOME = storageRoot;
    await initStorage(storageRoot);
    sessionManager = new SessionManager();
    sessionID = await sessionManager.createSession({
      agent: { id: agentId, name: 'gate-invariants', isSubAgent: false },
      model: 'mock:model', version: 'test', config: {},
      project: { root: storageRoot, cwd: storageRoot },
    });
    sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
  });

  afterEach(async () => {
    delete process.env.AGENTUSE_MOCK_MODE;
    delete process.env.AGENTUSE_MOCK_MODEL;
    delete process.env.AGENTUSE_MOCK_APPROVAL;
    delete process.env.XDG_DATA_HOME;
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function run(turns: unknown[][], config: Record<string, unknown>) {
    let modelCalls = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream(turns[Math.min(modelCalls++, turns.length - 1)] as any),
      }),
    });
    const bashExecute = mock(async () => ({ output: 'executed', exitCode: 0 }));
    const tools = {
      await_human: withGateVerify(maybeMockAwaitHuman(createAwaitHumanTool()), {
        config: { criteria: 'safe and accurate', maxRedos: 2, ...config } as any,
        agentModel: 'mock:model',
        task: 'Publish only after the gate judge passes.',
      }),
      tools__bash: tool({
        description: 'fake bash',
        inputSchema: z.object({ command: z.string() }),
        execute: bashExecute,
      }),
    };
    const agent = {
      name: 'gate-invariants',
      instructions: 'test',
      config: { model: 'mock:model', approval: true, tools: { bash: { commands: ['publish *'], gated: ['publish *'] } } },
    } as any;
    const result = await processAgentStream(executeAgentCore(agent, tools as any, {
      userMessage: 'go', systemMessages: [], maxSteps: 5,
      sessionManager, sessionID, agentId,
    }), { quiet: true });
    return { result, bashExecute };
  }

  it('revokes a mocked approval the judge then bounced', async () => {
    judgeOutputMock.mockResolvedValue({ status: 'verdict', verdict: { pass: false, critique: 'Unsafe draft must not publish.' } });
    const { result, bashExecute } = await run([
      turn([gateCall('gate-1')]),
      turn([toolCall('bash-1', 'tools__bash', { command })]),
      done,
    ], {});
    expect(Boolean(result.suspended)).toBe(false);
    expect(judgeOutputMock).toHaveBeenCalledTimes(1);
    expect(bashExecute).not.toHaveBeenCalled();
    expect(fs.existsSync(join(sessionDir, LEASE_FILENAME))).toBe(false);
  });

  it('leaves no seal from a mocked reject the judge pre-empted', async () => {
    process.env.AGENTUSE_MOCK_APPROVAL = 'reject';
    judgeOutputMock
      .mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'Needs one more fix.' } })
      .mockResolvedValueOnce({ status: 'verdict', verdict: { pass: true } });
    await run([
      turn([gateCall('gate-1')]),
      turn([gateCall('gate-2')]),
      done,
    ], {});
    // The re-gate reached the judge instead of the terminal seal; the seal on
    // disk now comes from the reject the reviewer actually returned on it.
    expect(judgeOutputMock).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(join(sessionDir, GATE_SEAL_FILENAME))).toBe(true);
  });

  it('grants no lease when strict review escalates the gate', async () => {
    judgeOutputMock.mockResolvedValue({ status: 'verdict', verdict: { pass: false, critique: 'Unsafe draft must not publish.' } });
    const { bashExecute } = await run([
      turn([gateCall('gate-1')]),
      turn([toolCall('bash-1', 'tools__bash', { command })]),
      done,
    ], { gateReview: 'fresh', maxRedos: 1 });
    expect(judgeOutputMock).toHaveBeenCalledTimes(1);
    expect(bashExecute).not.toHaveBeenCalled();
    expect(fs.existsSync(join(sessionDir, LEASE_FILENAME))).toBe(false);
  });
});
