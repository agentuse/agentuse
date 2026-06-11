import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { join, resolve, extname, dirname } from "path";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { approvalThemeBootScript, escapeHtml } from "./ui";

export interface WebManifest {
  entry: string;
  css: string[];
  files: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const MANIFEST_RECHECK_MS = 1000;

function isPathInside(parent: string, child: string): boolean {
  const rel = child.startsWith(parent) ? child.slice(parent.length) : null;
  return rel !== null && (rel === "" || rel.startsWith("/") || rel.startsWith("\\"));
}

/**
 * Locates and serves the built Web UI (dist/web). Resolution is relative to
 * the running module so it works both bundled (dist/index.js -> dist/web)
 * and from source (src/cli/serve -> <repo>/dist/web). The manifest is
 * re-read when its mtime changes so `build:web --watch` works against a
 * running server without a restart.
 */
export class WebAssets {
  private root: string | null = null;
  private manifestCache: WebManifest | null = null;
  private manifestMtimeMs = 0;
  private lastCheck = 0;
  private shellCache: { html: string; entry: string } | null = null;

  constructor(rootOverride?: string) {
    this.root = rootOverride ?? WebAssets.resolveRoot();
  }

  private static resolveRoot(): string | null {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      // Bundled: dist/<chunk>.js -> dist/web
      join(moduleDir, "web"),
      // From source: src/cli/serve -> <repo>/dist/web
      join(moduleDir, "..", "..", "..", "dist", "web"),
      // From source one level up (src/cli/serve.ts compiled location)
      join(moduleDir, "..", "..", "dist", "web"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "manifest.json"))) {
        return resolve(candidate);
      }
    }
    return null;
  }

  manifest(): WebManifest | null {
    if (!this.root) return null;
    const now = Date.now();
    if (this.manifestCache && now - this.lastCheck < MANIFEST_RECHECK_MS) {
      return this.manifestCache;
    }
    this.lastCheck = now;
    try {
      const manifestPath = join(this.root, "manifest.json");
      const stat = statSync(manifestPath);
      if (!this.manifestCache || stat.mtimeMs !== this.manifestMtimeMs) {
        this.manifestCache = JSON.parse(readFileSync(manifestPath, "utf-8")) as WebManifest;
        this.manifestMtimeMs = stat.mtimeMs;
      }
      return this.manifestCache;
    } catch {
      this.manifestCache = null;
      return null;
    }
  }

  /**
   * Serves /assets/<path> from the web build output. Returns false when the
   * request is not an asset request; sends the response (200 or 404) when it is.
   */
  serveAsset(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if ((req.method !== "GET" && req.method !== "HEAD") || !pathname.startsWith("/assets/")) return false;

    const relPath = decodeURIComponent(pathname.slice("/assets/".length));
    if (!this.root || !relPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return true;
    }

    const filePath = resolve(this.root, relPath);
    if (!isPathInside(this.root, filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return true;
    }

    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      // Filenames are content-hashed, so they are immutable by construction.
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  }

  /** The SPA HTML shell. Tiny and served no-store; all weight lives in hashed assets. */
  renderShell(): string | null {
    const manifest = this.manifest();
    if (!manifest) return null;
    if (this.shellCache && this.shellCache.entry === manifest.entry) {
      return this.shellCache.html;
    }
    const cssLinks = manifest.css
      .map((href) => `<link rel="stylesheet" href="/assets/${escapeHtml(href)}">`)
      .join("\n  ");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>AgentUse</title>
  <link rel="icon" href="data:,">
  <script>${approvalThemeBootScript()}</script>
  ${cssLinks}
  <link rel="modulepreload" href="/assets/${escapeHtml(manifest.entry)}">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/${escapeHtml(manifest.entry)}"></script>
</body>
</html>`;
    this.shellCache = { html, entry: manifest.entry };
    return html;
  }
}

export function renderWebAssetsMissingPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AgentUse</title></head>
<body style="font-family: ui-monospace, monospace; padding: 40px;">
<h1>Web UI not built</h1>
<p>The serve Web UI assets were not found. Run <code>pnpm build:web</code> (or <code>pnpm build</code>) and reload.</p>
</body>
</html>`;
}
