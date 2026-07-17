/**
 * Lease lifecycle at the resume boundary (agentuse-lab#165, Phase 2): an
 * APPROVE decision derives a lease from the gate's changes[]; reject/comment
 * revoke it. The lease is what lets `effects:`-declared commands run.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { applyResumeToolResult } from '../src/runner/resume';
import { LeaseStore, LEASE_FILENAME } from '../src/runner/approval-lease';

const APPROVED_REPLY = 'Agree completely. The eval harness is the real product; the agent is the demo.';

async function makeSuspendedSession(gateInput: Record<string, unknown>) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-resume-lease-'));
  process.env.XDG_DATA_HOME = projectRoot;
  await initStorage(projectRoot);
  const sessionManager = new SessionManager();
  const agentId = 'agents/reply';
  const sessionID = await sessionManager.createSession({
    agent: { id: agentId, name: 'reply', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot }
  });
  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: { prompt: { task: 'Draft a reply' } },
    assistant: {
      system: ['system'], modelID: 'test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    }
  });
  await sessionManager.addPart(sessionID, agentId, messageID, {
    type: 'tool',
    callID: 'call-gate',
    tool: 'await_human',
    state: {
      status: 'pending',
      input: gateInput,
      suspendedAt: 1_000,
      resumePayload: { kind: 'await_human', prompt: 'Approve?', resumeToken: 'tok-123' }
    }
  } as any);
  await sessionManager.updateSession(sessionID, agentId, { status: 'suspended' });
  const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
  return { projectRoot, sessionManager, sessionID, agentId, sessionDir };
}

const GATE_INPUT = {
  prompt: 'Approve this reply?',
  changes: [
    { label: 'Reply to post', content: APPROVED_REPLY },
    { label: 'Then: update store', content: 'store item-1 status=posted note=done' },
  ],
};

describe('resume lease lifecycle', () => {
  it('approve derives a lease from changes[] that covers the approved command', async () => {
    const { projectRoot, sessionManager, sessionID, sessionDir } = await makeSuspendedSession(GATE_INPUT);
    try {
      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'approved', reviewer: { username: 'web' } },
        resumeToken: 'tok-123',
      });

      const store = new LeaseStore(sessionDir);
      const lease = store.read();
      expect(lease).toBeDefined();
      expect(lease!.entries).toHaveLength(2);
      expect(lease!.entries[0].content).toBe(APPROVED_REPLY);
      expect(store.isCovered(`birdc reply 2077948120484513954 "${APPROVED_REPLY}"`)).toBe(true);
      expect(store.isCovered('birdc reply 123 "a different unapproved draft entirely"')).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it("approve grants under the CLI decision shape too (status: 'approve', not 'approved')", async () => {
    // The CLI sends `status: 'approve'` while Slack/serve send 'approved'
    // (both normalize to the same decision downstream). The live e2e replay
    // caught the lease grant only matching 'approved': a CLI approval
    // revoked the lease and the approved command stayed denied.
    const { projectRoot, sessionManager, sessionID, sessionDir } = await makeSuspendedSession(GATE_INPUT);
    try {
      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'approve', reviewer: { username: 'cli' } },
        resumeToken: 'tok-123',
      });

      const store = new LeaseStore(sessionDir);
      const lease = store.read();
      expect(lease).toBeDefined();
      expect(store.isCovered(`birdc reply 2077948120484513954 "${APPROVED_REPLY}"`)).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('reject revokes any existing lease and grants nothing', async () => {
    const { projectRoot, sessionManager, sessionID, sessionDir } = await makeSuspendedSession(GATE_INPUT);
    try {
      new LeaseStore(sessionDir).grant({ version: 1, grantedAt: 1, entries: [{ content: 'stale approved content here' }] });

      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'rejected', reviewer: { username: 'web' } },
        resumeToken: 'tok-123',
      });

      expect(fs.existsSync(join(sessionDir, LEASE_FILENAME))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('comment revokes (feedback is not approval)', async () => {
    const { projectRoot, sessionManager, sessionID, sessionDir } = await makeSuspendedSession(GATE_INPUT);
    try {
      new LeaseStore(sessionDir).grant({ version: 1, grantedAt: 1, entries: [{ content: 'stale approved content here' }] });

      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'commented', comment: 'do another angle', reviewer: { username: 'web' } },
        resumeToken: 'tok-123',
      });

      expect(fs.existsSync(join(sessionDir, LEASE_FILENAME))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('approve on a gate without changes[] grants nothing (and clears stale leases)', async () => {
    const { projectRoot, sessionManager, sessionID, sessionDir } = await makeSuspendedSession({ prompt: 'Proceed?' });
    try {
      new LeaseStore(sessionDir).grant({ version: 1, grantedAt: 1, entries: [{ content: 'stale approved content here' }] });

      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'approved', reviewer: { username: 'web' } },
        resumeToken: 'tok-123',
      });

      expect(fs.existsSync(join(sessionDir, LEASE_FILENAME))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
