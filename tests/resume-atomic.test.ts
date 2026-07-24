import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { applyResumeToolResult } from '../src/runner/resume';

async function createSuspendedSession(sessionManager: SessionManager, projectRoot: string) {
  const agentId = 'agents/reviewer';
  const sessionId = await sessionManager.createSession({
    agent: { id: agentId, name: 'reviewer', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageId = await sessionManager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'Review this' } },
    assistant: {
      system: ['system'],
      modelID: 'test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  const partId = await sessionManager.addPart(sessionId, agentId, messageId, {
    type: 'tool',
    callID: 'call-gate',
    tool: 'await_human',
    state: {
      status: 'pending',
      input: { prompt: 'Approve?' },
      suspendedAt: 1,
      resumePayload: {
        kind: 'await_human',
        prompt: 'Approve?',
        resumeToken: `token-${sessionId}`,
      },
    },
  } as any);
  await sessionManager.updateSession(sessionId, agentId, { status: 'suspended' });
  return { sessionId, agentId, messageId, partId, resumeToken: `token-${sessionId}` };
}

function holdFirstFindAtBarrier(
  manager: SessionManager,
  arrive: () => Promise<void>
): void {
  const findSession = manager.findSession.bind(manager);
  let calls = 0;
  manager.findSession = (async (...args: Parameters<SessionManager['findSession']>) => {
    const result = await findSession(...args);
    if (calls++ === 0) await arrive();
    return result;
  }) as SessionManager['findSession'];
}

describe('atomic resume claim', () => {
  test('only one cross-manager resume can consume a suspended gate', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-resume-atomic-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);

      for (let round = 0; round < 12; round++) {
        const setupManager = new SessionManager();
        const fixture = await createSuspendedSession(setupManager, projectRoot);
        const managerA = new SessionManager();
        const managerB = new SessionManager();

        let arrivals = 0;
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        const arrive = async () => {
          arrivals++;
          if (arrivals === 2) releaseBarrier();
          await barrier;
        };
        holdFirstFindAtBarrier(managerA, arrive);
        holdFirstFindAtBarrier(managerB, arrive);

        const results = await Promise.allSettled([
          applyResumeToolResult({
            sessionManager: managerA,
            sessionId: fixture.sessionId,
            toolResult: { status: 'approve', reviewer: { username: 'a' } },
            resumeToken: fixture.resumeToken,
          }),
          applyResumeToolResult({
            sessionManager: managerB,
            sessionId: fixture.sessionId,
            toolResult: { status: 'approve', reviewer: { username: 'b' } },
            resumeToken: fixture.resumeToken,
          }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(String(rejected.reason)).toContain('SESSION_NOT_SUSPENDED: running');

        const part = await setupManager.getPart(
          fixture.sessionId,
          fixture.agentId,
          fixture.messageId,
          fixture.partId
        ) as any;
        expect(part.state.status).toBe('completed');
        expect(['a', 'b']).toContain(part.state.output.reviewer.username);
      }
    } finally {
      delete process.env.XDG_DATA_HOME;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
