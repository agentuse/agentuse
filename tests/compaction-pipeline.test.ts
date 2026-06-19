/**
 * Compaction pipeline integration test.
 *
 * Unit tests (compaction.test.ts / compaction-loop.test.ts) cover the trigger
 * math and the once-per-crossing loop. This drives the full executeAgentCore
 * pipeline with a real ContextManager + a capturing SessionManager + a logger
 * spy to assert the two things only a real run produces: the persisted
 * compaction MARKER (the data the CLI/serve UI renders) and the console LOG
 * wording, across all three paths:
 *
 *   1. mid-run window pressure   → marker reason 'limit',    log "approaching limit"
 *   2. approval gate, default    → NO marker                 (the 7% bug fix)
 *   3. approval gate, opt-in     → marker reason 'approval',  log "at approval gate"
 *
 * Deterministic (mock model) so it belongs in the default `pnpm test` suite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SuspendSignal } from '../src/runner/suspend';
import { logger } from '../src/utils/logger';

// Pin a small window so a single oversized tool result crosses 70% (7000 tokens).
mock.module('../src/utils/models-api', () => ({
  getModelInfo: mock(async () => ({ modelId: 'test-model', contextLimit: 10000, outputLimit: 4096 })),
}));
mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

const streamTextMock = mock((_config: any): any => ({ fullStream: (async function* () {})() }));
mock.module('ai', () => ({
  streamText: streamTextMock,
  stepCountIs: mock((n: number) => ({ stepCountIs: n })),
  // executeAgentCore pulls in api-error.ts, which imports APICallError from 'ai'.
  APICallError: { isInstance: () => false },
}));

const isSummarizer = (config: any) =>
  typeof config?.messages?.[0]?.content === 'string' && config.messages[0].content.includes('summarizer');
const summarizerStream = () => ({
  fullStream: (async function* () {
    yield { type: 'text-delta', text: 'folded summary' };
    yield { type: 'finish', finishReason: 'stop' };
  })(),
});

let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;
beforeAll(async () => { ({ executeAgentCore } = await import('../src/runner/execution')); });

// Capturing SessionManager: records the compaction markers executeAgentCore persists.
let compactionParts: any[] = [];
const sessionManager = {
  addPart: mock(async (_s: string, _a: string, _m: string, part: any) => {
    if (part?.type === 'compaction') compactionParts.push(part);
  }),
  writeContextSnapshot: mock(async () => {}),
  writeToolOutputArtifact: mock(async () => undefined),
} as any;
const sessionOpts = { sessionManager, sessionID: 'sess-1', agentId: 'agent-1', messageID: 'msg-1' };

let infoLines: string[] = [];
let infoSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  compactionParts = [];
  infoLines = [];
  streamTextMock.mockReset();
  sessionManager.addPart.mockClear();
  infoSpy = spyOn(logger, 'info').mockImplementation((msg: string) => { infoLines.push(String(msg)); });
  delete process.env.APPROVAL_COMPACTION_MIN_TOKENS;
});
afterEach(() => { infoSpy.mockRestore(); });

// A 7-message conversation: head (system + task) + a foldable middle + recent tail.
const suspendMessages = () => [
  { role: 'system', content: 'old system context' },
  { role: 'user', content: 'old user task' },
  { role: 'assistant', content: 'old middle 1' },
  { role: 'user', content: 'old middle 2' },
  { role: 'assistant', content: 'recent assistant context 1' },
  { role: 'tool', content: [{ type: 'tool-result', output: 'recent tool context' }] },
  { role: 'user', content: 'recent user context 2' },
];

// A streamText sequence that suspends at an await_human approval gate.
function suspendThenSummarize() {
  let call = 0;
  streamTextMock.mockImplementation((config: any) => {
    if (isSummarizer(config)) return summarizerStream();
    call++;
    return {
      fullStream: (async function* () {
        yield { type: 'tool-call', toolCallId: 'c1', toolName: 'await_human', input: { prompt: 'Approve?' } };
        yield {
          type: 'tool-error', toolCallId: 'c1', toolName: 'await_human',
          error: new SuspendSignal({ kind: 'await_human', prompt: 'Approve?', resumeToken: `t${call}` }),
        };
      })(),
    };
  });
}

async function drain(gen: AsyncGenerator<any>) {
  const chunks: any[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('compaction pipeline: marker + log behavior', () => {
  it('mid-run window pressure persists a "limit" marker and logs "approaching limit"', async () => {
    let main = 0;
    streamTextMock.mockImplementation((config: any) => {
      if (isSummarizer(config)) return summarizerStream();
      main++;
      if (main === 1) {
        return {
          fullStream: (async function* () {
            yield { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: 'big.log' } };
            yield { type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: 'ok' };
            yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 8000, outputTokens: 50, totalTokens: 8050 } };
          })(),
          // Reconstructed history carries a huge tool result → over the 7000 threshold.
          response: Promise.resolve({ messages: [
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: {} }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_file', output: { type: 'text', value: 'x'.repeat(40000) } }] },
            { role: 'assistant', content: 'analysis so far' },
          ] }),
        };
      }
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } };
        })(),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'done' }] }),
      };
    });

    await drain(executeAgentCore(
      { name: 'pipe-agent', config: { model: 'demo:test' } } as any,
      { read_file: { description: 'Read a file' } as any },
      { userMessage: 'read the big log', systemMessages: [{ role: 'system', content: 'you are an agent' }], maxSteps: 10, ...sessionOpts },
    ));

    expect(compactionParts).toHaveLength(1);
    expect(compactionParts[0]).toMatchObject({ type: 'compaction', reason: 'limit' });
    expect(typeof compactionParts[0].tokensBefore).toBe('number');
    expect(typeof compactionParts[0].tokensAfter).toBe('number');
    expect(infoLines.some((l) => /approaching limit/i.test(l))).toBe(true);
    expect(infoLines.some((l) => /approval gate/i.test(l))).toBe(false);
  });

  it('approval gate with the default floor (off) persists NO marker and never logs "approval gate"', async () => {
    suspendThenSummarize();

    const chunks = await drain(executeAgentCore(
      { name: 'pipe-agent', config: { model: 'demo:test' } } as any,
      {},
      { userMessage: 'unused', systemMessages: [], messages: suspendMessages() as any, maxSteps: 3, ...sessionOpts },
    ));

    expect(chunks.some((c) => c.type === 'suspended')).toBe(true);
    expect(compactionParts).toHaveLength(0);                       // the 7% fix
    expect(infoLines.some((l) => /approval gate/i.test(l))).toBe(false);
    // Only the main stream ran — no summarizer compaction stream.
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it('approval gate with the floor opted in persists an "approval" marker and logs "at approval gate"', async () => {
    process.env.APPROVAL_COMPACTION_MIN_TOKENS = '1';
    suspendThenSummarize();

    const chunks = await drain(executeAgentCore(
      { name: 'pipe-agent', config: { model: 'demo:test' } } as any,
      {},
      { userMessage: 'unused', systemMessages: [], messages: suspendMessages() as any, maxSteps: 3, ...sessionOpts },
    ));

    expect(chunks.some((c) => c.type === 'suspended')).toBe(true);
    expect(compactionParts).toHaveLength(1);
    expect(compactionParts[0]).toMatchObject({ type: 'compaction', reason: 'approval' });
    expect(infoLines.some((l) => /at approval gate/i.test(l))).toBe(true);
    expect(infoLines.some((l) => /approaching limit/i.test(l))).toBe(false);
  });
});
