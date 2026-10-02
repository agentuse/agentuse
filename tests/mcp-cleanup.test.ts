import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { DoomLoopDetector } from '../src/tools';
import type { MCPConnection } from '../src/mcp';
import type { ParsedAgent } from '../src/parser';
import type { PreparedAgentExecution } from '../src/runner/types';
import type { PluginManager } from '../src/plugin';

mock.restore();

// Keep the run off real channels and session announcements.
mock.module('../src/channels/run', () => ({
  startRunChannels: async () => [],
  suspendRunChannels: async () => {},
  sendRunChannelMessages: async () => {},
}));
mock.module('../src/runner/announce', () => ({
  announceSessionStarted: async () => {},
  announceSessionFinished: async () => {},
}));

let runAgent: typeof import('../src/runner/run').runAgent;
let closeMCPConnections: typeof import('../src/mcp-cleanup').closeMCPConnections;

beforeAll(async () => {
  ({ runAgent } = await import('../src/runner/run'));
  ({ closeMCPConnections } = await import('../src/mcp-cleanup'));
});

/** MCP connections whose close() stays pending until the test releases it. */
function slowConnections(names: string[]) {
  const started: string[] = [];
  const release = new Map<string, (error?: Error) => void>();
  let firstStarted!: () => void;
  const anyStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  const connections = names.map((name) => ({
    name,
    client: {
      close: () => new Promise<void>((resolve, reject) => {
        started.push(name);
        release.set(name, (error) => (error ? reject(error) : resolve()));
        firstStarted();
      }),
    },
  })) as unknown as MCPConnection[];
  return { connections, started, release, anyStarted };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('closeMCPConnections', () => {
  it('starts every close before any finishes and ignores close failures', async () => {
    const { connections, started, release } = slowConnections(['a', 'b', 'c']);
    let done = false;
    const closing = closeMCPConnections(connections).then(() => { done = true; });
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    release.get('a')!(new Error('close failed'));
    release.get('c')!();
    await flush();
    expect(done).toBe(false);

    release.get('b')!();
    await closing;
    expect(done).toBe(true);
  });
});

describe('run cleanup', () => {
  it('closes the run\'s MCP clients concurrently', async () => {
    const { connections, started, release, anyStarted } = slowConnections(['slow-1', 'slow-2']);
    const controller = new AbortController();
    const stopOnStart = {
      emit: async (event: string) => {
        if (event === 'agent:start') {
          controller.abort();
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
      },
    } as unknown as PluginManager;
    const agent: ParsedAgent = {
      name: 'mcp-cleanup',
      instructions: 'Do the task.',
      config: { model: 'demo:default' } as ParsedAgent['config'],
    };
    const preparation: PreparedAgentExecution = {
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

    const run = runAgent(
      agent, connections, false, controller.signal, Date.now(), false, undefined, undefined,
      undefined, undefined, undefined, preparation, true, stopOnStart, false,
    ).then(() => undefined, (error: unknown) => error);

    await anyStarted;
    await flush();
    expect(started).toEqual(['slow-1', 'slow-2']);

    release.get('slow-1')!();
    release.get('slow-2')!();
    expect(await run).toBeInstanceOf(Error);
  });
});
