import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebAssets, renderWebAssetsMissingPage } from '../src/cli/serve/static';

function writeWebFixture(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'main-abc123.js'), 'console.log("entry");');
  fs.writeFileSync(path.join(rootDir, 'main-def456.css'), 'body { margin: 0; }');
  fs.writeFileSync(path.join(rootDir, 'chunks', 'route-xyz789.js'), 'export {};');
  fs.writeFileSync(path.join(rootDir, 'manifest.json'), JSON.stringify({
    entry: 'main-abc123.js',
    css: ['main-def456.css'],
    files: ['main-abc123.js', 'main-def456.css', 'chunks/route-xyz789.js'],
  }));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('WebAssets static serving', () => {
  let webDir: string;
  let server: Server;
  let port: number;
  let assets: WebAssets;

  beforeAll(async () => {
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-web-assets-'));
    writeWebFixture(webDir);
    assets = new WebAssets(webDir);
    // Mirror how serve.ts mounts asset serving: try serveAsset first, else 404.
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (assets.serveAsset(req, res, pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    port = await listen(server);
  });

  afterAll(() => {
    server?.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  it('serves hashed assets with immutable cache headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/main-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toContain('entry');
  });

  it('answers HEAD requests for assets without a body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/main-abc123.js`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('');
  });

  it('serves chunk and css assets with correct content types', async () => {
    const chunk = await fetch(`http://127.0.0.1:${port}/assets/chunks/route-xyz789.js`);
    expect(chunk.status).toBe(200);
    const css = await fetch(`http://127.0.0.1:${port}/assets/main-def456.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('blocks path traversal outside the web root', async () => {
    fs.writeFileSync(path.join(webDir, '..', 'serve-web-secret.txt'), 'secret');
    const res = await fetch(`http://127.0.0.1:${port}/assets/..%2Fserve-web-secret.txt`);
    expect(res.status).toBe(404);
    fs.rmSync(path.join(webDir, '..', 'serve-web-secret.txt'), { force: true });
  });

  it('404s unknown assets and non-asset paths', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/assets/nope.js`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/sessions`)).status).toBe(404);
  });

  it('renders the SPA shell from the manifest', () => {
    const shell = assets.renderShell();
    expect(shell).toContain('<div id="app"></div>');
    expect(shell).toContain('/assets/main-abc123.js');
    expect(shell).toContain('<link rel="stylesheet" href="/assets/main-def456.css">');
    expect(shell).toContain('modulepreload');
    expect(shell).toContain('agentuse-theme');
    expect(shell).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });

  it('re-reads the manifest when it changes on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-web-reload-'));
    try {
      writeWebFixture(dir);
      const reloadAssets = new WebAssets(dir);
      expect(reloadAssets.manifest()?.entry).toBe('main-abc123.js');

      await new Promise((r) => setTimeout(r, 1100));
      const manifestPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ entry: 'main-new111.js', css: [], files: ['main-new111.js'] }));
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(manifestPath, future, future);

      expect(reloadAssets.manifest()?.entry).toBe('main-new111.js');
      expect(reloadAssets.renderShell()).toContain('main-new111.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing builds without crashing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-web-empty-'));
    try {
      const missing = new WebAssets(empty);
      expect(missing.manifest()).toBeNull();
      expect(missing.renderShell()).toBeNull();
      expect(renderWebAssetsMissingPage()).toContain('build:web');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
