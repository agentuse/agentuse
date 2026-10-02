import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DoomLoopDetector } from '../src/tools';
import type { ParsedAgent } from '../src/parser';
import type { PreparedAgentExecution } from '../src/runner/types';
import type { PluginManager } from '../src/plugin';

mock.restore();

const channelEvents: Array<Record<string, unknown>> = [];
const finishAnnouncements: Array<Record<string, unknown>> = [];
let deliverFailure: () => Promise<void> = async () => {};

mock.module('../src/channels/run', () => ({
  startRunChannels: async () => [{ channel: 'C_RUN', ts: '1.0', events: ['completion', 'failure'] }],
  suspendRunChannels: async () => {},
  sendRunChannelMessages: async (event: Record<string, unknown>) => {
    channelEvents.push(event);
    await deliverFailure();
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
  deliverFailure = async () => {};
});

const agent: ParsedAgent = {
  name: 'stopped-run',
  instructions: 'Do the task.',
  config: { model: 'demo:default' } as ParsedAgent['config'],
};

function preparation(): PreparedAgentExecution {
  return {
    tools: {},
    systemMessages: [],
    userMessage: 'Run the task.',
    maxSteps: 1,
    subAgentNames: new Set(),
    doomLoopDetector: new DoomLoopDetector({ threshold: 3, action: 'error' }),
    cleanup: async () => {},
    releaseStoreLock: async () => {},
    learningsApplied: 0,
    learningsStored: 0,
    learningsCap: 0,
    learningsInjectedIds: [],
  };
}

/** A plugin that aborts the run once it has started, as a user stop would. */
function stopOnStart(controller: AbortController): PluginManager {
  return {
    emit: async (event: string) => {
      if (event === 'agent:start') {
        controller.abort();
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
    },
  } as unknown as PluginManager;
}

function run(controller: AbortController) {
  return runAgent(
    agent, [], false, controller.signal, Date.now(), false, undefined, undefined,
    undefined, undefined, undefined, preparation(), true, stopOnStart(controller), false,
  );
}

describe('stopped run channels', () => {
  it('marks the run card failed when the run is stopped', async () => {
    const controller = new AbortController();
    await expect(run(controller)).rejects.toThrow();

    expect(channelEvents).toHaveLength(1);
    expect(channelEvents[0]).toMatchObject({ event: 'failure' });
    expect(finishAnnouncements).toEqual([{ status: 'failed', agentName: 'stopped-run' }]);
  });

  it('does not let a hung channel delivery hold up the stop', async () => {
    deliverFailure = () => new Promise(() => {});
    const controller = new AbortController();
    const started = Date.now();
    await expect(run(controller)).rejects.toThrow();
    expect(channelEvents).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(4_500);
  }, 10_000);
});
