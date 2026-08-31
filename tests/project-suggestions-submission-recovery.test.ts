import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';
import {
  createReportCompleteTool,
  createReportIncompleteTool,
  type RunOutcome,
} from '../src/tools/report-outcome';
import {
  SUBMIT_PROJECT_SUGGESTIONS_NUDGE_PROMPT,
  SUBMIT_PROJECT_SUGGESTIONS_TOOL,
  type ProjectSuggestionsSubmission,
} from '../src/onboarding/submit-project-suggestions';

mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

const streamConfigs: any[] = [];
const discovery = {
  projectName: 'demo',
  summary: 'A demo project.',
  inspectedFiles: 10,
  suggestions: [
    { id: 'suggestion-1', name: 'One', description: 'One', objective: 'One', schedule: '0 9 * * 1', scheduleHuman: 'Monday', evidence: ['README.md'] },
    { id: 'suggestion-2', name: 'Two', description: 'Two', objective: 'Two', schedule: '0 9 * * 2', scheduleHuman: 'Tuesday', evidence: ['package.json'] },
    { id: 'suggestion-3', name: 'Three', description: 'Three', objective: 'Three', schedule: '0 9 * * 3', scheduleHuman: 'Wednesday', evidence: ['tests'] },
  ],
};

function stoppedStream(responseMessages: any[] = [], finishReason = 'stop') {
  return {
    stream: (async function* () {
      yield { type: 'finish', finishReason, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } };
    })(),
    response: Promise.resolve({ messages: [] }),
    responseMessages: Promise.resolve(responseMessages),
  };
}

function toolStream(config: any, toolName: string, input: Record<string, unknown>, responseMessages: any[] = []) {
  return {
    stream: (async function* () {
      const output = await config.tools[toolName].execute(input);
      yield { type: 'tool-call', toolCallId: `${toolName}-1`, toolName, input };
      yield { type: 'tool-result', toolCallId: `${toolName}-1`, toolName, output };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 10, totalTokens: 130 } };
    })(),
    response: Promise.resolve({ messages: [] }),
    responseMessages: Promise.resolve(responseMessages),
  };
}

const streamTextMock = mock((config: any) => {
  streamConfigs.push(config);
  if (streamConfigs.length === 1) {
    return stoppedStream([
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'filesystem_read', input: { path: 'README.md' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: 'filesystem_read', output: 'Project docs' }] },
    ], 'other');
  }
  if (streamConfigs.length === 2) {
    return toolStream(config, SUBMIT_PROJECT_SUGGESTIONS_TOOL, { summary: discovery.summary, suggestions: discovery.suggestions });
  }
  return toolStream(config, 'report_complete', { headline: 'Proposed three agents' });
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

describe('project suggestions recovery', () => {
  it('forces structured submission after a provider-specific clean finish', async () => {
    const outcome: RunOutcome = {};
    const submission: ProjectSuggestionsSubmission = {};
    const tools = {
      report_complete: createReportCompleteTool(outcome),
      report_incomplete: createReportIncompleteTool(outcome),
      [SUBMIT_PROJECT_SUGGESTIONS_TOOL]: {
        description: 'Submit suggestions',
        execute: async () => {
          submission.result = discovery;
          return 'Accepted';
        },
      },
      filesystem_read: { description: 'Read a file' },
    } as any;

    for await (const _ of executeAgentCore(
      { name: 'onboarding-project-discovery', config: { model: 'demo:test' } } as any,
      tools,
      {
        userMessage: 'Find recurring work',
        systemMessages: [{ role: 'system', content: 'Inspect the project' }],
        maxSteps: 10,
        runOutcome: outcome,
        projectSuggestionsSubmission: submission,
      },
    )) {
      // consume
    }

    expect(streamTextMock).toHaveBeenCalledTimes(3);
    expect(streamConfigs[0].stopWhen[0]).toEqual({ isStepCount: 6 });
    expect(streamConfigs[1].toolChoice).toBe('required');
    expect(streamConfigs[1].stopWhen[0]).toEqual({ isStepCount: 9 });
    expect(Object.keys(streamConfigs[1].tools)).toEqual([SUBMIT_PROJECT_SUGGESTIONS_TOOL]);
    expect(streamConfigs[1].messages.at(-1)).toEqual({
      role: 'user',
      content: SUBMIT_PROJECT_SUGGESTIONS_NUDGE_PROMPT,
    });
    expect(submission.result?.suggestions).toHaveLength(3);
    expect(streamConfigs[2].toolChoice).toBe('required');
    expect(Object.keys(streamConfigs[2].tools).sort()).toEqual(['report_complete', 'report_incomplete']);
    expect(outcome.complete?.headline).toBe('Proposed three agents');
  });
});
