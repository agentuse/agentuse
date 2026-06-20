import { describe, expect, it } from 'bun:test';
import { processAgentStream, type AgentChunk } from '../src/runner';

describe('processAgentStream session logging', () => {
  it('finalizes very short text replies even when part creation resolves after finish', async () => {
    const updates: any[] = [];
    const sessionManager = {
      addPart: async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return 'part-1';
      },
      updatePart: async (...args: any[]) => {
        updates.push(args);
      },
      updateMessage: async () => {}
    };

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield { type: 'text', text: 'Yes' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2
        } as any
      };
    }

    const result = await processAgentStream(chunks(), {
      sessionManager: sessionManager as any,
      sessionID: 'session-1',
      agentId: 'agent-1',
      messageID: 'message-1',
      quiet: true
    });

    expect(result.text).toBe('Yes');
    expect(updates).toHaveLength(1);
    expect(updates[0][3]).toBe('part-1');
    expect(updates[0][4]).toMatchObject({
      text: 'Yes',
      time: {
        start: expect.any(Number),
        end: expect.any(Number)
      }
    });
  });

  it('accumulates step usage and persists interim cumulative usage', async () => {
    const messageUpdates: any[] = [];
    const sessionManager = {
      addPart: async () => 'part-1',
      updatePart: async () => {},
      updateMessage: async (...args: any[]) => {
        messageUpdates.push(args);
      }
    };

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        usageKind: 'step',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          inputTokenDetails: { cacheReadTokens: 4 },
        } as any
      };
      yield {
        type: 'finish',
        finishReason: 'stop',
        usageKind: 'step',
        usage: {
          inputTokens: 20,
          outputTokens: 3,
          totalTokens: 23,
          inputTokenDetails: { cacheReadTokens: 6 },
        } as any
      };
    }

    const result = await processAgentStream(chunks(), {
      sessionManager: sessionManager as any,
      sessionID: 'session-1',
      agentId: 'agent-1',
      messageID: 'message-1',
      quiet: true
    });

    expect(result.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      inputTokenDetails: {
        cacheReadTokens: 10,
      },
    });
    expect(messageUpdates).toHaveLength(2);
    expect(messageUpdates[1][3]).toMatchObject({
      assistant: {
        tokens: {
          input: 30,
          output: 5,
          cache: { read: 10 },
        },
      },
    });
  });

  it('persists a context snapshot when the stream suspends for approval', async () => {
    const snapshots: any[] = [];
    const partUpdates: any[] = [];
    const sessionManager = {
      addPart: async () => 'part-1',
      updatePart: async (...args: any[]) => {
        partUpdates.push(args);
      },
      updateMessage: async () => {},
      writeContextSnapshot: async (...args: any[]) => {
        snapshots.push(args);
      }
    };

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield {
        type: 'tool-call',
        toolName: 'await_human',
        toolCallId: 'call-1',
        toolInput: { prompt: 'Approve?' },
        toolStartTime: 1_500,
      };
      yield {
        type: 'suspended',
        toolName: 'await_human',
        toolCallId: 'call-1',
        toolResultRaw: {
          kind: 'await_human',
          prompt: 'Approve?',
          resumeToken: 'token-1',
          approvalUrl: 'https://example.test/sessions/session-1',
        },
        contextSnapshot: {
          version: 1,
          updatedAt: 1_000,
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'task' },
          ],
          usage: {
            activeTokens: 42,
            contextLimit: 1000,
            usagePercentage: 4.2,
            compacted: false,
            compactions: 0,
            updatedAt: 1_000,
          },
        },
      };
    }

    const result = await processAgentStream(chunks(), {
      sessionManager: sessionManager as any,
      sessionID: 'session-1',
      agentId: 'agent-1',
      messageID: 'message-1',
      quiet: true
    });

    expect(result.suspended).toBe(true);
    expect(result.contextUsage).toMatchObject({
      activeTokens: 42,
      usagePercentage: 4.2,
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual([
      'session-1',
      'agent-1',
      {
        version: 1,
        updatedAt: 1_000,
        messageID: 'message-1',
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'task' },
        ],
        usage: {
          activeTokens: 42,
          contextLimit: 1000,
          usagePercentage: 4.2,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        },
      },
    ]);
    const pendingState = partUpdates[0][4].state;
    expect(pendingState).toMatchObject({
      status: 'pending',
      resumePayload: {
        kind: 'await_human',
        prompt: 'Approve?',
        resumeToken: 'token-1',
      },
    });
    expect(typeof pendingState.suspendedAt).toBe('number');
    expect(pendingState.suspendedAt).toBeGreaterThan(1_000);
  });

  it('persists step usage before a session suspends for approval', async () => {
    const messageUpdates: any[] = [];
    const partUpdates: any[] = [];
    const sessionManager = {
      addPart: async () => 'part-1',
      updatePart: async (...args: any[]) => {
        partUpdates.push(args);
      },
      updateMessage: async (...args: any[]) => {
        messageUpdates.push(args);
      },
      writeContextSnapshot: async () => {}
    };

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield {
        type: 'tool-call',
        toolName: 'await_human',
        toolCallId: 'call-1',
        toolInput: { prompt: 'Approve?' },
        toolStartTime: 1_500,
      };
      yield {
        type: 'usage',
        usageKind: 'step',
        usage: {
          inputTokens: 76_000,
          outputTokens: 120,
          totalTokens: 76_120,
          inputTokenDetails: { cacheReadTokens: 20_000 },
        } as any,
      };
      yield {
        type: 'suspended',
        toolName: 'await_human',
        toolCallId: 'call-1',
        toolResultRaw: {
          kind: 'await_human',
          prompt: 'Approve?',
          resumeToken: 'token-1',
        },
      };
    }

    const result = await processAgentStream(chunks(), {
      sessionManager: sessionManager as any,
      sessionID: 'session-1',
      agentId: 'agent-1',
      messageID: 'message-1',
      quiet: true
    });

    expect(result.suspended).toBe(true);
    expect(result.usage).toMatchObject({
      inputTokens: 76_000,
      outputTokens: 120,
      totalTokens: 76_120,
    });
    expect(messageUpdates).toHaveLength(1);
    expect(messageUpdates[0][3]).toMatchObject({
      assistant: {
        tokens: {
          input: 76_000,
          output: 120,
          cache: { read: 20_000 },
        },
      },
    });
    expect(partUpdates[0][4].state.status).toBe('pending');
  });

  it('persists reasoning chunks as a streamed reasoning part, finalized before text', async () => {
    const adds: any[] = [];
    const updates: any[] = [];
    let partCounter = 0;
    const sessionManager = {
      addPart: async (_s: string, _a: string, _m: string, part: any) => {
        adds.push(part);
        return `part-${++partCounter}`;
      },
      updatePart: async (...args: any[]) => {
        updates.push(args);
      },
      updateMessage: async () => {}
    };

    async function* chunks(): AsyncGenerator<AgentChunk> {
      yield { type: 'reasoning', reasoningId: 'r1', text: 'Let me ' };
      yield { type: 'reasoning', reasoningId: 'r1', text: 'think.' };
      yield { type: 'reasoning', reasoningId: 'r1', reasoningDone: true };
      yield { type: 'text', text: 'Answer.' };
      yield { type: 'finish', finishReason: 'stop' };
    }

    await processAgentStream(chunks(), {
      sessionManager: sessionManager as any,
      sessionID: 'session-1',
      agentId: 'agent-1',
      messageID: 'message-1',
      quiet: true
    });

    // First part created is the reasoning block, then the text part.
    expect(adds[0]).toMatchObject({ type: 'reasoning', text: 'Let me ' });
    expect(adds.some((p) => p.type === 'text')).toBe(true);

    // The reasoning part (part-1) is finalized with the accumulated text + an end time.
    const reasoningFinalize = updates.find((u) => u[3] === 'part-1');
    expect(reasoningFinalize).toBeDefined();
    expect(reasoningFinalize![4]).toMatchObject({
      text: 'Let me think.',
      time: { start: expect.any(Number), end: expect.any(Number) }
    });
  });
});
