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

// A pid that cannot be running, so the sweep sees a dead owner (the live test
// process is stamped as owner at createSession time).
const DEAD_PID = 0x7fffffff;

/** A manager parked on a delegated child via a pending subagent_wait bookmark —
 *  the state every cascade approval leaves behind while the leaf works. */
async function makeDelegatingPair(childStatus: 'running' | 'error' | 'suspended' | 'completed' | 'incomplete') {
  const base = await makeSession('Delegate the post');
  const { projectRoot, sessionManager: rootSm, sessionID: rootId, agentId: rootAgentId, messageID: rootMsg } = base;

  const childSm = new SessionManager();
  childSm.setParentPath(rootSm.getFullPath()!);
  const childAgentId = 'agents/leaf';
  const childId = await childSm.createSession({
    agent: { id: childAgentId, name: 'leaf-agent', isSubAgent: true },
    parentSessionID: rootId,
    model: 'demo:test', version: 'test', config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  if (childStatus === 'error') {
    // A dead-end error (not INCOMPLETE, which carries a durable report and is
    // finishable — see isFinishableStale).
    await childSm.setSessionError(childId, childAgentId, { code: 'WORKER_INTERRUPTED', message: 'Run was interrupted when its serve worker restarted' });
  } else if (childStatus === 'suspended') {
    await childSm.setSessionSuspended(childId, childAgentId);
  } else if (childStatus === 'completed') {
    await childSm.updateSession(childId, childAgentId, { status: 'completed' });
  } else if (childStatus === 'incomplete') {
    // report_incomplete's terminal shape: status 'error' with code INCOMPLETE.
    await childSm.setSessionError(childId, childAgentId, { code: 'INCOMPLETE', message: 'Substack session logged out; needs re-auth' });
  }

  await rootSm.addPart(rootId, rootAgentId, rootMsg, {
    type: 'tool', callID: 'root-call', tool: 'subagent__leaf',
    state: {
      status: 'pending', input: { task: 'draft' }, suspendedAt: Date.now(),
      resumePayload: { kind: 'subagent_wait', childSessionID: childId, childAgentName: 'leaf-agent' },
    },
  } as any);
  await rootSm.setSessionSuspended(rootId, rootAgentId);

  return { ...base, childSm, childId, childAgentId };
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

  it('reports what it would settle without writing when dryRun is set', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeSession();
    try {
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });
      const cutoff = Date.now() + 60_000;

      const previewed = await reconcileOrphanedSessions({ sessionManager, cutoff, dryRun: true });
      expect(previewed.map((r) => r.sessionId)).toContain(sessionID);
      // The whole point: the report is identical, the session is not touched.
      const afterPreview = await sessionManager.findSession(sessionID);
      expect(afterPreview?.session.status).toBe('running');
      expect(afterPreview?.session.error).toBeUndefined();

      const applied = await reconcileOrphanedSessions({ sessionManager, cutoff });
      expect(applied.map((r) => r.sessionId)).toEqual(previewed.map((r) => r.sessionId));
      const afterApply = await sessionManager.findSession(sessionID);
      expect(afterApply?.session.status).toBe('error');
      expect(afterApply?.session.error?.code).toBe('WORKER_INTERRUPTED');
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

  // Only the child's own resume can complete a subagent_wait bookmark, so a
  // child that ends without one leaves its manager suspended forever.
  it('ends a manager stranded on a sub-agent that already ended', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeDelegatingPair('error');
    try {
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled).toContainEqual(expect.objectContaining({ sessionId: sessionID, reason: 'stranded' }));
      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('error');
      expect(found?.session.error?.code).toBe('CASCADE_ORPHANED');
      // The message must name the child and carry its reason.
      expect(found?.session.error?.message).toContain('leaf-agent');
      expect(found?.session.error?.message).toContain('Run was interrupted when its serve worker restarted');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  // The ordering that matters: pass 1 kills the leaf, so pass 2 must already see
  // it as terminal and sweep the manager that pass 1 just widowed.
  it('sweeps the manager widowed by its own first pass, in one call', async () => {
    const { projectRoot, sessionManager, sessionID, agentId, childId, childSm, childAgentId } =
      await makeDelegatingPair('running');
    try {
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });
      await childSm.updateSession(childId, childAgentId, { owner: { pid: DEAD_PID } });

      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled).toContainEqual(expect.objectContaining({ sessionId: childId, reason: 'interrupted' }));
      expect(reconciled).toContainEqual(expect.objectContaining({ sessionId: sessionID, reason: 'stranded' }));
      expect((await sessionManager.findSession(childId))?.session.error?.code).toBe('WORKER_INTERRUPTED');
      expect((await sessionManager.findSession(sessionID))?.session.error?.code).toBe('CASCADE_ORPHANED');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  // Issue #199: a child that ended holding a durable result (completed, or
  // incomplete — which still carries its report) must NOT be stamped terminal.
  // The sweep reports it 'finishable' untouched, so serve can drive
  // finish-cascade and fold the result into the waiting manager.
  it('reports a manager parked on a completed child as finishable, without stamping it', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeDelegatingPair('completed');
    try {
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled).toContainEqual(expect.objectContaining({ sessionId: sessionID, reason: 'finishable' }));
      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('suspended');
      expect(found?.session.error).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('reports a manager parked on an incomplete child as finishable too', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeDelegatingPair('incomplete');
    try {
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled).toContainEqual(expect.objectContaining({ sessionId: sessionID, reason: 'finishable' }));
      expect((await sessionManager.findSession(sessionID))?.session.status).toBe('suspended');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  // Only the topmost stranded ancestor is reported: the walk-up it triggers
  // resumes every level below it, so reporting an intermediate too would
  // double-drive the same chain.
  it('skips a finishable intermediate manager (one that itself has a parent)', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeDelegatingPair('completed');
    try {
      await sessionManager.updateSession(sessionID, agentId, {
        owner: { pid: DEAD_PID },
        parentSessionID: '01FAKEROOTSESSIONID0000000',
      } as any);
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled.map((r) => r.sessionId)).not.toContain(sessionID);
      const found = await sessionManager.findSession(sessionID);
      expect(found?.session.status).toBe('suspended');
      expect(found?.session.error).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('leaves a manager alone while its sub-agent is genuinely still running', async () => {
    const { projectRoot, sessionManager, sessionID, agentId } = await makeDelegatingPair('running');
    try {
      // Dead owner on the manager, so only the child's liveness can save it.
      // The child keeps this test process as owner, i.e. it really is running.
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled.map((r) => r.sessionId)).not.toContain(sessionID);
      expect((await sessionManager.findSession(sessionID))?.session.status).toBe('suspended');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  // Mid-cascade, a healthy chain is indistinguishable from a stranded one in the
  // window between the child ending and the parent's bookmark being completed.
  // A live owner process is the only signal that separates them.
  it('leaves a stranded-looking manager alone while its owner process is alive', async () => {
    const { projectRoot, sessionManager, sessionID } = await makeDelegatingPair('error');
    try {
      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled.map((r) => r.sessionId)).not.toContain(sessionID);
      expect((await sessionManager.findSession(sessionID))?.session.status).toBe('suspended');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('leaves a manager alone while a human gate is still waiting below it', async () => {
    const { projectRoot, sessionManager, sessionID, agentId, childId, childSm, childAgentId } =
      await makeDelegatingPair('suspended');
    try {
      const childMsg = await childSm.createMessage(childId, childAgentId, {
        user: { prompt: { task: 'draft' } },
        assistant: {
          system: ['system'], modelID: 'test', providerID: 'demo', mode: 'build',
          path: { cwd: projectRoot, root: projectRoot }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      });
      await childSm.addPart(childId, childAgentId, childMsg, {
        type: 'tool', callID: 'leaf-call', tool: 'await_human',
        state: {
          status: 'pending', input: { prompt: 'Approve?' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'await_human', resumeToken: 'leaf-token' },
        },
      } as any);
      await sessionManager.updateSession(sessionID, agentId, { owner: { pid: DEAD_PID } });

      const reconciled = await reconcileOrphanedSessions({ sessionManager, cutoff: Date.now() + 60_000 });

      expect(reconciled.map((r) => r.sessionId)).not.toContain(sessionID);
      expect((await sessionManager.findSession(sessionID))?.session.status).toBe('suspended');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
