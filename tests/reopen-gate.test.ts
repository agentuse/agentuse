import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager, rehydrateMessages } from '../src/session';
import { applyResumeToolResult, reopenSuspendedGate } from '../src/runner';

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

  // Regression: reopening a gate on a run that already finished used to rewind
  // only the gate part. The abandoned attempt's tail — its tool calls and its
  // closing report — stayed in the part log while the context snapshot was
  // still the pre-gate one, so the retry rehydrated a history ending on the
  // assistant's sign-off. Anthropic rejects that as an assistant prefill
  // (HTTP 400, "the conversation must end with a user message").
  it('retires the abandoned attempt so the retry replays from the gate', async () => {
    const { projectRoot, sessionManager, sessionID, agentId, messageID } = await makeSession();
    try {
      // Snapshot captured when the run suspended on the gate.
      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 500,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Draft a post' },
          { role: 'assistant', content: 'Draft is ready for review.' }
        ],
        usage: { activeTokens: 0, usagePercentage: 0, compacted: false, compactions: 0, updatedAt: 500 }
      });
      await addResolvedGate(sessionManager, sessionID, agentId, messageID);
      // What the first (failed) resume recorded after the approval.
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text', text: 'Approved — posting now.', time: { start: 3_000, end: 3_000 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool', callID: 'call-post', tool: 'tools__bash',
        state: { status: 'error', input: { command: 'post' }, error: 'daemon unreachable', time: { start: 4_000, end: 4_000 } }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text', text: 'Incomplete: the browser bridge is down, nothing was posted.', time: { start: 5_000, end: 5_000 }
      } as any);
      await sessionManager.updateSession(sessionID, agentId, {
        status: 'completed'
      });

      const reopened = await reopenSuspendedGate({ sessionManager, sessionId: sessionID });
      expect(reopened.ok).toBe(true);

      const parts = await sessionManager.getMessageParts(sessionID, agentId, messageID);
      const gate: any = parts.find((p: any) => p.tool === 'await_human');
      expect(gate.superseded).toBeUndefined();
      expect(parts.filter((p: any) => p.superseded).length).toBe(3);

      // The reviewer approves again; this is the request that used to 400.
      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'approve', reviewer: { username: 'web' } },
        resumeToken: 'tok-123'
      });

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);
      expect(messages[messages.length - 1]?.role).not.toBe('assistant');
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain('the browser bridge is down');
      expect(serialized).not.toContain('daemon unreachable');
      // The approval decision itself still reaches the retry.
      expect(serialized).toContain('"status":"approve"');
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
