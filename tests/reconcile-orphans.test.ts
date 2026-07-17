import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { reconcileOrphanedSessions, reopenSuspendedGate } from '../src/runner';

async function makeSession(task = 'Draft a post') {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-reconcile-'));
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
    user: { prompt: { task } },
    assistant: {
      system: ['system'], modelID: 'test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    }
  });
  return { projectRoot, sessionManager, sessionID, agentId, messageID };
}

// A gate resolved by a resume that then died mid-run: completed await_human part
// that still carries the original resumePayload under metadata (how
// applyResumeToolResult records it), while the session is left 'running'.
async function addResolvedGate(sm: SessionManager, sessionID: string, agentId: string, messageID: string) {
  await sm.addPart(sessionID, agentId, messageID, {
    type: 'tool',
    callID: 'call-gate',
    tool: 'await_human',
    state: {
      status: 'completed',
      input: { prompt: 'Approve?' },
      output: { status: 'comment', comment: '1', reviewer: { username: 'web' } },
      metadata: { resumePayload: { kind: 'await_human', prompt: 'Approve?', resumeToken: 'tok-123', approvalUrl: 'https://x/y' } },
      time: { start: 1_000, end: 2_000 }
    }
  } as any);
}

describe('reconcileOrphanedSessions', () => {
  it('flips a stuck-running session (touched before cutoff) to error(WORKER_INTERRUPTED)', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeSession();
    try {
      // createSession leaves status 'running' — exactly the zombie a dead worker
      // leaves — but stamps this (very alive) test process as owner; point the
      // record at an impossible pid so the sweep sees a dead owner.
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: 0x7fffffff } });
      const cutoff = Date.now() + 60_000; // session was last touched before this
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff });

      expect(reconciled.map((r) => r.sessionId)).toContain(sessionID);
      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('error');
      expect(found?.session.error?.code).toBe('WORKER_INTERRUPTED');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('leaves a running session owned by the current live worker (touched at/after cutoff) alone', async () => {
    const { projectRoot, sessionManager, sessionID } = await makeSession();
    try {
      // cutoff in the distant past => the just-created session's time.updated >= cutoff,
      // i.e. it belongs to this live worker and must NOT be reconciled.
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: 1 });

      expect(reconciled).toHaveLength(0);
      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('running');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('ignores sessions that are not running (suspended / completed / error)', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeSession();
    try {
      await sessionManager.setSessionSuspended(sessionID, agentId);
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled).toHaveLength(0);
      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('suspended');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('recovers the exact zombie: reconcile then reopenSuspendedGate re-arms the gate', async () => {
    // The end-to-end fix. Before reconciliation the session is 'running' with a
    // resolved gate, and reopenSuspendedGate refuses it (SESSION_RUNNING) — the
    // permanent zombie. After reconciliation it is 'error', so reopen works and
    // the approval gate becomes actionable again with its token intact.
    const { projectRoot, sessionManager, sessionID, agentId, messageID } = await makeSession();
    try {
      await addResolvedGate(sessionManager, sessionID, agentId, messageID);
      // The dead worker's session records a dead owner (see the first test).
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: 0x7fffffff } });

      // Precondition: while 'running', reopen is impossible.
      const blocked = await reopenSuspendedGate({ sessionManager, sessionId: sessionID });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe('SESSION_RUNNING');

      // Reconcile the orphan, then reopen.
      await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });
      const reopened = await reopenSuspendedGate({ sessionManager, sessionId: sessionID });
      expect(reopened.ok).toBe(true);

      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('suspended');
      expect(found?.session.error).toBeUndefined();

      const parts = await sessionManager.getMessageParts(sessionID, found!.agentId, messageID);
      const gate: any = parts.find((p: any) => p.tool === 'await_human');
      expect(gate.state.status).toBe('pending');
      expect(gate.state.resumePayload.resumeToken).toBe('tok-123');
      expect(gate.state.output).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
