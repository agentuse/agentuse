import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { finalizeSessionRunChannels } from '../src/channels/run';
import { settleWithin } from '../src/utils/settle-within';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { reconcileOrphanSessions, stopSession } from '../src/worker/sessions';
import { createWorkerContext } from '../src/worker/context';
import { logger } from '../src/utils/logger';

const SLACK_SKIP = 'Slack run channel update skipped: missing SLACK_BOT_TOKEN';

describe('finalizeSessionRunChannels', () => {
  const session = {
    id: 'session-1',
    agent: { id: 'agents/review', name: 'Review', isSubAgent: false },
    model: 'demo:default',
  };

  it('marks every live card that takes failures as failed', async () => {
    const updates: Array<{ channel: string; options: Record<string, unknown> }> = [];
    await finalizeSessionRunChannels({
      ...session,
      channels: {
        slack: [
          { channel: 'C_APPROVAL', ts: '1.0', events: ['approval'] },
          { channel: 'C_DONE_ONLY', ts: '2.0', events: ['completion'] },
        ],
      },
    }, { message: 'Session stopped by user' }, async (handle, options) => {
      updates.push({ channel: handle.channel, options: options as unknown as Record<string, unknown> });
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].channel).toBe('C_APPROVAL');
    expect(updates[0].options).toMatchObject({
      event: 'failure',
      agent: { name: 'Review', config: { model: 'demo:default' } },
      sessionId: 'session-1',
      error: 'Session stopped by user',
    });
  });

  it('does nothing for a session that never posted a card', async () => {
    let called = false;
    await finalizeSessionRunChannels(session, { message: 'x' }, async () => { called = true; });
    expect(called).toBe(false);
  });

  it('bounds a delivery that never settles', async () => {
    const started = Date.now();
    await settleWithin(new Promise(() => {}), 20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('run cards for sessions that end without a runner', () => {
  let root: string;
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalToken = process.env.SLACK_BOT_TOKEN;
  let warnings: string[];
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-run-card-'));
    process.env.XDG_DATA_HOME = root;
    // No token: the card update stops at its "skipped" warning, which is the
    // observable proof it was attempted, and nothing reaches Slack.
    delete process.env.SLACK_BOT_TOKEN;
    await initStorage(root);
    warnings = [];
    warnSpy = spyOn(logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    if (originalToken !== undefined) process.env.SLACK_BOT_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  });

  async function plantSession(status: 'suspended' | 'running') {
    const manager = new SessionManager();
    const agentId = 'agents/review';
    const sessionId = await manager.createSession({
      agent: { id: agentId, name: 'Review', isSubAgent: false },
      model: 'demo:default', version: 'test', config: {},
      project: { root, cwd: root },
    });
    await manager.updateSession(sessionId, agentId, {
      channels: { slack: [{ channel: 'C_RUN', ts: '1.0', events: ['approval', 'completion', 'failure'] }] },
    });
    if (status === 'suspended') await manager.setSessionSuspended(sessionId, agentId);
    else await manager.updateSession(sessionId, agentId, { owner: { pid: 0x7fffffff } });
    return sessionId;
  }

  it('updates the card when a suspended session is stopped', async () => {
    const sessionId = await plantSession('suspended');
    const response = await stopSession(createWorkerContext(), {
      id: 'req-1', type: 'stop-session', projectRoot: root, sessionId,
    });
    expect(response.success).toBe(true);
    expect(warnings).toContain(SLACK_SKIP);
  });

  it('updates the card when an orphaned run is reconciled as interrupted', async () => {
    const sessionId = await plantSession('running');
    const response = await reconcileOrphanSessions({
      id: 'req-2', type: 'reconcile-orphans', projectRoot: root, reconcileCutoff: Date.now() + 60_000,
    });
    expect(response.success && response.reconciled.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(warnings).toContain(SLACK_SKIP);
  });
});
