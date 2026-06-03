import { afterEach, describe, expect, it } from 'bun:test';
import { createAwaitHumanTool, getApprovalUrl } from '../src/tools/await-human';
import { isSuspendSignal } from '../src/runner/suspend';
import { registerServer, unregisterServer } from '../src/utils/server-registry';
import { sessionViewToken } from '../src/utils/session-token';

describe('await_human approval URL', () => {
  const originalPublicUrl = process.env.AGENTUSE_RESUME_PUBLIC_URL;
  const originalServeUrl = process.env.AGENTUSE_SERVE_URL;
  const originalApiKey = process.env.AGENTUSE_API_KEY;

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    else process.env.AGENTUSE_RESUME_PUBLIC_URL = originalPublicUrl;
    if (originalServeUrl === undefined) delete process.env.AGENTUSE_SERVE_URL;
    else process.env.AGENTUSE_SERVE_URL = originalServeUrl;
    if (originalApiKey === undefined) delete process.env.AGENTUSE_API_KEY;
    else process.env.AGENTUSE_API_KEY = originalApiKey;
    unregisterServer();
  });

  it('points the reviewer link at the unified session page (no token when local/no api key)', () => {
    process.env.AGENTUSE_RESUME_PUBLIC_URL = 'https://agentuse.example.com/';
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;

    expect(getApprovalUrl('session-1', 'resume-token', 'project-1')).toBe(
      'https://agentuse.example.com/sessions/session-1'
    );
  });

  it('carries the session token (HMAC of api key) when an api key is set', () => {
    process.env.AGENTUSE_RESUME_PUBLIC_URL = 'https://agentuse.example.com/';
    delete process.env.AGENTUSE_SERVE_URL;
    process.env.AGENTUSE_API_KEY = 'super-secret-key';

    const token = sessionViewToken('session-1', 'super-secret-key');
    expect(token.length).toBeGreaterThan(0);
    expect(getApprovalUrl('session-1', 'resume-token', 'project-1')).toBe(
      `https://agentuse.example.com/sessions/session-1?token=${token}`
    );
  });

  it('falls back to the local serve URL', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;

    expect(getApprovalUrl('session-1', 'resume-token')).toBe(
      'http://127.0.0.1:12233/sessions/session-1'
    );
  });

  it('uses the registered serve public URL for the project when no explicit env URL is set', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;
    registerServer({
      port: 12234,
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1:12234',
      projectRoot: '/tmp/project-a',
      startTime: Date.now(),
      agentCount: 1,
      scheduleCount: 0,
      version: 'test',
      projects: [{ id: 'project-a', root: '/tmp/project-a', agentCount: 1, scheduleCount: 0 }]
    });

    expect(getApprovalUrl('session-1', 'resume-token', 'project-a', '/tmp/project-a')).toBe(
      'http://127.0.0.1:12234/sessions/session-1'
    );
  });

  it('keeps multi-project session URLs clean and project-free', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
    delete process.env.AGENTUSE_API_KEY;
    registerServer({
      port: 12235,
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1:12235',
      projectRoot: '/tmp/angle-content-system',
      startTime: Date.now(),
      agentCount: 2,
      scheduleCount: 0,
      version: 'test',
      projects: [
        { id: 'angle-content-system', root: '/tmp/angle-content-system', agentCount: 1, scheduleCount: 0 },
        { id: 'consulting-ops', root: '/tmp/consulting-ops', agentCount: 1, scheduleCount: 0 }
      ]
    });

    expect(getApprovalUrl('session-1', 'resume-token', undefined, '/tmp/consulting-ops')).toBe(
      'http://127.0.0.1:12235/sessions/session-1'
    );
  });

  it('does not set an approval expiration by default', async () => {
    delete process.env.AGENTUSE_API_KEY;
    const tool = createAwaitHumanTool('session-1', { projectRoot: '/tmp/project-a' });

    try {
      await tool.execute?.({ prompt: 'Approve this?' } as any, {} as any);
      throw new Error('expected suspend signal');
    } catch (err) {
      expect(isSuspendSignal(err)).toBe(true);
      if (!isSuspendSignal(err)) return;
      expect(err.payload.expiresAt).toBeUndefined();
      expect(err.payload.approvalUrl).toContain('/sessions/session-1');
      expect(err.payload.channelMessage).toBeUndefined();
    }
  });

  it('sets an approval expiration only when timeout is configured', async () => {
    const now = Date.now();
    const tool = createAwaitHumanTool('session-1', {
      projectRoot: '/tmp/project-a',
      timeout: '24h'
    });

    try {
      await tool.execute?.({ prompt: 'Approve this?' } as any, {} as any);
      throw new Error('expected suspend signal');
    } catch (err) {
      expect(isSuspendSignal(err)).toBe(true);
      if (!isSuspendSignal(err)) return;
      expect(err.payload.expiresAt).toBeGreaterThanOrEqual(now + 24 * 60 * 60 * 1000 - 1000);
      expect(err.payload.expiresAt).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000 + 1000);
    }
  });
});
