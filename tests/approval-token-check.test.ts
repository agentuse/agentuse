import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { getApprovalInfoUncached } from '../src/worker/approval';

const agentId = 'agents/reviewer';

async function createSession(manager: SessionManager, projectRoot: string, gateToken?: string): Promise<string> {
  const sessionId = await manager.createSession({
    agent: { id: agentId, name: 'Reviewer', isSubAgent: false },
    model: 'demo:test', version: 'test', config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  if (!gateToken) return sessionId;
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'review' } },
    assistant: {
      system: [], modelID: 'demo:test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  await manager.addPart(sessionId, agentId, messageId, {
    type: 'tool', callID: `call-${sessionId}`, tool: 'await_human',
    state: {
      status: 'pending',
      input: { prompt: 'Ship it?' },
      suspendedAt: Date.now(),
      resumePayload: { kind: 'await_human', resumeToken: gateToken },
    },
  } as Parameters<SessionManager['addPart']>[3]);
  await manager.setSessionSuspended(sessionId, agentId);
  return sessionId;
}

describe('approval info resume-token check', () => {
  let originalXdgDataHome: string | undefined;
  let dataHome: string;
  let projectRoot: string;
  let manager: SessionManager;

  beforeEach(async () => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    dataHome = await mkdtemp(join(tmpdir(), 'agentuse-approval-token-'));
    projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    await initStorage(projectRoot);
    manager = new SessionManager();
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await rm(dataHome, { recursive: true, force: true });
  });

  const lookup = (sessionId: string, extra: { resumeToken?: string | undefined; allowHistorical?: boolean; skipTokenCheck?: boolean }) =>
    getApprovalInfoUncached({ id: 'req', type: 'approval-info', projectRoot, sessionId, ...extra } as never);

  it('rejects any caller token on a session that never issued one', async () => {
    const sessionId = await createSession(manager, projectRoot);
    for (const resumeToken of ['x', undefined]) {
      const result = await lookup(sessionId, { resumeToken, allowHistorical: true });
      expect(result).toMatchObject({ success: false, error: { code: 'RESUME_TOKEN_INVALID' } });
    }
  });

  it('accepts only the token the gate issued', async () => {
    const sessionId = await createSession(manager, projectRoot, 'real-gate-token');
    expect(await lookup(sessionId, { resumeToken: 'guess', allowHistorical: true }))
      .toMatchObject({ success: false, error: { code: 'RESUME_TOKEN_INVALID' } });
    expect(await lookup(sessionId, { resumeToken: 'real-gate-token' })).toMatchObject({ success: true });
  });

  it('lets serve read an already-authorized session without a token', async () => {
    const sessionId = await createSession(manager, projectRoot);
    expect(await lookup(sessionId, { skipTokenCheck: true })).toMatchObject({ success: true });
  });
});
