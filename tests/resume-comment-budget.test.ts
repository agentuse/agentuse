/**
 * A human Comment at a gate asks for new work, so the revision starts on a
 * fresh execution budget. Approve keeps the clock it had.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { applyResumeToolResult, restoreResumeToolResult } from '../src/runner/resume';

const SPENT = { configuredMs: 1_500_000, elapsedMs: 1_200_000, effectiveMs: 1_500_000, modelLatencyMs: 80_000, noticeDeliveredAt: 5, wrappedUpAt: 6 };

/** A parent session and a child suspended at a gate, both with spent budgets. */
async function makeSuspendedSession() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-comment-budget-'));
  process.env.XDG_DATA_HOME = projectRoot;
  await initStorage(projectRoot);
  const sessionManager = new SessionManager();
  const agentId = 'agents/image';
  const create = (parentSessionID?: string) => sessionManager.createSession({
    agent: { id: agentId, name: 'image', isSubAgent: !!parentSessionID },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
    ...(parentSessionID && { parentSessionID }),
  });
  const parentID = await create();
  const sessionID = await create(parentID);
  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: { prompt: { task: 'Respin an image' } },
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
      input: { prompt: 'Schedule this image?' },
      suspendedAt: 1_000,
      resumePayload: { kind: 'await_human', prompt: 'Schedule this image?', resumeToken: 'tok-1' }
    }
  } as any);
  for (const id of [parentID, sessionID]) {
    await sessionManager.updateSession(id, agentId, { executionBudget: SPENT });
  }
  await sessionManager.updateSession(sessionID, agentId, { status: 'suspended' });
  return { projectRoot, sessionManager, sessionID, parentID };
}

const budgetOf = async (sessionManager: SessionManager, id: string) =>
  (await sessionManager.findSession(id))!.session.executionBudget!;

describe('execution budget across a gate decision', () => {
  it('a human comment resets the session and its ancestors to a fresh budget', async () => {
    const { projectRoot, sessionManager, sessionID, parentID } = await makeSuspendedSession();
    try {
      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'comment', comment: 'Use a thought bubble instead', reviewer: { username: 'web' } },
        resumeToken: 'tok-1',
      });
      for (const id of [sessionID, parentID]) {
        const budget = await budgetOf(sessionManager, id);
        expect(budget.elapsedMs).toBe(0);
        expect(budget.noticeDeliveredAt).toBeUndefined();
        expect(budget.wrappedUpAt).toBeUndefined();
        expect(budget.modelLatencyMs).toBe(80_000);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('approve keeps the spent budget', async () => {
    const { projectRoot, sessionManager, sessionID } = await makeSuspendedSession();
    try {
      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'approved', reviewer: { username: 'web' } },
        resumeToken: 'tok-1',
      });
      expect((await budgetOf(sessionManager, sessionID)).elapsedMs).toBe(1_200_000);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('a judge comment is not a human comment and keeps the spent budget', async () => {
    const { projectRoot, sessionManager, sessionID } = await makeSuspendedSession();
    try {
      await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'comment', comment: 'Fix the caption', reviewer: { username: 'verify-judge' } },
        resumeToken: 'tok-1',
      });
      expect((await budgetOf(sessionManager, sessionID)).elapsedMs).toBe(1_200_000);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('a failed resume restores the spent budget with the pending gate', async () => {
    const { projectRoot, sessionManager, sessionID, parentID } = await makeSuspendedSession();
    try {
      const applied = await applyResumeToolResult({
        sessionManager,
        sessionId: sessionID,
        toolResult: { status: 'comment', comment: 'Try again', reviewer: { username: 'web' } },
        resumeToken: 'tok-1',
      });
      await restoreResumeToolResult({ sessionManager, rollback: applied.rollback });
      for (const id of [sessionID, parentID]) {
        expect(await budgetOf(sessionManager, id)).toEqual(SPENT);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
