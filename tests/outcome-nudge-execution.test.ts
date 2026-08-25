import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';
import {
  createReportCompleteTool,
  createReportIncompleteTool,
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

const streamTextMock = mock((config: any) => {
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

describe('missing-outcome recovery segment', () => {
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
