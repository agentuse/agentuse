import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { __testing } from '../src/cli/serve';

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
  it('renders a markdown artifact as a themed HTML document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/report.md'), '# Hello\n\n- one\n- two\n');
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/report.md');
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Type']).toContain('text/html');
      expect(captured.body).toContain('content-markdown');
      expect(captured.body).toContain('<h2>Hello</h2>');
      expect(captured.body).toContain('<li>one</li>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders YAML frontmatter as a metadata table above the body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(
        join(root, '.agentuse/artifacts/report.md'),
        '---\ntitle: Weekly Report\ntags:\n  - ops\n  - finance\n---\n\n# Body\n\nHello world.\n',
      );
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/report.md');
      expect(captured.status).toBe(200);
      // Frontmatter becomes a table, not raw `---` paragraphs.
      expect(captured.body).toContain('class="content-frontmatter"');
      expect(captured.body).toContain('<th>title</th>');
      expect(captured.body).toContain('Weekly Report');
      expect(captured.body).toContain('class="fm-chip"');
      expect(captured.body).toContain('ops');
      // The body still renders normally and the delimiters are gone from prose.
      expect(captured.body).toContain('<h2>Body</h2>');
      expect(captured.body).not.toContain('<p>---</p>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders markdown without frontmatter unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/plain.md'), '# Hello\n\nNo frontmatter here.\n');
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/plain.md');
      expect(captured.status).toBe(200);
      // The CSS class is defined in <style>, but no table element is emitted.
      expect(captured.body).not.toContain('<table class="content-frontmatter">');
      expect(captured.body).toContain('<h2>Hello</h2>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bakes the passed theme into data-theme and drops the detection script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/report.md'), '# Hi\n');

      const light = fakeResponse();
      await __testing.serveSessionArtifact(light.res, root, '.agentuse/artifacts/report.md', 'light');
      expect(light.captured.body).toContain('<html data-theme="light">');
      expect(light.captured.body).not.toContain('prefers-color-scheme');

      // No/invalid theme falls back to dark with the progressive-enhancement script.
      const none = fakeResponse();
      await __testing.serveSessionArtifact(none.res, root, '.agentuse/artifacts/report.md');
      expect(none.captured.body).toContain('<html data-theme="dark">');
      expect(none.captured.body).toContain('prefers-color-scheme');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves an html artifact raw for the iframe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/page.html'), '<!doctype html><h1>Hi</h1>');
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/page.html');
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Type']).toContain('text/html');
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(captured.body).toBe('<!doctype html><h1>Hi</h1>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends a network-blocking CSP with html artifacts and a CSP meta in rendered docs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(join(root, '.agentuse/artifacts/page.html'), '<!doctype html><h1>Hi</h1>');
      writeFileSync(join(root, '.agentuse/artifacts/doc.md'), '# Hi\n');

      const html = fakeResponse();
      await __testing.serveSessionArtifact(html.res, root, '.agentuse/artifacts/page.html');
      // Inline scripts run, but no network egress and no remote code.
      expect(html.captured.headers['Content-Security-Policy']).toContain("connect-src 'none'");
      expect(html.captured.headers['Content-Security-Policy']).toContain("script-src 'unsafe-inline'");

      // Generated markdown docs carry the same policy via a meta tag.
      const md = fakeResponse();
      await __testing.serveSessionArtifact(md.res, root, '.agentuse/artifacts/doc.md');
      expect(md.captured.body).toContain('http-equiv="Content-Security-Policy"');
      expect(md.captured.body).toContain("connect-src 'none'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks script execution in svg artifacts via CSP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      mkdirSync(join(root, '.agentuse/artifacts'), { recursive: true });
      writeFileSync(
        join(root, '.agentuse/artifacts/chart.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil")</script></svg>',
      );
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/chart.svg');
      expect(captured.headers['Content-Type']).toContain('image/svg+xml');
      // default-src 'none' with no script-src => scripts in the SVG never run.
      expect(captured.headers['Content-Security-Policy']).toContain("default-src 'none'");
      expect(captured.headers['Content-Security-Policy']).not.toContain("script-src 'unsafe-inline'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses path traversal outside the project root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '../../../../etc/passwd');
      expect(captured.status).toBe(403);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to serve dotenv and internal session state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      writeFileSync(join(root, '.env'), 'SECRET=shh');
      mkdirSync(join(root, '.agentuse/store'), { recursive: true });
      writeFileSync(join(root, '.agentuse/store/data.json'), '{"k":"v"}');

      const env = fakeResponse();
      await __testing.serveSessionArtifact(env.res, root, '.env');
      expect(env.captured.status).toBe(403);

      const store = fakeResponse();
      await __testing.serveSessionArtifact(store.res, root, '.agentuse/store/data.json');
      expect(store.captured.status).toBe(403);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('404s when the artifact file is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-artifact-'));
    try {
      const { res, captured } = fakeResponse();
      await __testing.serveSessionArtifact(res, root, '.agentuse/artifacts/nope.md');
      expect(captured.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
