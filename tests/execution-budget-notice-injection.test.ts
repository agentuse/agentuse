import { beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';
import { ExecutionBudget, BUDGET_WRAP_UP_NOTICE } from '../src/runner/execution-budget';
import type { RunOutcome } from '../src/tools/report-outcome';

// The real SDK step loop cannot be driven from a mock language model here, so
// the notice's placement is asserted against the prepareStep the runner hands
// to streamText. That is the exact hook the retention behavior lives in.
mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

const streamConfigs: any[] = [];
const streamTextMock = mock((config: any) => {
  streamConfigs.push(config);
  return {
    stream: (async function* () {
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    })(),
    response: Promise.resolve({ messages: [] }),
    responseMessages: Promise.resolve([]),
  };
});
mock.module('ai', () => ({
  streamText: streamTextMock,
  isStepCount: mock((n: number) => ({ isStepCount: n })),
  ...aiSdkErrorMocks(),
}));

let executeAgentCore: typeof import('../src/runner/execution').executeAgentCore;
beforeAll(async () => {
  ({ executeAgentCore } = await import('../src/runner/execution'));
});
beforeEach(() => {
  streamConfigs.length = 0;
  streamTextMock.mockClear();
});

const SYSTEM_PROMPT = 'You are an agent with a long, cacheable system prompt.';

/** Runs one segment and hands back the prepareStep the runner installed. */
async function capturePrepareStep(budget: ExecutionBudget, model: string) {
  const outcome = { complete: { headline: 'already reported' } } as unknown as RunOutcome;
  for await (const _chunk of executeAgentCore(
    { name: 'budget-agent', instructions: 'work', config: { model } } as any,
    {} as any,
    {
      userMessage: 'go',
      systemMessages: [{ role: 'system', content: SYSTEM_PROMPT }],
      maxSteps: 2,
      abortSignal: budget.signal,
      executionBudget: budget,
      runOutcome: outcome,
    } as any,
  )) { /* drain */ }
  expect(streamConfigs).toHaveLength(1);
  return streamConfigs[0].prepareStep as (arg: { messages: any[] }) => Promise<{ messages: any[] }>;
}

/** A budget already past the 80% mark, with the notice taken. */
async function deliveredBudget() {
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const budget = new ExecutionBudget(10_000);
    now += 9_000;
    expect(await budget.takeNotice()).toBe(BUDGET_WRAP_UP_NOTICE);
    return budget;
  } finally {
    clock.mockRestore();
  }
}

it('appends the wrap-up notice as a trailing user turn, and keeps it on later steps', async () => {
  const budget = await deliveredBudget();
  try {
    const prepareStep = await capturePrepareStep(budget, 'openai:gpt-test');

    const first = await prepareStep({ messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'go' },
    ] });
    expect(first.messages.at(-1)).toEqual({ role: 'user', content: BUDGET_WRAP_UP_NOTICE });

    // A later step: more history, and the notice is re-appended at the tail
    // rather than left buried behind the new turns.
    const later = await prepareStep({ messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'working' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read', output: 'ok' }] },
    ] });
    expect(later.messages.at(-1)).toEqual({ role: 'user', content: BUDGET_WRAP_UP_NOTICE });
    expect(JSON.stringify(later.messages)).toContain(BUDGET_WRAP_UP_NOTICE);
  } finally {
    await budget.finish();
  }
});

it('never emits a second system message, which Bedrock rejects mid-conversation', async () => {
  const budget = await deliveredBudget();
  try {
    const prepareStep = await capturePrepareStep(budget, 'bedrock:anthropic.claude-test');
    const prepared = await prepareStep({ messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'working' },
    ] });
    expect(prepared.messages.filter(message => message.role === 'system')).toHaveLength(1);
  } finally {
    await budget.finish();
  }
});

it('leaves the Anthropic system cache breakpoint on the real system prompt', async () => {
  const budget = await deliveredBudget();
  try {
    const prepareStep = await capturePrepareStep(budget, 'anthropic:claude-test');
    const prepared = await prepareStep({ messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'working' },
    ] });
    const system = prepared.messages.find(message => message.role === 'system');
    expect(system.content).toBe(SYSTEM_PROMPT);
    // The stable prefix keeps its breakpoint; without it every remaining step
    // re-reads the whole system prefix at full price.
    expect(system.providerOptions?.anthropic?.cacheControl).toBeDefined();
  } finally {
    await budget.finish();
  }
});
