import { expect, it, mock, spyOn } from 'bun:test';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { ExecutionBudget, BUDGET_WRAP_UP_NOTICE } from '../src/runner/execution-budget';
import { createReportCompleteTool } from '../src/tools/report-outcome';
import type { RunOutcome } from '../src/tools/report-outcome';

let currentModel: MockLanguageModelV3;
mock.module('../src/models', () => ({ createModel: async () => currentModel }));
const { executeAgentCore } = await import('../src/runner/execution');
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

// A mock language model drives exactly one SDK step here: the step loop needs
// real tool results to continue, which this harness cannot produce. Notice
// placement and retention across steps are asserted against prepareStep in
// tests/execution-budget-notice-injection.test.ts instead.

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
