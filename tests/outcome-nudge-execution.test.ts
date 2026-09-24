import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';
import {
  createReportCompleteTool,
  createReportIncompleteTool,
  createReportOutcomeTool,
  type RunOutcome,
} from '../src/tools/report-outcome';
import { OUTCOME_NUDGE_PROMPT } from '../src/runner/outcome';

mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

const streamConfigs: any[] = [];
const completedToolTrace = [
  {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'mail-1',
      toolName: 'read_mail',
      input: { profile: 'default' },
    }],
  },
  {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'mail-1',
      toolName: 'read_mail',
      output: { type: 'text', value: 'No alertable mail; watermark advanced' },
    }],
  },
];

const defaultStreamTextImplementation = (config: any) => {
  streamConfigs.push(config);

  if (streamConfigs.length === 1) {
    return {
      stream: (async function* () {
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
        };
      })(),
      response: Promise.resolve({
        // AI SDK v7 `response` describes only the final step. A final empty
        // stop has no messages even though earlier steps used tools.
        messages: [],
      }),
      responseMessages: Promise.resolve(completedToolTrace),
    };
  }

  return {
    stream: (async function* () {
      const input = { headline: 'Sweep completed and watermarks advanced' };
      const output = await config.tools.report_complete.execute(input);
      yield {
        type: 'tool-call',
        toolCallId: 'outcome-1',
        toolName: 'report_complete',
        input,
      };
      yield {
        type: 'tool-result',
        toolCallId: 'outcome-1',
        toolName: 'report_complete',
        output,
      };
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 120, outputTokens: 10, totalTokens: 130 },
      };
    })(),
    response: Promise.resolve({ messages: [] }),
    responseMessages: Promise.resolve([]),
  };
};
const streamTextMock = mock(defaultStreamTextImplementation);

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
  streamTextMock.mockImplementation(defaultStreamTextImplementation);
});

describe('missing-outcome recovery segment', () => {
  it('does not require an unavailable outcome tool in a legacy resumed snapshot', async () => {
    const outcome: RunOutcome = {};
    for await (const _ of executeAgentCore(
      { name: 'legacy-agent', config: { model: 'demo:test' } } as any,
      {},
      { userMessage: 'Finish the saved run', systemMessages: [], maxSteps: 3, runOutcome: outcome },
    )) { /* consume */ }

    expect(streamConfigs).toHaveLength(1);
    expect(streamConfigs[0].toolChoice).toBe('auto');
    expect(outcome.complete).toBeUndefined();
  });

  it('reserves a constrained outcome turn after parallel calls overshoot maxSteps', async () => {
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      if (streamConfigs.length === 1) {
        return {
          stream: (async function* () {
            yield {
              type: 'tool-call', toolCallId: 'calc-1', toolName: 'code_exec',
              input: { code: 'return 2 + 2' },
            };
            yield {
              type: 'tool-result', toolCallId: 'calc-1', toolName: 'code_exec',
              output: { value: 4 },
            };
            yield {
              type: 'tool-call', toolCallId: 'read-1', toolName: 'read_value',
              input: { key: 'answer' },
            };
            yield {
              type: 'tool-result', toolCallId: 'read-1', toolName: 'read_value',
              output: { label: 'answer' },
            };
            yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          })(),
          response: Promise.resolve({ messages: [] }),
          responseMessages: Promise.resolve([{
            role: 'tool', content: [
              { type: 'tool-result', toolCallId: 'calc-1', toolName: 'code_exec', output: { value: 4 } },
              { type: 'tool-result', toolCallId: 'read-1', toolName: 'read_value', output: { label: 'answer' } },
            ],
          }]),
        };
      }
      return {
        stream: (async function* () {
          const input = { headline: 'Calculated 2 + 2 = 4' };
          const output = await config.tools.report_complete.execute(input);
          yield { type: 'tool-call', toolCallId: 'outcome-1', toolName: 'report_complete', input };
          yield { type: 'tool-result', toolCallId: 'outcome-1', toolName: 'report_complete', output };
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });
    const outcome: RunOutcome = {};
    const tools = {
      code_exec: { description: 'Calculate', execute: async () => ({ value: 4 }) },
      read_value: { description: 'Read a value', execute: async () => ({ label: 'answer' }) },
      report_complete: createReportCompleteTool(outcome),
      report_incomplete: createReportIncompleteTool(outcome),
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'outcome-agent', config: { model: 'demo:test' } } as any,
      tools,
      { userMessage: 'Calculate 2 + 2', systemMessages: [{ role: 'system', content: 'You are an agent' }], maxSteps: 1, runOutcome: outcome },
    )) { /* consume */ }

    expect(streamConfigs).toHaveLength(2);
    expect(Object.keys(streamConfigs[1].tools).sort()).toEqual(['report_complete', 'report_incomplete']);
    expect(streamConfigs[1].toolChoice).toBe('required');
    expect(outcome.complete?.headline).toBe('Calculated 2 + 2 = 4');
  });

  it('does not reserve an outcome turn after a plugin terminates a parallel overshoot', async () => {
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      return {
        stream: (async function* () {
          const firstInput = { key: 'first' };
          const secondInput = { key: 'second' };
          const approval = await config.toolApproval({
            toolCall: { toolName: 'read_value', toolCallId: 'read-1', input: firstInput },
          });
          yield { type: 'tool-call', toolCallId: 'read-1', toolName: 'read_value', input: firstInput };
          yield { type: 'tool-result', toolCallId: 'read-1', toolName: 'read_value', output: approval };
          yield { type: 'tool-call', toolCallId: 'read-2', toolName: 'read_value', input: secondInput };
          yield { type: 'tool-result', toolCallId: 'read-2', toolName: 'read_value', output: { key: 'second' } };
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });
    const outcome: RunOutcome = {};
    const tools = {
      read_value: { description: 'Read a value', execute: async (input: any) => input },
      report_complete: createReportCompleteTool(outcome),
      report_incomplete: createReportIncompleteTool(outcome),
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'outcome-agent', config: { model: 'demo:test' } } as any,
      tools,
      {
        userMessage: 'Read two values',
        systemMessages: [{ role: 'system', content: 'You are an agent' }],
        maxSteps: 1,
        runOutcome: outcome,
        pluginEvents: {
          toolCall: async () => ({ block: true, reason: 'terminal policy', terminate: true }),
        },
      },
    )) { /* consume */ }

    expect(streamConfigs).toHaveLength(1);
    expect(outcome.complete).toBeUndefined();
    expect(outcome.incomplete).toBeUndefined();
  });

  it('does not schedule creator delivery recovery after a plugin terminates', async () => {
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      return {
        stream: (async function* () {
          const input = { reason: "Required tool 'submit_agent_source' is missing from the environment." };
          await config.toolApproval({
            toolCall: { toolName: 'report_incomplete', toolCallId: 'incomplete-1', input },
          });
          const output = await config.tools.report_incomplete.execute(input);
          yield { type: 'tool-call', toolCallId: 'incomplete-1', toolName: 'report_incomplete', input };
          yield { type: 'tool-result', toolCallId: 'incomplete-1', toolName: 'report_incomplete', output };
          yield { type: 'finish', finishReason: 'other', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });
    const outcome: RunOutcome = {};
    const submission: { source?: string } = {};
    const tools = {
      submit_agent_source: { description: 'Submit source', execute: async () => 'Accepted' },
      report_complete: createReportCompleteTool(outcome),
      report_incomplete: createReportIncompleteTool(outcome),
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'creator-agent', config: { model: 'demo:test' } } as any,
      tools,
      {
        userMessage: 'Create an agent',
        systemMessages: [{ role: 'system', content: 'You are an agent creator' }],
        maxSteps: 10,
        runOutcome: outcome,
        agentSourceSubmission: submission,
        pluginEvents: {
          toolCall: async () => ({ block: true, reason: 'terminal policy', terminate: true }),
        },
      },
    )) { /* consume */ }

    expect(streamConfigs).toHaveLength(1);
    expect(outcome.incomplete?.reason).toContain('submit_agent_source');
    expect(submission.source).toBeUndefined();
  });

  it('requires and exposes only outcome tools, then stops on either verdict', async () => {
    const outcome: RunOutcome = {};
    const tools = {
      read_mail: { description: 'Read mail' },
      report_complete: createReportCompleteTool(outcome),
      report_incomplete: createReportIncompleteTool(outcome),
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'outcome-agent', config: { model: 'demo:test' } } as any,
      tools,
      {
        userMessage: 'Sweep both mailboxes',
        systemMessages: [{ role: 'system', content: 'You are an agent' }],
        maxSteps: 10,
        runOutcome: outcome,
      }
    )) {
      // consume
    }

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(streamConfigs[0].toolChoice).toBe('auto');

    const recovery = streamConfigs[1];
    expect(recovery.toolChoice).toBe('required');
    expect(Object.keys(recovery.tools).sort()).toEqual([
      'report_complete',
      'report_incomplete',
    ]);
    expect(recovery.messages.at(-1)).toEqual({
      role: 'user',
      content: OUTCOME_NUDGE_PROMPT,
    });
    expect(recovery.messages).toContainEqual(completedToolTrace[0]);
    expect(recovery.messages).toContainEqual(completedToolTrace[1]);
    expect(outcome.complete?.headline).toBe('Sweep completed and watermarks advanced');

    const incompleteStep = {
      steps: [{
        content: [{ type: 'tool-result', toolName: 'report_incomplete' }],
      }],
    };
    expect(
      recovery.stopWhen.some(
        (predicate: unknown) =>
          typeof predicate === 'function' && Boolean((predicate as Function)(incompleteStep))
      )
    ).toBe(true);
  });
});

describe('report_outcome in the execution loop', () => {
  const stops = (config: any, step: unknown): boolean =>
    config.stopWhen.some((predicate: unknown) =>
      typeof predicate === 'function' && Boolean((predicate as Function)({ steps: [step] })));
  const outcomeStep = (input: unknown) => ({
    content: [{ type: 'tool-result', toolName: 'report_outcome', input }],
  });

  it('asks with only report_outcome and ends on an idle verdict', async () => {
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      if (streamConfigs.length === 1) return defaultStreamTextImplementation(streamConfigs.pop());
      return {
        stream: (async function* () {
          const input = { status: 'idle', headline: 'Both inboxes empty; nothing due', artifacts: [] };
          const output = await config.tools.report_outcome.execute(input);
          yield { type: 'tool-call', toolCallId: 'outcome-1', toolName: 'report_outcome', input };
          yield { type: 'tool-result', toolCallId: 'outcome-1', toolName: 'report_outcome', output };
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });
    const outcome: RunOutcome = {};
    const tools = {
      read_mail: { description: 'Read mail' },
      report_outcome: createReportOutcomeTool(outcome),
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'outcome-agent', config: { model: 'demo:test' } } as any,
      tools,
      { userMessage: 'Sweep both mailboxes', systemMessages: [{ role: 'system', content: 'You are an agent' }], maxSteps: 10, runOutcome: outcome },
    )) { /* consume */ }

    expect(streamConfigs).toHaveLength(2);
    expect(Object.keys(streamConfigs[1].tools)).toEqual(['report_outcome']);
    expect(streamConfigs[1].toolChoice).toBe('required');
    expect(outcome.complete).toEqual({ headline: 'Both inboxes empty; nothing due', artifacts: [], idle: true });
  });

  it('stops on a delivered complete or idle verdict but keeps an incomplete run stepping', async () => {
    const outcome: RunOutcome = {};
    const tools = {
      read_mail: { description: 'Read mail' },
      report_outcome: createReportOutcomeTool(outcome),
    } as any;
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      return {
        stream: (async function* () {
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });
    for await (const _ of executeAgentCore(
      { name: 'outcome-agent', config: { model: 'demo:test' } } as any,
      tools,
      { userMessage: 'Sweep', systemMessages: [{ role: 'system', content: 'You are an agent' }], maxSteps: 10, runOutcome: outcome },
    )) { /* consume */ }
    const work = streamConfigs[0];

    const incomplete = { status: 'incomplete', headline: 'PR #12 blocked on failing CI', artifacts: [] };
    await tools.report_outcome.execute(incomplete);
    expect(stops(work, outcomeStep(incomplete))).toBe(false);

    const idle = { status: 'idle', headline: 'Nothing due', artifacts: [] };
    await tools.report_outcome.execute(idle);
    expect(stops(work, outcomeStep(idle))).toBe(true);
  });
});

describe('direct tool approval contracts', () => {
  it('preserves a root transform that changes an object into a Date', async () => {
    const previousCodeMode = process.env.AGENTUSE_CODE_MODE;
    process.env.AGENTUSE_CODE_MODE = '0';
    try {
    let executedInput: unknown;
    const rawInput = { iso: '2026-09-12T00:00:00.000Z' };
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      return {
        stream: (async function* () {
          await config.toolApproval({
            toolCall: { toolName: 'root_date', toolCallId: 'date-1', input: rawInput },
          });
          const output = await config.tools.root_date.execute(rawInput, {
            toolCallId: 'date-1', messages: [],
          });
          yield { type: 'tool-call', toolCallId: 'date-1', toolName: 'root_date', input: rawInput };
          yield { type: 'tool-result', toolCallId: 'date-1', toolName: 'root_date', output };
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });

    const tools = {
      root_date: {
        inputSchema: z.object({ iso: z.string() }).transform(({ iso }) => new Date(iso)),
        execute: async (input: unknown) => {
          executedInput = input;
          return { received: input instanceof Date };
        },
      },
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'transform-agent', config: { model: 'demo:test' } } as any,
      tools,
      { userMessage: 'Transform the value', systemMessages: [{ role: 'system', content: 'Test' }], maxSteps: 1 },
    )) { /* consume */ }

    expect(executedInput).toBeInstanceOf(Date);
    expect((executedInput as Date).toISOString()).toBe(rawInput.iso);
    expect(rawInput).toEqual({ iso: '2026-09-12T00:00:00.000Z' });
    } finally {
      if (previousCodeMode === undefined) delete process.env.AGENTUSE_CODE_MODE;
      else process.env.AGENTUSE_CODE_MODE = previousCodeMode;
    }
  });

  it('applies plugin tool-call policy to a non-executable provider tool', async () => {
    let approval: unknown;
    const pluginToolCalls: string[] = [];
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      return {
        stream: (async function* () {
          approval = await config.toolApproval({
            toolCall: { toolName: 'provider_search', toolCallId: 'provider-1', input: { query: 'private data' }, providerExecuted: true },
          });
          yield { type: 'tool-call', toolCallId: 'provider-1', toolName: 'provider_search', input: { query: 'private data' } };
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });

    for await (const _ of executeAgentCore(
      { name: 'policy-agent', config: { model: 'demo:test' } } as any,
      { provider_search: { description: 'Provider tool', inputSchema: z.object({ query: z.string() }) } } as any,
      {
        userMessage: 'Search',
        systemMessages: [{ role: 'system', content: 'Test' }],
        maxSteps: 1,
        pluginEvents: {
          toolCall: async (event) => {
            pluginToolCalls.push(event.toolName);
            return { block: true, reason: 'Provider tool is blocked by policy' };
          },
        },
      },
    )) { /* consume */ }

    expect(pluginToolCalls).toEqual(['provider_search']);
    expect(approval).toEqual({ type: 'denied', reason: 'Provider tool is blocked by policy' });
  });

  it('normalizes context before calling the manual needsApproval fallback', async () => {
    let receivedContext: unknown;
    streamTextMock.mockImplementation((config: any) => {
      streamConfigs.push(config);
      return {
        stream: (async function* () {
          const approval = await config.toolApproval({
            toolCall: { toolName: 'contextual_approval', toolCallId: 'context-1', input: { value: 'ok' } },
            toolsContext: { contextual_approval: { role: 'reviewer' } },
          });
          expect(approval).toBeUndefined();
          yield { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        })(),
        response: Promise.resolve({ messages: [] }),
        responseMessages: Promise.resolve([]),
      };
    });

    for await (const _ of executeAgentCore(
      { name: 'context-agent', config: { model: 'demo:test' } } as any,
      {
        contextual_approval: {
          inputSchema: z.object({ value: z.string() }),
          contextSchema: z.object({ role: z.string() }).transform(({ role }) => ({ role: role.toUpperCase() })),
          needsApproval: (_input: unknown, options: any) => {
            receivedContext = options.context;
            return false;
          },
          execute: async () => ({ ok: true }),
        },
      } as any,
      { userMessage: 'Approve context', systemMessages: [{ role: 'system', content: 'Test' }], maxSteps: 1 },
    )) { /* consume */ }

    expect(receivedContext).toEqual({ role: 'REVIEWER' });
  });

  it('releases approval when deferred context validation is cancelled', async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => {});
    streamTextMock.mockImplementation((config: any) => ({
      stream: (async function* () {
        await config.toolApproval({
          toolCall: { toolName: 'contextual_approval', toolCallId: 'context-abort', input: {} },
          toolsContext: { contextual_approval: {} },
        });
      })(),
      response: Promise.resolve({ messages: [] }),
      responseMessages: Promise.resolve([]),
    }));

    const run = (async () => {
      const chunks: any[] = [];
      for await (const chunk of executeAgentCore(
        { name: 'context-agent', config: { model: 'demo:test' } } as any,
        {
          contextual_approval: {
            inputSchema: z.object({}),
            contextSchema: z.object({}).transform(async () => await never),
            needsApproval: () => false,
            execute: async () => ({ ok: true }),
          },
        } as any,
        {
          userMessage: 'Approve context',
          systemMessages: [{ role: 'system', content: 'Test' }],
          maxSteps: 1,
          abortSignal: controller.signal,
        },
      )) chunks.push(chunk);
      return chunks;
    })();

    setTimeout(() => controller.abort(new Error('approval deadline')), 5);
    const chunks = await Promise.race([
      run,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('approval did not cancel')), 500)),
    ]);

    expect(chunks.some(chunk => chunk.type === 'error' && chunk.error?.message === 'approval deadline')).toBe(true);
  });

  it('releases approval when a deferred needsApproval policy is cancelled', async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => {});
    streamTextMock.mockImplementation((config: any) => ({
      stream: (async function* () {
        await config.toolApproval({
          toolCall: { toolName: 'deferred_approval', toolCallId: 'policy-abort', input: {} },
        });
      })(),
      response: Promise.resolve({ messages: [] }),
      responseMessages: Promise.resolve([]),
    }));

    const run = (async () => {
      const chunks: any[] = [];
      for await (const chunk of executeAgentCore(
        { name: 'policy-agent', config: { model: 'demo:test' } } as any,
        {
          deferred_approval: {
            inputSchema: z.object({}),
            needsApproval: async () => await never,
            execute: async () => ({ ok: true }),
          },
        } as any,
        {
          userMessage: 'Approve policy',
          systemMessages: [{ role: 'system', content: 'Test' }],
          maxSteps: 1,
          abortSignal: controller.signal,
        },
      )) chunks.push(chunk);
      return chunks;
    })();

    setTimeout(() => controller.abort(new Error('policy deadline')), 5);
    const chunks = await Promise.race([
      run,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('approval policy did not cancel')), 500)),
    ]);

    expect(chunks.some(chunk => chunk.type === 'error' && chunk.error?.message === 'policy deadline')).toBe(true);
  });
});
