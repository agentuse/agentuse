import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { reopenSuspendedGate } from '../src/runner';

async function makeSession() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-reopen-'));
  process.env.XDG_DATA_HOME = projectRoot;
  await initStorage(projectRoot);
  const sessionManager = new SessionManager();
  const sessionID = await sessionManager.createSession({
    agent: { id: 'agents/review', name: 'review', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot }
  });
  const agentId = 'agents/review';
  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: { prompt: { task: 'Draft a post' } },
    assistant: {
      system: ['system'], modelID: 'test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    }
  });
  return { projectRoot, sessionManager, sessionID, agentId, messageID };
}

// A gate that was resolved by a resume: completed tool part that still carries
// the original resumePayload under metadata (this is how applyResumeToolResult
// records it), with the session left in `error` by a downstream run failure.
async function addResolvedGate(sm: SessionManager, sessionID: string, agentId: string, messageID: string) {
  await sm.addPart(sessionID, agentId, messageID, {
    type: 'tool',
    callID: 'call-gate',
    tool: 'await_human',
    state: {
      status: 'completed',
      input: { prompt: 'Approve?' },
      output: { status: 'comment', comment: 'tweak it', reviewer: { username: 'web' } },
      metadata: { resumePayload: { kind: 'await_human', prompt: 'Approve?', resumeToken: 'tok-123', approvalUrl: 'https://x/y' } },
      time: { start: 1_000, end: 2_000 }
    }
  } as any);
}

describe('reopenSuspendedGate', () => {
  it('rolls an errored session back to a suspended pending gate and clears the error', async () => {
    const { projectRoot, sessionManager, sessionID, agentId, messageID } = await makeSession();
    try {
      await addResolvedGate(sessionManager, sessionID, agentId, messageID);
      await sessionManager.updateSession(sessionID, agentId, {
        status: 'error',
        error: { code: 'EXECUTION_ERROR', message: 'Invalid prompt', time: 3_000 }
      });

      const result = await reopenSuspendedGate({ sessionManager, sessionId: sessionID });
      expect(result.ok).toBe(true);

      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('suspended');
      expect(found?.session.error).toBeUndefined();

      const parts = await sessionManager.getMessageParts(sessionID, found!.agentId, messageID);
      const gate: any = parts.find((p: any) => p.tool === 'await_human');
      expect(gate.state.status).toBe('pending');
      expect(gate.state.resumePayload.resumeToken).toBe('tok-123');
      expect(gate.state.suspendedAt).toBe(1_000);
      // The decision output is gone; the gate is actionable again.
      expect(gate.state.output).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('refuses a session with no resolved gate', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeSession();
    try {
      await sessionManager.updateSession(sessionID, agentId, {
        status: 'error',
        error: { code: 'EXECUTION_ERROR', message: 'boom', time: 3_000 }
      });
      const result = await reopenSuspendedGate({ sessionManager, sessionId: sessionID });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NO_REOPENABLE_GATE');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('refuses a still-running session', async () => {
    const { projectRoot, sessionManager, sessionID, agentId, messageID } = await makeSession();
    try {
      await addResolvedGate(sessionManager, sessionID, agentId, messageID);
      await sessionManager.updateSession(sessionID, agentId, { status: 'running' });
      const result = await reopenSuspendedGate({ sessionManager, sessionId: sessionID });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('SESSION_RUNNING');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
