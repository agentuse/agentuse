import { describe, expect, it, mock } from 'bun:test';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { ReplayDispatcher, type ReplayRecording } from '../src/replay/recording';
process.env.CONTEXT_COMPACTION = 'false';
let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({
  createModel: async () => currentModel,
  AuthenticationError: class AuthenticationError extends Error {},
}));
const { executeAgentCore } = await import('../src/runner/execution');
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const call = (id: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) });
function model(turns: unknown[][], finalReason = 'tool-calls') {
  let count = 0;
  const prompts: unknown[] = [];
  currentModel = new MockLanguageModelV3({ doStream: async (options: any) => {
    prompts.push(options.prompt);
    const turn = turns[count++];
    if (!turn) throw new Error('Unexpected extra model step');
    return { stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      ...turn,
      { type: 'finish', finishReason: { unified: count === turns.length ? finalReason : 'tool-calls', raw: undefined }, usage },
    ] as any) };
  } });
  return { calls: () => count, prompts };
}
function dispatcher(command = 'read source') {
  const recording: ReplayRecording = { sessionId: 'old', model: 'demo:test', createdAt: 1, cwd: '/project', sourceTask: 'OLD INSTRUCTIONS', original: { text: 'OLD DRAFT' },
    calls: [{ id: 'old-read', type: 'tool', tool: 'tools__bash', state: { status: 'completed', input: { command }, output: { output: 'fixed external source' }, time: { start: 1, end: 2 } } } as any],
    tools: { tools: ['tools__bash', 'await_human', 'report_complete'].map(name => ({ name, inputSchema: { type: 'object', additionalProperties: true } })) } };
  return new ReplayDispatcher(recording, [], '/project');
}
async function run(replay: ReplayDispatcher) {
  const chunks = [];
  for await (const chunk of executeAgentCore({ name: 'test', instructions: 'CURRENT INSTRUCTIONS', config: { model: 'demo:test', approval: true, verify: { criteria: 'must not run', maxRedos: 2 }, tools: { bash: { gated: ['publish *'] } } } } as any,
    replay.tools(), { userMessage: 'CURRENT INSTRUCTIONS', systemMessages: [{ role: 'system', content: 'Test' }], maxSteps: 6, replay: { stopped: () => !!replay.stop } })) chunks.push(chunk);
  return chunks;
}
describe('replay through the real AI SDK loop', () => {
  it('replays a recorded gated command without requiring a live execution permit', async () => {
    const replay = dispatcher('publish recorded');
    const m = model([[call('recorded', 'tools__bash', { command: 'publish recorded' })],
      [call('gate', 'await_human', { changes: [{ content: 'publish next' }] })]]);
    const chunks = await run(replay);
    expect(m.calls()).toBe(2);
    expect(replay.trace.map(c => c.source)).toEqual(['recording', 'proposal']);
    expect(replay.stop?.kind).toBe('proposal');
    expect(chunks.find(c => c.type === 'tool-result' && c.toolCallId === 'recorded'))
      .toMatchObject({ toolSuccess: true, toolResult: 'fixed external source' });
    expect(JSON.stringify(m.prompts)).not.toContain('APPROVAL_REQUIRED');
  });
  it('replays a read then captures the first proposal and blocks its sibling', async () => {
    const replay = dispatcher();
    const m = model([[call('read', 'tools__bash', { command: 'read source' })],
      [call('gate', 'await_human', { changes: [{ content: 'publish "unterminated', displayContent: 'NEW DRAFT' }] }), call('effect', 'tools__bash', { command: 'publish NEW' })]]);
    const chunks = await run(replay);
    expect(chunks.filter(c => c.type === 'error')).toEqual([]);
    expect(m.calls()).toBe(2);
    expect(replay.stop?.kind).toBe('proposal');
    expect(replay.trace.map(c => c.source)).toEqual(['recording', 'proposal', 'stopped']);
    expect(JSON.stringify(m.prompts)).toContain('fixed external source');
    expect(JSON.stringify(m.prompts)).not.toContain('OLD DRAFT');
  });
  it('ends on a mismatch without a retry, fabrication, or another generation', async () => {
    const replay = dispatcher();
    const m = model([[call('read', 'tools__bash', { command: 'read another source' })]]);
    await run(replay);
    expect(m.calls()).toBe(1);
    expect(replay.stop?.kind).toBe('missing');
  });
  it('ends on ordinary final output without an outcome nudge', async () => {
    const replay = dispatcher();
    const m = model([[{ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'A fresh final output' }, { type: 'text-end', id: 'text' }]], 'stop');
    const chunks = await run(replay);
    expect(m.calls()).toBe(1);
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).toBe('A fresh final output');
    expect(replay.stop).toBeUndefined();
  });
});
