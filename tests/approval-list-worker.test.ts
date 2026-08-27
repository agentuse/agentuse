import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { initStorage, readJSON, writeJSON } from '../src/storage';
import { SessionManager } from '../src/session';

async function readWorkerJson(rl: ReadlineInterface, timeoutMs = 10_000): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for worker response'));
    }, timeoutMs);

    const onLine = (line: string) => {
      try {
        const parsed = JSON.parse(line);
        cleanup();
        resolve(parsed);
      } catch {
        // Ignore non-JSON diagnostic output.
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      rl.off('line', onLine);
    };

    rl.on('line', onLine);
  });
}

async function startWorker(): Promise<{ child: ChildProcessWithoutNullStreams; rl: ReadlineInterface }> {
  const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  const rl = createInterface({ input: child.stdout });
  const ready = await readWorkerJson(rl);
  expect(ready).toEqual({ type: 'ready' });
  return { child, rl };
}

async function addPendingApproval(
  manager: SessionManager,
  projectRoot: string,
  agentId: string,
  prompt: string
): Promise<string> {
  const sessionId = await manager.createSession({
    agent: { id: agentId, name: agentId, isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'review' } },
    assistant: {
      system: [],
      modelID: 'demo:test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  await manager.addPart(sessionId, agentId, messageId, {
    type: 'tool',
    callID: `call-${sessionId}`,
    tool: 'await_human',
    state: {
      status: 'pending',
      input: { prompt },
      suspendedAt: Date.now(),
      resumePayload: { kind: 'await_human', resumeToken: `token-${sessionId}` },
    },
  });
  await manager.setSessionSuspended(sessionId, agentId);
  return sessionId;
}

describe('approval list worker', () => {
  let worker: { child: ChildProcessWithoutNullStreams; rl: ReadlineInterface } | undefined;

  afterEach(() => {
    worker?.rl.close();
    worker?.child.kill();
    worker = undefined;
  });

  it('filters the durable approval projection by the session creation window', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const originalNow = Date.now;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-approvals-window-'));
    const projectRoot = join(dataHome, 'project');
    const cutoff = Date.UTC(2026, 4, 1);
    const oldSessionTime = cutoff - 45 * 24 * 60 * 60 * 1000;
    const freshApprovalTime = cutoff + 60_000;

    process.env.XDG_DATA_HOME = dataHome;
    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();

      Date.now = () => oldSessionTime;
      const oldSessionId = await sessionManager.createSession({
        agent: { id: 'agents/review', name: 'Review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const oldMessageId = await sessionManager.createMessage(oldSessionId, 'agents/review', {
        user: { prompt: { task: 'review this' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      Date.now = () => freshApprovalTime;
      await sessionManager.addPart(oldSessionId, 'agents/review', oldMessageId, {
        type: 'tool',
        callID: 'call-1',
        tool: 'await_human',
        state: {
          status: 'pending',
          input: { prompt: 'Approve fresh item?' },
          suspendedAt: freshApprovalTime,
          resumePayload: { kind: 'await_human', resumeToken: 'fresh-token' },
        },
      });
      await sessionManager.setSessionSuspended(oldSessionId, 'agents/review');

      const freshSessionId = await sessionManager.createSession({
        agent: { id: 'agents/fresh-review', name: 'Fresh Review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const freshMessageId = await sessionManager.createMessage(freshSessionId, 'agents/fresh-review', {
        user: { prompt: { task: 'review fresh' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      await sessionManager.addPart(freshSessionId, 'agents/fresh-review', freshMessageId, {
        type: 'tool',
        callID: 'call-2',
        tool: 'await_human',
        state: {
          status: 'pending',
          input: { prompt: 'Approve fresh session?' },
          suspendedAt: freshApprovalTime,
          resumePayload: { kind: 'await_human', resumeToken: 'fresh-session-token' },
        },
      });
      await sessionManager.setSessionSuspended(freshSessionId, 'agents/fresh-review');

      worker = await startWorker();
      worker.child.stdin.write(`${JSON.stringify({
        id: 'list-1',
        type: 'list-approvals',
        projectRoot,
        approvalCreatedAfter: cutoff,
      })}\n`);

      const response = await readWorkerJson(worker.rl);
      expect(response.success).toBe(true);
      expect(response.approvals).toHaveLength(1);
      expect(response.approvals[0]).toMatchObject({
        sessionId: freshSessionId,
        status: 'pending',
        prompt: 'Approve fresh session?',
        resumeToken: 'fresh-session-token',
      });
    } finally {
      Date.now = originalNow;
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  it('classifies an orphaned pending gate on a terminally-errored session as errored, not pending', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-approvals-errored-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();

      const addPendingGate = async (agentId: string, name: string): Promise<string> => {
        const sessionId = await sessionManager.createSession({
          agent: { id: agentId, name, isSubAgent: false },
          model: 'demo:test',
          version: 'test',
          config: {},
          project: { root: projectRoot, cwd: projectRoot },
        });
        const messageId = await sessionManager.createMessage(sessionId, agentId, {
          user: { prompt: { task: 'review' } },
          assistant: {
            system: [],
            modelID: 'demo:test',
            providerID: 'demo',
            mode: 'build',
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        });
        await sessionManager.addPart(sessionId, agentId, messageId, {
          type: 'tool',
          callID: `call-${agentId}`,
          tool: 'await_human',
          state: {
            status: 'pending',
            input: { prompt: `Approve ${name}?` },
            suspendedAt: Date.now(),
            resumePayload: { kind: 'await_human', resumeToken: `${name}-token` },
          },
        });
        return sessionId;
      };

      // A genuinely suspended gate awaiting a human -> stays 'pending'.
      const liveId = await addPendingGate('agents/live', 'Live');
      await sessionManager.setSessionSuspended(liveId, 'agents/live');

      // A gate whose run died (EXECUTION_ERROR) without resolving the part. The part
      // is still 'pending' but the session is terminally errored -> must be 'errored',
      // not surfaced as an actionable pending approval.
      const deadId = await addPendingGate('agents/dead', 'Dead');
      await sessionManager.setSessionError(deadId, 'agents/dead', {
        message: 'mainFeed root not found',
        code: 'EXECUTION_ERROR',
      });

      worker = await startWorker();
      worker.child.stdin.write(`${JSON.stringify({
        id: 'list-errored',
        type: 'list-approvals',
        projectRoot,
      })}\n`);

      const response = await readWorkerJson(worker.rl);
      expect(response.success).toBe(true);
      const byId: Record<string, { status: string }> = Object.fromEntries(
        response.approvals.map((a: { sessionId: string; status: string }) => [a.sessionId, a])
      );
      expect(byId[liveId]?.status).toBe('pending');
      expect(byId[deadId]?.status).toBe('errored');
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  it('incrementally refreshes a stale projection while preserving unmarked legacy approvals', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-approvals-incremental-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await initStorage(projectRoot);
      const manager = new SessionManager();
      const legacyId = await addPendingApproval(manager, projectRoot, 'agents/legacy', 'Approve legacy?');

      worker = await startWorker();
      worker.child.stdin.write(`${JSON.stringify({
        id: 'list-initial',
        type: 'list-approvals',
        projectRoot,
      })}\n`);
      expect((await readWorkerJson(worker.rl)).approvals).toHaveLength(1);

      const freshId = await addPendingApproval(manager, projectRoot, 'agents/fresh', 'Approve fresh?');
      const projectHash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 20);
      const projectionKey = `.index/approvals.${projectHash}.v1`;
      const projection = await readJSON<any>(projectionKey);
      await writeJSON(projectionKey, {
        version: 1,
        approvalGeneration: projection.approvalGeneration,
        approvals: projection.approvals,
      });

      // Simulate a pre-approvalRelevant index entry from an older install. The
      // v1 projection is the only durable evidence for this historical row.
      const index = await readJSON<any>('.index/sessions.v1');
      delete index.sessions[legacyId].approvalRelevant;
      await writeJSON('.index/sessions.v1', index);

      worker.child.stdin.write(`${JSON.stringify({
        id: 'invalidate',
        type: 'invalidate-lists',
        projectRoot,
      })}\n`);
      expect((await readWorkerJson(worker.rl)).success).toBe(true);
      worker.child.stdin.write(`${JSON.stringify({
        id: 'list-refreshed',
        type: 'list-approvals',
        projectRoot,
      })}\n`);

      const refreshed = await readWorkerJson(worker.rl);
      expect(refreshed.success).toBe(true);
      expect(refreshed.approvals.map((approval: { sessionId: string }) => approval.sessionId).sort())
        .toEqual([freshId, legacyId].sort());
      const migrated = await readJSON<any>(projectionKey);
      expect(migrated.version).toBe(2);
      expect(migrated.sourceUpdatedAt[freshId]).toBeNumber();
      expect(migrated.sourceUpdatedAt[legacyId]).toBeUndefined();
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(dataHome, { recursive: true, force: true });
    }
  });
});
