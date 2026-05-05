import { describe, expect, it } from 'bun:test';
import { applyResumeToolResult, restoreResumeToolResult } from '../src/runner/resume';

describe('resume tool result', () => {
  it('can restore a pending approval after resume startup fails', async () => {
    const pendingState = {
      status: 'pending' as const,
      input: { prompt: 'Approve?' },
      suspendedAt: 123,
      resumePayload: {
        kind: 'await_human' as const,
        resumeToken: 'token-1'
      }
    };
    const updates: any[] = [];
    const sessionManager = {
      findSession: async () => ({
        session: {
          status: 'suspended',
          agent: { filePath: '/project/agent.agentuse' }
        },
        agentId: 'agent'
      }),
      findPendingTool: async () => ({
        message: { id: 'message-1' },
        part: {
          id: 'part-1',
          state: pendingState
        }
      }),
      updatePart: async (...args: any[]) => {
        updates.push(args);
      },
      setSessionRunning: async (...args: any[]) => {
        updates.push(['running', ...args]);
      },
      setSessionSuspended: async (...args: any[]) => {
        updates.push(['suspended', ...args]);
      }
    };

    const resumed = await applyResumeToolResult({
      sessionManager: sessionManager as any,
      sessionId: 'session-1',
      toolResult: { status: 'approve' },
      resumeToken: 'token-1'
    });

    expect(resumed.rollback).toMatchObject({
      sessionId: 'session-1',
      agentId: 'agent',
      messageId: 'message-1',
      partId: 'part-1',
      state: pendingState
    });
    expect(updates[0][4].state.status).toBe('completed');
    expect(updates[1]).toEqual(['running', 'session-1', 'agent']);

    await restoreResumeToolResult({
      sessionManager: sessionManager as any,
      rollback: resumed.rollback
    });

    expect(updates[2][4].state).toBe(pendingState);
    expect(updates[3]).toEqual(['suspended', 'session-1', 'agent']);
  });
});
