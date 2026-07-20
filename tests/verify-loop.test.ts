import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import type { ModelMessage } from 'ai';

// Ensure no module mocks leak from other files
mock.restore();

const judgeOutputMock = mock(async (_params: unknown): Promise<unknown> => ({
  status: 'verdict',
  verdict: { pass: true },
}));
const rehydrateMessagesMock = mock(async (): Promise<ModelMessage[]> => []);

mock.module('../src/verify/judge', () => ({
  judgeOutput: judgeOutputMock,
}));
mock.module('../src/session/rehydrate', () => ({
  rehydrateMessages: rehydrateMessagesMock,
}));

let runVerifyLoop: typeof import('../src/runner/verify-loop').runVerifyLoop;
let buildRedoPrompt: typeof import('../src/runner/verify-loop').buildRedoPrompt;

beforeAll(async () => {
  ({ runVerifyLoop, buildRedoPrompt } = await import('../src/runner/verify-loop'));
});

function makeResult(text: string, tokens = 100) {
  return {
    text,
    usage: {
      inputTokens: tokens,
      outputTokens: tokens,
      totalTokens: tokens * 2,
      inputTokenDetails: { noCacheTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: tokens, reasoningTokens: 0 },
    },
    toolCalls: [],
    toolCallTraces: [],
    finishReasons: ['stop'],
    hasTextOutput: true,
    parts: [],
  } as any;
}

function makeSessionManager() {
  const parts: any[] = [];
  return {
    parts,
    addPart: mock(async (_s: string, _a: string, _m: string, part: any) => {
      parts.push(part);
      return 'part-id';
    }),
  } as any;
}

const baseParams = (sessionManager: any, executeRedo: any) => ({
  agent: { name: 'demo', config: { model: 'anthropic:claude-sonnet-4-0' }, instructions: 'Do the task.' } as any,
  task: 'Do the task.',
  sessionManager,
  sessionID: 'ses_1',
  agentId: 'demo',
  messageID: 'msg_1',
  executeRedo,
  quiet: true,
});

beforeEach(() => {
  judgeOutputMock.mockReset();
  rehydrateMessagesMock.mockReset();
  rehydrateMessagesMock.mockImplementation(async () => []);
});

describe('runVerifyLoop', () => {
  it('passes first try without any redo', async () => {
    judgeOutputMock.mockImplementation(async () => ({ status: 'verdict', verdict: { pass: true } }));
    const sessionManager = makeSessionManager();
    const executeRedo = mock(async () => makeResult('unused'));

    const outcome = await runVerifyLoop({
      ...baseParams(sessionManager, executeRedo),
      config: { maxRedos: 1 },
      initialResult: makeResult('first output'),
    });

    expect(outcome.verification?.status).toBe('passed');
    expect(outcome.verification?.redoCount).toBe(0);
    expect(outcome.result.text).toBe('first output');
    expect(executeRedo).toHaveBeenCalledTimes(0);
    expect(sessionManager.parts.filter((p: any) => p.type === 'verify')).toHaveLength(1);
  });

  it('redoes on fail with the critique injected, then passes', async () => {
    let call = 0;
    judgeOutputMock.mockImplementation(async () => {
      call++;
      return call === 1
        ? { status: 'verdict', verdict: { pass: false, critique: 'Add the risks section.' } }
        : { status: 'verdict', verdict: { pass: true } };
    });
    const sessionManager = makeSessionManager();
    const redoCalls: Array<{ messages: ModelMessage[]; prompt: string }> = [];
    const executeRedo = mock(async (messages: ModelMessage[], prompt: string) => {
      redoCalls.push({ messages, prompt });
      return makeResult('revised output', 50);
    });

    const outcome = await runVerifyLoop({
      ...baseParams(sessionManager, executeRedo),
      config: { criteria: 'complete', maxRedos: 1 },
      initialResult: makeResult('first output', 100),
    });

    expect(outcome.verification?.status).toBe('passed');
    expect(outcome.verification?.redoCount).toBe(1);
    expect(outcome.result.text).toBe('revised output');
    // usage merged across attempts
    expect(outcome.result.usage?.totalTokens).toBe(300);
    // the redo turn carries the critique verbatim and the attempt framing
    expect(redoCalls).toHaveLength(1);
    expect(redoCalls[0].prompt).toContain('Add the risks section.');
    expect(redoCalls[0].prompt).toContain('final attempt');
    const lastMessage = redoCalls[0].messages.at(-1) as any;
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('Add the risks section.');
    // fail marker + synthetic redo prompt + pass marker
    const verifyParts = sessionManager.parts.filter((p: any) => p.type === 'verify');
    expect(verifyParts.map((p: any) => p.verdict)).toEqual(['fail', 'pass']);
    expect(sessionManager.parts.some((p: any) => p.type === 'text' && p.synthetic)).toBe(true);
  });

  it('ships the last attempt after exhausting maxRedos', async () => {
    judgeOutputMock.mockImplementation(async () => ({
      status: 'verdict',
      verdict: { pass: false, critique: 'Still missing the risks section.' },
    }));
    const sessionManager = makeSessionManager();
    const executeRedo = mock(async () => makeResult('second try'));

    const outcome = await runVerifyLoop({
      ...baseParams(sessionManager, executeRedo),
      config: { maxRedos: 1 },
      initialResult: makeResult('first output'),
    });

    expect(outcome.verification?.status).toBe('failed');
    expect(outcome.verification?.redoCount).toBe(1);
    expect(outcome.verification?.critique).toContain('risks section');
    expect(outcome.result.text).toBe('second try');
    expect(executeRedo).toHaveBeenCalledTimes(1);
  });

  it('ships unverified on a judge error without redoing', async () => {
    judgeOutputMock.mockImplementation(async () => ({ status: 'error', detail: 'auth expired' }));
    const sessionManager = makeSessionManager();
    const executeRedo = mock(async () => makeResult('unused'));

    const outcome = await runVerifyLoop({
      ...baseParams(sessionManager, executeRedo),
      config: { maxRedos: 1 },
      initialResult: makeResult('first output'),
    });

    expect(outcome.verification?.status).toBe('error');
    expect(outcome.verification?.critique).toBe('auth expired');
    expect(outcome.result.text).toBe('first output');
    expect(executeRedo).toHaveBeenCalledTimes(0);
    const verifyParts = sessionManager.parts.filter((p: any) => p.type === 'verify');
    expect(verifyParts.map((p: any) => p.verdict)).toEqual(['error']);
  });

  it('bails without a verdict when a redo suspends on an approval gate', async () => {
    judgeOutputMock.mockImplementation(async () => ({
      status: 'verdict',
      verdict: { pass: false, critique: 'Needs approval-worthy changes.' },
    }));
    const sessionManager = makeSessionManager();
    const executeRedo = mock(async () => ({ ...makeResult('partial'), suspended: true }));

    const outcome = await runVerifyLoop({
      ...baseParams(sessionManager, executeRedo),
      config: { maxRedos: 2 },
      initialResult: makeResult('first output'),
    });

    expect(outcome.verification).toBeUndefined();
    expect(outcome.result.suspended).toBe(true);
  });
});

describe('buildRedoPrompt', () => {
  it('includes criteria, attempt framing, and the directives', () => {
    const prompt = buildRedoPrompt({
      critique: 'Cut the filler.',
      config: { criteria: 'be concise', maxRedos: 2 },
      redoNumber: 1,
    });
    expect(prompt).toContain('Criteria: be concise');
    expect(prompt).toContain('Attempt: 2 of 3');
    expect(prompt).not.toContain('final attempt');
    expect(prompt).toContain('Cut the filler.');
    expect(prompt).toContain('Do not argue');
    expect(prompt).toContain('do not repeat side-effectful actions');
  });

  it('labels the judge agent and flags the final attempt', () => {
    const prompt = buildRedoPrompt({
      critique: 'X',
      config: { judge: './shared/judge.agentuse', maxRedos: 1 },
      redoNumber: 1,
    });
    expect(prompt).toContain('Judged by: ./shared/judge.agentuse');
    expect(prompt).toContain('(final attempt)');
  });
});
