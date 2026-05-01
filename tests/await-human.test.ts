import { afterEach, describe, expect, it } from 'bun:test';
import { getApprovalUrl } from '../src/tools/await-human';
import { registerServer, unregisterServer } from '../src/utils/server-registry';

describe('await_human approval URL', () => {
  const originalPublicUrl = process.env.AGENTUSE_RESUME_PUBLIC_URL;
  const originalServeUrl = process.env.AGENTUSE_SERVE_URL;

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    else process.env.AGENTUSE_RESUME_PUBLIC_URL = originalPublicUrl;
    if (originalServeUrl === undefined) delete process.env.AGENTUSE_SERVE_URL;
    else process.env.AGENTUSE_SERVE_URL = originalServeUrl;
    unregisterServer();
  });

  it('builds a token-protected approval page URL with project routing', () => {
    process.env.AGENTUSE_RESUME_PUBLIC_URL = 'https://agentuse.example.com/';
    delete process.env.AGENTUSE_SERVE_URL;

    expect(getApprovalUrl('session-1', 'resume-token', 'project-1')).toBe(
      'https://agentuse.example.com/approvals/session-1?token=resume-token&project=project-1'
    );
  });

  it('falls back to the local serve URL', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;

    expect(getApprovalUrl('session-1', 'resume-token')).toBe(
      'http://127.0.0.1:12233/approvals/session-1?token=resume-token'
    );
  });

  it('uses the registered serve public URL for the project when no explicit env URL is set', () => {
    delete process.env.AGENTUSE_RESUME_PUBLIC_URL;
    delete process.env.AGENTUSE_SERVE_URL;
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
      'http://127.0.0.1:12234/approvals/session-1?token=resume-token&project=project-a'
    );
  });
});
