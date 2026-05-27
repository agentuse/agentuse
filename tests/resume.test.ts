import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionInfo } from '../src/session/types';
import { resolveResumeExecutionContext } from '../src/cli/sessions';
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

describe('resume execution context', () => {
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'agentuse-resume-context-'));
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('uses persisted cwd to rebuild execution root while preserving session stateRoot', async () => {
    const executionProject = join(scratchDir, 'execution-project');
    const stateProject = join(scratchDir, 'state-project');
    const originalCwd = join(executionProject, 'work');
    await mkdir(originalCwd, { recursive: true });
    await mkdir(join(stateProject, 'agents'), { recursive: true });
    await writeFile(join(executionProject, 'package.json'), '{}');
    await writeFile(join(stateProject, 'package.json'), '{}');

    const session = {
      project: {
        root: stateProject,
        cwd: originalCwd,
      },
      agent: {
        id: 'agents/foo',
        name: 'foo',
        filePath: join(stateProject, 'agents', 'foo.agentuse'),
        isSubAgent: false,
      },
    } as SessionInfo;

    const resolved = resolveResumeExecutionContext(session, stateProject, {}, stateProject);

    expect(resolved.cwd).toBe(originalCwd);
    expect(resolved.projectContext.projectRoot).toBe(executionProject);
    expect(resolved.projectContext.stateRoot).toBe(stateProject);
  });
});
