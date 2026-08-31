import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';
import {
  createReportCompleteTool,
  createReportIncompleteTool,
  type RunOutcome,
} from '../src/tools/report-outcome';
import {
  SUBMIT_AGENT_SOURCE_NUDGE_PROMPT,
  SUBMIT_AGENT_SOURCE_TOOL,
  type AgentSourceSubmission,
} from '../src/onboarding/submit-agent-source';

mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

const streamConfigs: any[] = [];

function toolStream(
  config: any,
  toolName: string,
  input: Record<string, unknown>,
  responseMessages: any[] = [],
  finishReason = 'stop',
) {
  return {
    stream: (async function* () {
      const output = await config.tools[toolName].execute(input);
      yield { type: 'tool-call', toolCallId: `${toolName}-1`, toolName, input };
      yield { type: 'tool-result', toolCallId: `${toolName}-1`, toolName, output };
      yield {
        type: 'finish',
        finishReason,
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      };
    })(),
    response: Promise.resolve({ messages: [] }),
    responseMessages: Promise.resolve(responseMessages),
  };
}

const streamTextMock = mock((config: any) => {
  streamConfigs.push(config);
  if (streamConfigs.length === 1) {
    const reason = "Required tool 'submit_agent_source' is missing from the environment.";
    return toolStream(config, 'report_incomplete', { reason }, [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'report_incomplete', input: { reason } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: 'report_incomplete', output: 'Recorded' }] },
    ], 'other');
  }
  if (streamConfigs.length === 2) {
    return toolStream(config, SUBMIT_AGENT_SOURCE_TOOL, { source: '---\nname: recovered\n---\nDo useful work.' }, [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: SUBMIT_AGENT_SOURCE_TOOL, input: { source: '---\nname: recovered\n---\nDo useful work.' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: SUBMIT_AGENT_SOURCE_TOOL, output: 'Accepted' }] },
    ]);
  }
  return toolStream(config, 'report_complete', { headline: 'Created recovered agent' });
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

describe('onboarding creator source recovery', () => {
  it('recovers a provider-specific clean finish and forces schema-backed delivery', async () => {
    const outcome: RunOutcome = {};
    const submission: AgentSourceSubmission = {};
    const tools = {
      report_complete: createReportCompleteTool(outcome),
      report_incomplete: createReportIncompleteTool(outcome),
      [SUBMIT_AGENT_SOURCE_TOOL]: {
        description: 'Submit source',
        execute: async ({ source }: { source: string }) => {
          submission.source = source;
          return 'Accepted';
        },
      },
      filesystem_list: { description: 'List files' },
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'onboarding-agent-creator', config: { model: 'demo:test' } } as any,
      tools,
      {
        userMessage: 'Create an agent',
        systemMessages: [{ role: 'system', content: 'Use the creator contract' }],
        maxSteps: 10,
        runOutcome: outcome,
        agentSourceSubmission: submission,
      },
    )) {
      // consume
    }

    expect(streamTextMock).toHaveBeenCalledTimes(3);
    expect(streamConfigs[0].toolChoice).toBe('auto');
    expect(streamConfigs[0].stopWhen[0]).toEqual({ isStepCount: 6 });
    expect(streamConfigs[1].toolChoice).toBe('required');
    expect(streamConfigs[1].stopWhen[0]).toEqual({ isStepCount: 8 });
    expect(Object.keys(streamConfigs[1].tools)).toEqual([SUBMIT_AGENT_SOURCE_TOOL]);
    expect(streamConfigs[1].messages.at(-1)).toEqual({
      role: 'user',
      content: SUBMIT_AGENT_SOURCE_NUDGE_PROMPT,
    });
    expect(submission.source).toContain('name: recovered');
    expect(outcome.incomplete).toBeUndefined();

    expect(streamConfigs[2].toolChoice).toBe('required');
    expect(Object.keys(streamConfigs[2].tools).sort()).toEqual([
      'report_complete',
      'report_incomplete',
    ]);
    expect(outcome.complete?.headline).toBe('Created recovered agent');
  });
});
