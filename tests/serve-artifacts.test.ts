import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { __testing } from '../src/cli/serve';

const suspendedApprovalWithArtifact = {
  sessionId: 'session-1',
  sessionStatus: 'suspended',
  model: 'anthropic:claude-sonnet-4-0',
  agent: {
    id: 'agents/review',
    name: 'Review agent',
    filePath: '/tmp/review.agentuse',
  },
  prompt: 'Approve the draft?',
  currentResumeToken: 'gate-token-1',
  decision: undefined,
  logs: [{
    id: 'part-1',
    type: 'tool',
    tool: 'await_human',
    status: 'pending',
    title: 'Pending for approval',
    details: {
      resumeToken: 'gate-token-1',
      prompt: 'Approve the draft?',
      artifactPaths: ['.agentuse/artifacts/report.html'],
    },
  }],
};

const multiArtifactApproval = {
  ...suspendedApprovalWithArtifact,
  logs: [{
    ...suspendedApprovalWithArtifact.logs[0],
    details: {
      resumeToken: 'gate-token-1',
      prompt: 'Approve the draft?',
      artifactPaths: ['.agentuse/artifacts/a.html', '.agentuse/artifacts/b.md'],
    },
  }],
};

describe('artifact popup rendering', () => {
  it('renders an artifact tile and the popup modal on the session page', () => {
    const html = __testing.renderSessionPage({
      approval: suspendedApprovalWithArtifact as never,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });
    // The clickable tile carries the artifact URL with the session token.
    expect(html).toContain('class="artifact-open"');
    expect(html).toContain('data-artifact-url="/sessions/session-1/artifacts/.agentuse/artifacts/report.html?token=sess-token"');
    expect(html).toContain('data-artifact-title="report.html"');
    // The popup viewer shell is present, with a sandboxed iframe.
    expect(html).toContain('id="artifact-modal"');
    expect(html).toContain('id="artifact-modal-frame"');
  });

  it('omits the token from the artifact URL on local (no token)', () => {
    const html = __testing.renderSessionPage({
      approval: suspendedApprovalWithArtifact as never,
      token: '',
      projectId: 'project-1',
      canAct: true,
    });
    expect(html).toContain('data-artifact-url="/sessions/session-1/artifacts/.agentuse/artifacts/report.html"');
  });

  it('renders a tile per artifact when multiple are provided', () => {
    const html = __testing.renderSessionPage({
      approval: multiArtifactApproval as never,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });
    expect(html).toContain('>Artifacts<');
    expect(html).toContain('data-artifact-title="a.html"');
    expect(html).toContain('data-artifact-title="b.md"');
    expect(html).toContain('data-artifact-url="/sessions/session-1/artifacts/.agentuse/artifacts/a.html?token=sess-token"');
    expect(html).toContain('data-artifact-url="/sessions/session-1/artifacts/.agentuse/artifacts/b.md?token=sess-token"');
  });
});

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(): { res: never; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) captured.headers = headers;
      return res;
    },
    end(body?: unknown) {
      if (body !== undefined) captured.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    },
  };
  return { res: res as never, captured };
}

describe('serveSessionArtifact', () => {
  it('renders a markdown artifact as a themed HTML document', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/report.md'), '# Hello\n\n- one\n- two\n');
      const { res, captured } = fakeResponse();
      __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/report.md');
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Type']).toContain('text/html');
      expect(captured.body).toContain('content-markdown');
      expect(captured.body).toContain('<h2>Hello</h2>');
      expect(captured.body).toContain('<li>one</li>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves an html artifact raw for the iframe', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/page.html'), '<!doctype html><h1>Hi</h1>');
      const { res, captured } = fakeResponse();
      __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/page.html');
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Type']).toContain('text/html');
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(captured.body).toBe('<!doctype html><h1>Hi</h1>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses path traversal outside the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      const { res, captured } = fakeResponse();
      __testing.serveSessionArtifact(res, root, '../../../../etc/passwd');
      expect(captured.status).toBe(403);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to serve dotenv and internal session state', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      writeFileSync(join(root, '.env'), 'SECRET=shh');
      mkdirSync(join(root, '.agentuse/store'), { recursive: true });
      writeFileSync(join(root, '.agentuse/store/data.json'), '{"k":"v"}');

      const env = fakeResponse();
      __testing.serveSessionArtifact(env.res, root, '.env');
      expect(env.captured.status).toBe(403);

      const store = fakeResponse();
      __testing.serveSessionArtifact(store.res, root, '.agentuse/store/data.json');
      expect(store.captured.status).toBe(403);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('404s when the artifact file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      const { res, captured } = fakeResponse();
      __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/nope.md');
      expect(captured.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
