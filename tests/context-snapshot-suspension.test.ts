/**
 * The context snapshot written for a suspension is the resume boundary:
 * rehydrate keeps only parts newer than snapshot.updatedAt, and the pending
 * gate part is stamped just after it. A later write from the run's snapshot
 * writer (the generator-finally flush after compaction, or a debounced timer)
 * restamps the snapshot with write time, hides the pending gate behind the
 * boundary, and makes the approved resume fail validation.
 *
 * This drives the real stream consumer, lets the generator run through its
 * finally, then approves and resumes through the production transaction.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiSdkErrorMocks } from './helpers/ai-sdk-mock';

const envKeys = ['XDG_DATA_HOME', 'AGENTUSE_DATA_DIR', 'APPROVAL_COMPACTION_MIN_TOKENS'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let root = '';

mock.module('../src/utils/models-api', () => ({
  getModelInfo: mock(async () => ({ modelId: 'mock-model', contextLimit: 10_000, outputLimit: 4096 })),
}));
mock.module('../src/models', () => ({
  createModel: mock(async () => ({ modelId: 'mock-model' })),
  AuthenticationError: class AuthenticationError extends Error {},
}));

const streamTextMock = mock((config: any): any => {
  const system = config?.messages?.[0]?.content ?? config?.instructions;
  if (typeof system === 'string' && system.includes('summarizer')) {
    return {
      stream: (async function* () {
        yield { type: 'text-delta', text: 'folded summary' };
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    };
  }
  return {
    stream: (async function* () {
      yield { type: 'tool-call', toolCallId: 'gate', toolName: 'await_human', input: { prompt: 'Approve?' } };
      const { SuspendSignal } = await import('../src/runner/suspend');
      yield {
        type: 'tool-error',
        toolCallId: 'gate',
        toolName: 'await_human',
        error: new SuspendSignal({ kind: 'await_human', prompt: 'Approve?', resumeToken: 'resume-token' }),
      };
    })(),
  };
});
mock.module('ai', () => ({
  streamText: streamTextMock,
  isStepCount: mock((steps: number) => ({ isStepCount: steps })),
  ...aiSdkErrorMocks(),
}));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-snapshot-suspension-'));
  process.env.XDG_DATA_HOME = root;
  process.env.AGENTUSE_DATA_DIR = join(root, 'agentuse-data');
  // Force approval-boundary compaction so the run has a compacted context and
  // the generator's own snapshot writer is live at suspension.
  process.env.APPROVAL_COMPACTION_MIN_TOKENS = '1';
});

afterAll(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(root, { recursive: true, force: true });
  mock.restore();
});

describe('suspension context snapshot', () => {
  test('survives the run unwinding and lets the approved gate resume', async () => {
    const { initStorage } = await import('../src/storage');
    const { SessionManager } = await import('../src/session');
    const { executeAgentCore } = await import('../src/runner/execution');
    const { processAgentStream } = await import('../src/runner/stream');
    const { applyResumeToolResult } = await import('../src/runner/resume');

    await initStorage(root);
    const manager = new SessionManager();
    const agentId = 'agents/snapshot-suspension';
    const sessionId = await manager.createSession({
      agent: { id: agentId, name: 'snapshot-suspension', isSubAgent: false },
      model: 'anthropic:mock-model',
      version: 'test',
      config: {},
      project: { root, cwd: root },
    });
    const messageId = await manager.createMessage(sessionId, agentId, {
      user: { prompt: { task: 'Suspend on a gate after compaction' } },
      assistant: {
        system: ['old system context'],
        modelID: 'mock-model',
        providerID: 'anthropic',
        mode: 'build',
        path: { cwd: root, root },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });

    const writes: Array<{ updatedAt: number }> = [];
    const writeContextSnapshot = manager.writeContextSnapshot.bind(manager);
    manager.writeContextSnapshot = async (sid: string, aid: string, snapshot: any) => {
      writes.push({ updatedAt: snapshot.updatedAt });
      await writeContextSnapshot(sid, aid, snapshot);
    };

    const initialMessages = [
      { role: 'system', content: 'old system context' },
      { role: 'user', content: 'old user task' },
      { role: 'assistant', content: 'old middle 1' },
      { role: 'user', content: 'old middle 2' },
      { role: 'assistant', content: 'recent assistant context 1' },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'settled-before-gate',
          toolName: 'read_file',
          output: { type: 'text', value: 'recent tool context' },
        }],
      },
      { role: 'user', content: 'recent user context 2' },
    ];

    // processAgentStream drains the generator, so its finally (and any
    // snapshot flush there) has run by the time this resolves.
    const result = await processAgentStream(
      executeAgentCore(
        { name: 'snapshot-suspension', config: { model: 'anthropic:mock-model' } } as any,
        {},
        {
          userMessage: 'unused',
          systemMessages: [],
          messages: initialMessages as any,
          maxSteps: 3,
          sessionManager: manager,
          sessionID: sessionId,
          agentId,
          messageID: messageId,
        },
      ),
      { sessionManager: manager, sessionID: sessionId, agentId, messageID: messageId, quiet: true },
    );
    expect(result.suspended).toBe(true);
    await manager.setSessionSuspended(sessionId, agentId);

    const pending = await manager.findPendingTool(sessionId, agentId);
    expect(pending?.part.callID).toBe('gate');
    const pendingAt = pending?.part.state.status === 'pending' ? pending.part.state.suspendedAt : undefined;
    const snapshot = await manager.readContextSnapshot(sessionId, agentId);
    expect(snapshot).toBeTruthy();
    expect(typeof pendingAt).toBe('number');
    // Only the consumer's suspension write landed; nothing restamped it later.
    expect(writes).toHaveLength(1);
    expect(snapshot!.updatedAt).toBeLessThan(pendingAt as number);

    const applied = await applyResumeToolResult({
      sessionManager: manager,
      sessionId,
      toolResult: { status: 'approve' },
      resumeToken: 'resume-token',
      buildResumedMessages: true,
    });
    const gateCalls = (applied.resumedMessages ?? []).flatMap((message: any) =>
      Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.toolCallId === 'gate')
        : []
    );
    expect(gateCalls.map((part: any) => part.type).sort()).toEqual(['tool-call', 'tool-result']);
  });
});
