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
      }
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
});
