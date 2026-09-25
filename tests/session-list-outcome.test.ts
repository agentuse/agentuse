import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { createWorkerContext } from '../src/worker/context';
import { listSessions } from '../src/worker/lists';
import { invalidateListCaches } from '../src/worker/cache';

const originalXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
});

async function createStoredOutcomeSession(
  manager: SessionManager,
  projectRoot: string,
  status: 'complete' | 'idle',
  agentId = `agents/${status}-sweep`,
): Promise<string> {
  const sessionId = await manager.createSession({
    agent: { id: agentId, name: `${status} sweep`, isSubAgent: false },
    model: 'demo:test', version: 'test', config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'Sweep inboxes' } },
    assistant: {
      system: [], modelID: 'demo:test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  await manager.addPart(sessionId, agentId, messageId, {
    type: 'tool', callID: `outcome-${status}`, tool: 'report_outcome',
    state: {
      status: 'completed',
      input: { status, headline: 'Both inboxes empty', artifacts: [] },
      output: 'Recorded and delivered',
      time: { start: 1, end: 2 },
    },
  });
  await manager.addPart(sessionId, agentId, messageId, {
    type: 'text', role: 'assistant', text: '💤 Idle: prose is not the structured verdict',
    time: { start: 3, end: 4 },
  });
  // No outcome argument simulates a completed session written before the
  // compact index carried the structured verdict.
  await manager.setSessionCompleted(sessionId, agentId);
  return sessionId;
}

describe('session-list successful outcomes', () => {
  it('backfills a stored idle verdict into the compact list index once', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-list-outcome-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const agentId = 'agents/idle-sweep';
      const sessionId = await createStoredOutcomeSession(manager, projectRoot, 'idle', agentId);
      const before = (await manager.findSession(sessionId))!.session.time.updated;

      const result = await listSessions(createWorkerContext(), {
        id: 'list-1', type: 'list-sessions', projectRoot, sessionsMock: 'include',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.outcome).toBe('idle');
      const persisted = (await manager.findSession(sessionId))!.session;
      expect(persisted.outcome).toBe('idle');
      expect(persisted.time.updated).toBe(before);
      expect((await manager.listSessionSummaries())[0]?.outcome).toBe('idle');

      // Force the worker list loader to run again. Once the compact marker is
      // present, it must not inspect the transcript a second time.
      invalidateListCaches(projectRoot);
      const originalGetMessages = SessionManager.prototype.getSessionMessages;
      let transcriptReads = 0;
      SessionManager.prototype.getSessionMessages = async () => {
        transcriptReads += 1;
        throw new Error('transcript should not be read after backfill');
      };
      try {
        const again = await listSessions(createWorkerContext(), {
          id: 'list-2', type: 'list-sessions', projectRoot, sessionsMock: 'include',
        });
        expect(again.success).toBe(true);
        if (again.success) expect(again.sessions[0]?.outcome).toBe('idle');
        expect(transcriptReads).toBe(0);
      } finally {
        SessionManager.prototype.getSessionMessages = originalGetMessages;
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps explicit complete even when the prose looks idle', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-list-complete-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const sessionId = await createStoredOutcomeSession(manager, projectRoot, 'complete');
      const result = await listSessions(createWorkerContext(), {
        id: 'list-complete', type: 'list-sessions', projectRoot, sessionsMock: 'include',
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.sessions.find((row) => row.sessionId === sessionId)?.outcome).toBe('complete');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('defaults a historical completion without a stored verdict to complete', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-list-default-complete-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const agentId = 'agents/legacy-complete';
      const sessionId = await manager.createSession({
        agent: { id: agentId, name: 'Legacy complete', isSubAgent: false },
        model: 'demo:test', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      await manager.setSessionCompleted(sessionId, agentId);

      const result = await listSessions(createWorkerContext(), {
        id: 'list-default-complete', type: 'list-sessions', projectRoot, sessionsMock: 'include',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.sessions.find((row) => row.sessionId === sessionId)?.outcome).toBe('complete');
      }
      expect((await manager.findSession(sessionId))?.session.outcome).toBe('complete');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('clears a persisted idle verdict when the lifecycle reopens or fails', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-list-clear-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const agentId = 'agents/lifecycle';
      const sessionId = await manager.createSession({
        agent: { id: agentId, name: 'Lifecycle', isSubAgent: false },
        model: 'demo:test', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });

      await manager.setSessionCompleted(sessionId, agentId, 'idle');
      expect((await manager.findSession(sessionId))?.session.outcome).toBe('idle');
      await manager.setSessionRunning(sessionId, agentId);
      expect((await manager.findSession(sessionId))?.session.outcome).toBeUndefined();

      await manager.setSessionCompleted(sessionId, agentId, 'idle');
      await manager.setSessionError(sessionId, agentId, { code: 'TEST', message: 'failed' });
      expect((await manager.findSession(sessionId))?.session.outcome).toBeUndefined();

      await manager.setSessionRunning(sessionId, agentId);
      await manager.setSessionCompleted(sessionId, agentId, 'idle');
      await manager.setSessionSuspended(sessionId, agentId);
      expect((await manager.findSession(sessionId))?.session.outcome).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not let a stale backfill mark a session that resumed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-list-stale-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const agentId = 'agents/stale';
      const sessionId = await createStoredOutcomeSession(manager, projectRoot, 'idle', agentId);
      const completedAt = (await manager.findSession(sessionId))!.session.time.updated;
      await manager.setSessionRunning(sessionId, agentId);

      expect(await manager.backfillSessionOutcome(sessionId, agentId, 'idle', completedAt)).toBe(false);
      const current = (await manager.findSession(sessionId))!.session;
      expect(current.status).toBe('running');
      expect(current.outcome).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
