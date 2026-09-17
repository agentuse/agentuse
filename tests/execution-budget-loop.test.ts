import { expect, it, mock, spyOn } from 'bun:test';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { ExecutionBudget, BUDGET_WRAP_UP_NOTICE } from '../src/runner/execution-budget';
import { createReportCompleteTool } from '../src/tools/report-outcome';
import type { RunOutcome } from '../src/tools/report-outcome';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({ createModel: async () => currentModel }));
const { executeAgentCore } = await import('../src/runner/execution');
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

it('delivers the notice after a useful operation completes and retains it on later model steps', async () => {
  const previousCodeMode = process.env.AGENTUSE_CODE_MODE;
  process.env.AGENTUSE_CODE_MODE = '0';
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const budget = new ExecutionBudget(10_000);
  const outcome: RunOutcome = {};
  let steps = 0;
  let finishedOperation = false;
  const prompts: string[] = [];
  currentModel = new MockLanguageModelV3({
    doStream: async (options: any) => {
      prompts.push(JSON.stringify(options.prompt));
      steps++;
      if (steps > 1) {
        expect(finishedOperation).toBe(true);
        expect(prompts.at(-1)).toContain(BUDGET_WRAP_UP_NOTICE);
      }
      const toolName = steps === 1 ? 'read_source' : steps === 2 ? 'record_evidence' : 'report_complete';
      return { stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: `call-${steps}`, toolName, input: steps === 3 ? JSON.stringify({ headline: 'Verified the requested fact.' }) : '{}' },
        { type: 'finish', finishReason: 'tool-calls', usage },
      ] as any) };
    },
  });
  try {
    const agent: any = { name: 'budget-test', instructions: 'Verify one fact.', config: { model: 'openai:gpt-5.6-luna' } };
    const chunks = [];
    for await (const chunk of executeAgentCore(agent, {
      read_source: { description: 'Read source', inputSchema: z.object({}), execute: async () => {
        now += 8_000;
        expect(budget.signal.aborted).toBe(false);
        expect(budget.snapshot().noticeDeliveredAt).toBeUndefined();
        finishedOperation = true;
        return 'The requested fact is established.';
      } },
      record_evidence: { description: 'Record established evidence', inputSchema: z.object({}), execute: async () => 'Recorded' },
      report_complete: createReportCompleteTool(outcome),
    }, { userMessage: 'Verify one fact.', systemMessages: [], maxSteps: 5, abortSignal: budget.signal, executionBudget: budget, runOutcome: outcome })) chunks.push(chunk);
    expect(prompts[0]).not.toContain(BUDGET_WRAP_UP_NOTICE);
    expect(steps).toBe(3);
    expect(chunks.filter(c => c.type === 'error')).toEqual([]);
    expect(outcome.complete?.headline).toBe('Verified the requested fact.');
    expect(await budget.takeNotice()).toBeUndefined();
  } finally { await budget.finish(); clock.mockRestore();
    if (previousCodeMode === undefined) delete process.env.AGENTUSE_CODE_MODE;
    else process.env.AGENTUSE_CODE_MODE = previousCodeMode;
  }
});

it('an internal helper sharing cancellation cannot consume its parent notice', async () => {
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const budget = new ExecutionBudget(10_000);
  now += 8_000;
  const outcome: RunOutcome = {};
  currentModel = new MockLanguageModelV3({
    doStream: async (options: any) => {
      expect(JSON.stringify(options.prompt)).not.toContain(BUDGET_WRAP_UP_NOTICE);
      return { stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'helper-done', toolName: 'report_complete', input: JSON.stringify({ headline: 'Review finished.' }) },
        { type: 'finish', finishReason: 'tool-calls', usage },
      ] as any) };
    },
  });
  try {
    for await (const _chunk of executeAgentCore({ name: 'helper', instructions: 'Review', config: { model: 'openai:gpt-5.6-luna' } } as any,
      { report_complete: createReportCompleteTool(outcome) },
      { userMessage: 'Review', systemMessages: [], maxSteps: 2, abortSignal: budget.signal, runOutcome: outcome })) { /* drain */ }
    expect(budget.snapshot().noticeDeliveredAt).toBeUndefined();
    expect(await budget.takeNotice()).toBe(BUDGET_WRAP_UP_NOTICE);
  } finally { await budget.finish(); clock.mockRestore(); }
});
