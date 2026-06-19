import { describe, expect, it } from 'bun:test';
import { persistAssistantRunState } from '../src/runner/run';

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
});
