import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DoomLoopDetector } from '../src/tools';
import type { ParsedAgent } from '../src/parser';
import type { PreparedAgentExecution } from '../src/runner/types';

mock.restore();

const channelEvents: Array<Record<string, unknown>> = [];
const finishAnnouncements: Array<Record<string, unknown>> = [];

mock.module('../src/channels/run', () => ({
  startRunChannels: async () => [],
  suspendRunChannels: async () => {},
  sendRunChannelMessages: async (event: Record<string, unknown>) => {
    channelEvents.push(event);
  },
}));

mock.module('../src/runner/announce', () => ({
  announceSessionStarted: async () => {},
  announceSessionFinished: async (event: Record<string, unknown>) => {
    finishAnnouncements.push(event);
  },
}));

let runAgent: typeof import('../src/runner/run').runAgent;

beforeAll(async () => {
  ({ runAgent } = await import('../src/runner/run'));
});

beforeEach(() => {
  channelEvents.length = 0;
  finishAnnouncements.length = 0;
});

describe('incomplete runner lifecycle', () => {
  it('returns a failed result and uses failure notifications, never completion', async () => {
    const reason = 'Required account is signed out';
    const agent: ParsedAgent = {
      name: 'incomplete-lifecycle',
      instructions: 'Report the result.',
      config: { model: 'demo:default' },
    };
    const preparation: PreparedAgentExecution = {
      tools: {},
      systemMessages: [],
      userMessage: 'Run the task.',
      maxSteps: 1,
      subAgentNames: new Set(),
      runOutcome: { incomplete: { reason } },
      doomLoopDetector: new DoomLoopDetector({ threshold: 3, action: 'error' }),
      cleanup: async () => {},
      releaseStoreLock: async () => {},
      learningsApplied: 0,
    };

    const result = await runAgent(
      agent,
      [],
      false,
      undefined,
      Date.now(),
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      preparation,
      true,
      null,
      false,
    );

    expect(result.status).toBe('failed');
    expect(result.incomplete).toEqual({ reason });
    expect(channelEvents).toHaveLength(1);
    expect(channelEvents[0]).toMatchObject({ event: 'failure', error: reason });
    expect(channelEvents.some((event) => event.event === 'completion')).toBe(false);
    expect(finishAnnouncements).toEqual([{
      status: 'failed',
      agentName: 'incomplete-lifecycle',
    }]);
  });
});
