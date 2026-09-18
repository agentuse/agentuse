import { describe, expect, it } from 'bun:test';
import { __testing, persistAssistantRunState } from '../src/runner/run';

describe('persistAssistantRunState', () => {
  it('persists assistant token usage before terminal session state changes', async () => {
    const updates: any[] = [];
    const sessionManager = {
      updateMessage: async (...args: any[]) => {
        updates.push(args);
      },
    };

    await persistAssistantRunState({
      sessionManager: sessionManager as any,
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      result: {
        usage: {
          inputTokens: 1200,
          outputTokens: 80,
          totalTokens: 1280,
          inputTokenDetails: {
            cacheReadTokens: 900,
            cacheWriteTokens: 20,
          },
        } as any,
        contextUsage: {
          activeTokens: 1280,
          maxTokens: 200000,
          usagePercentage: 0.64,
        },
      },
    });

    expect(updates).toEqual([
      [
        'session-1',
        'agent-1',
        'message-1',
        {
          assistant: {
            tokens: {
              input: 1200,
              output: 80,
              reasoning: 0,
              cache: {
                read: 900,
                write: 20,
              },
            },
            context: {
              activeTokens: 1280,
              maxTokens: 200000,
              usagePercentage: 0.64,
            },
          },
        },
      ],
    ]);
  });

  it('persists context when provider usage is missing', async () => {
    const updates: any[] = [];
    const sessionManager = {
      updateMessage: async (...args: any[]) => {
        updates.push(args);
      },
    };

    await persistAssistantRunState({
      sessionManager: sessionManager as any,
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      completedAt: 123,
      result: {
        contextUsage: {
          activeTokens: 42,
          maxTokens: 1000,
          usagePercentage: 4.2,
        },
      },
    });

    expect(updates[0][3]).toEqual({
      time: { completed: 123 },
      assistant: {
        context: {
          activeTokens: 42,
          maxTokens: 1000,
          usagePercentage: 4.2,
        },
      },
    });
  });

  it('adds resumed invocation usage to the prior persisted token total', async () => {
    const updates: any[] = [];
    await persistAssistantRunState({
      sessionManager: {
        updateMessage: async (...args: any[]) => updates.push(args),
      } as any,
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      priorTokens: {
        input: 100,
        output: 20,
        reasoning: 3,
        cache: { read: 40, write: 5 },
      },
      result: {
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9,
          inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 1 },
          outputTokenDetails: { reasoningTokens: 1 },
        } as any,
      },
    });

    expect(updates[0][3].assistant.tokens).toEqual({
      input: 107,
      output: 22,
      reasoning: 4,
      cache: { read: 44, write: 6 },
    });
  });

  it('does not write partial assistant state without every durable identifier', async () => {
    let writes = 0;
    const sessionManager = { updateMessage: async () => { writes += 1; } } as any;
    await persistAssistantRunState({
      sessionManager,
      sessionId: 'session-1',
      agentId: 'agent-1',
      result: {},
    });
    expect(writes).toBe(0);
  });
});

describe('runner channel handle persistence', () => {
  const existing = {
    channel: 'C_EXISTING',
    channelId: 'C_EXISTING',
    ts: '100.1',
    events: ['approval'] as Array<'approval' | 'completion' | 'failure'>,
  };

  it('merges new handles by Slack message identity and replaces stale configuration', () => {
    expect(__testing.mergeSlackRunChannelHandles([existing], [
      { ...existing, events: ['approval', 'completion'] },
      { channel: 'C_NEW', channelId: 'C_NEW', ts: '200.2', events: ['failure'] },
    ])).toEqual([
      { ...existing, events: ['approval', 'completion'] },
      { channel: 'C_NEW', channelId: 'C_NEW', ts: '200.2', events: ['failure'] },
    ]);
  });

  it('preserves other channel metadata while persisting merged Slack handles', async () => {
    const updates: any[] = [];
    const sessionManager = {
      findSession: async () => ({
        session: {
          channels: {
            slack: [existing],
            custom: { deliveryId: 'delivery-1' },
          },
        },
      }),
      updateSession: async (...args: any[]) => updates.push(args),
    } as any;

    await __testing.persistRunChannelHandles({
      sessionManager,
      sessionId: 'session-1',
      agentId: 'agent-1',
      handles: [{ channel: 'C_NEW', ts: '200.2', events: ['completion'] }],
    });

    expect(updates).toEqual([[
      'session-1',
      'agent-1',
      {
        channels: {
          custom: { deliveryId: 'delivery-1' },
          slack: [
            existing,
            { channel: 'C_NEW', ts: '200.2', events: ['completion'] },
          ],
        },
      },
    ]]);
  });

  it('treats channel persistence as best-effort when session storage fails', async () => {
    await expect(__testing.persistRunChannelHandles({
      sessionManager: {
        findSession: async () => { throw new Error('storage unavailable'); },
      } as any,
      sessionId: 'session-1',
      agentId: 'agent-1',
      handles: [existing],
    })).resolves.toBeUndefined();
  });

  it('reconstructs persisted handles without exposing the session object', () => {
    const session = { channels: { slack: [existing] } } as any;
    const handles = __testing.sessionRunChannelHandles(session);
    expect(handles).toEqual([existing]);
    expect(handles[0]).not.toBe(existing);
  });
});
