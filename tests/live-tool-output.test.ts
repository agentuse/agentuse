import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { processAgentStream, type AgentChunk } from '../src/runner';
import { createLiveToolOutputRelay } from '../src/runner/live-tool-output';
import { createBashTool } from '../src/tools/bash.js';
import {
  LIVE_OUTPUT_INTERVAL_MS,
  LIVE_OUTPUT_MAX_CHARS,
  LIVE_OUTPUT_METADATA_KEY,
  LIVE_OUTPUT_MIN_RUNTIME_MS,
} from '../src/tools/types';

type PartUpdate = { partID: string; updates: any };

/** Minimal session manager that records every part write in order. */
function recordingSessionManager(updates: PartUpdate[]) {
  return {
    addPart: async () => 'part-1',
    updatePart: async (_s: string, _a: string, _m: string, partID: string, u: any) => {
      updates.push({ partID, updates: structuredClone(u) });
    },
    updateMessage: async () => {},
  } as any;
}

const toolCall = (callID: string): AgentChunk => ({
  type: 'tool-call',
  toolName: 'tools__bash',
  toolCallId: callID,
  toolInput: { command: 'pnpm run deploy' },
  toolStartTime: Date.now(),
} as AgentChunk);

const toolResult = (callID: string, output: string): AgentChunk => ({
  type: 'tool-result',
  toolName: 'tools__bash',
  toolCallId: callID,
  toolResult: output,
  toolResultRaw: output,
  toolSuccess: true,
  toolDuration: 12,
} as AgentChunk);

const runStream = (chunks: () => AsyncGenerator<AgentChunk>, relay: ReturnType<typeof createLiveToolOutputRelay>, updates: PartUpdate[]) =>
  processAgentStream(chunks(), {
    sessionManager: recordingSessionManager(updates),
    sessionID: 'session-1',
    agentId: 'agent-1',
    messageID: 'message-1',
    liveToolOutput: relay,
    quiet: true,
  });

/** Tool states written for the part, in write order. */
const states = (updates: PartUpdate[]) => updates.map((u) => u.updates.state).filter(Boolean);

describe('live tool output', () => {
  it('writes a running call\'s tail onto its tool part', async () => {
    const updates: PartUpdate[] = [];
    const relay = createLiveToolOutputRelay();

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield toolCall('call-1');
      relay.publish('call-1', 'installing…\n');
      relay.publish('call-1', 'installing…\nbuilding…\n');
      await new Promise((resolve) => setTimeout(resolve, LIVE_OUTPUT_INTERVAL_MS + 80));
      yield toolResult('call-1', 'done');
      yield { type: 'finish', finishReason: 'stop' } as AgentChunk;
    }

    await runStream(chunks, relay, updates);

    const running = states(updates).filter((s) => s.status === 'running');
    expect(running).toHaveLength(1);
    // Throttled: both publishes collapse into one write carrying the latest tail.
    expect(running[0].metadata[LIVE_OUTPUT_METADATA_KEY]).toBe('installing…\nbuilding…\n');
  });

  it('drops the tail from the part once the call completes', async () => {
    const updates: PartUpdate[] = [];
    const relay = createLiveToolOutputRelay();

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield toolCall('call-1');
      relay.publish('call-1', 'partial output\n');
      await new Promise((resolve) => setTimeout(resolve, LIVE_OUTPUT_INTERVAL_MS + 80));
      yield toolResult('call-1', 'done');
      yield { type: 'finish', finishReason: 'stop' } as AgentChunk;
    }

    await runStream(chunks, relay, updates);

    const final = states(updates).at(-1);
    expect(final.status).toBe('completed');
    // persistToolState merges metadata forward, so the stale tail has to be
    // stripped explicitly or it ships with the finished call forever.
    expect(final.metadata?.[LIVE_OUTPUT_METADATA_KEY]).toBeUndefined();
  });

  it('ignores a tail published after the call settled', async () => {
    const updates: PartUpdate[] = [];
    const relay = createLiveToolOutputRelay();

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield toolCall('call-1');
      yield toolResult('call-1', 'done');
      // A straggler chunk from a process killed after its result was recorded.
      relay.publish('call-1', 'late output\n');
      await new Promise((resolve) => setTimeout(resolve, LIVE_OUTPUT_INTERVAL_MS + 80));
      yield { type: 'finish', finishReason: 'stop' } as AgentChunk;
    }

    await runStream(chunks, relay, updates);

    const written = states(updates);
    expect(written.some((s) => s.status === 'running' && s.metadata?.[LIVE_OUTPUT_METADATA_KEY])).toBe(false);
    expect(written.at(-1).status).toBe('completed');
  });

  it('stops publishing once the stream unbinds', async () => {
    const updates: PartUpdate[] = [];
    const relay = createLiveToolOutputRelay();

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield toolCall('call-1');
      yield toolResult('call-1', 'done');
      yield { type: 'finish', finishReason: 'stop' } as AgentChunk;
    }

    await runStream(chunks, relay, updates);
    const writesAtEnd = updates.length;

    // The tool outlives a suspended/aborted stream; its tails must go nowhere.
    relay.publish('call-1', 'output after the stream ended\n');
    await new Promise((resolve) => setTimeout(resolve, LIVE_OUTPUT_INTERVAL_MS + 80));
    expect(updates).toHaveLength(writesAtEnd);
  });

  it('drops publishes made before a consumer binds', () => {
    const relay = createLiveToolOutputRelay();
    expect(() => relay.publish('call-1', 'output with no consumer')).not.toThrow();

    const seen: Array<[string, string]> = [];
    relay.bind((callID, tail) => seen.push([callID, tail]));
    relay.publish('call-1', 'output with a consumer');
    expect(seen).toEqual([['call-1', 'output with a consumer']]);
  });
});

/**
 * The AI SDK types `execute` with the full runtime option bag (messages,
 * context); the bash tool only reads abortSignal/toolCallId, so tests call it
 * through this narrower shape.
 */
type BashExecute = (
  args: { command: string; workdir?: string; timeout?: number },
  options?: { abortSignal?: AbortSignal; toolCallId?: string }
) => Promise<{ output: string; metadata?: Record<string, unknown> }>;

/** Records what the bash tool publishes, with arrival times. */
function recordingLiveSink() {
  const published: Array<{ callID: string; tail: string; at: number }> = [];
  return {
    published,
    sink: {
      publish: (callID: string, tail: string) => {
        published.push({ callID, tail, at: Date.now() });
      },
    },
  };
}

describe('bash live output', () => {
  it('publishes a bounded tail while a slow command runs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-bash-live-'));
    try {
      const script = join(projectRoot, 'slow.sh');
      // More than one tail's worth of noise, then a pause long enough to cross
      // the min-runtime gate, then a final line.
      await writeFile(script, [
        `printf '%.0sx' $(seq 1 ${LIVE_OUTPUT_MAX_CHARS + 1000})`,
        `printf 'START\\n'`,
        'sleep 2.4',
        `printf 'END\\n'`,
        '',
      ].join('\n'));

      const live = recordingLiveSink();
      const bashTool = createBashTool(
        { commands: ['bash *'] },
        projectRoot,
        { projectRoot, liveToolOutput: live.sink }
      );

      const startedAt = Date.now();
      const result = await (bashTool.execute as unknown as BashExecute)({ command: `bash ${script}` }, { toolCallId: 'call-1' });

      expect(result.output).toContain('END');
      expect(live.published.length).toBeGreaterThan(0);
      expect(live.published.every((p) => p.callID === 'call-1')).toBe(true);
      // Bounded: the part file is rewritten whole on every update.
      expect(Math.max(...live.published.map((p) => p.tail.length))).toBeLessThanOrEqual(LIVE_OUTPUT_MAX_CHARS);
      // Gated: nothing is published until the call is worth watching.
      expect(live.published[0]!.at - startedAt).toBeGreaterThanOrEqual(LIVE_OUTPUT_MIN_RUNTIME_MS - 250);
      // The tail follows the newest bytes, and keeps what came before them.
      expect(live.published.at(-1)!.tail).toContain('START');
      expect(live.published.at(-1)!.tail.trimEnd().endsWith('END')).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('publishes nothing for a command that finishes before the gate', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-bash-fast-'));
    try {
      const live = recordingLiveSink();
      const bashTool = createBashTool(
        { commands: ['printf *'] },
        projectRoot,
        { projectRoot, liveToolOutput: live.sink }
      );

      const result = await (bashTool.execute as unknown as BashExecute)({ command: 'printf quick' }, { toolCallId: 'call-1' });

      expect(result.output).toContain('quick');
      expect(live.published).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('publishes nothing when the call has no id to attribute output to', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-bash-nocall-'));
    try {
      const script = join(projectRoot, 'slow.sh');
      await writeFile(script, `printf 'working\\n'\nsleep 2.4\n`);

      const live = recordingLiveSink();
      const bashTool = createBashTool(
        { commands: ['bash *'] },
        projectRoot,
        { projectRoot, liveToolOutput: live.sink }
      );

      await (bashTool.execute as unknown as BashExecute)({ command: `bash ${script}` });

      expect(live.published).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
