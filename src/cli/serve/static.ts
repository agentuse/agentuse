import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { join, resolve, extname, dirname } from "path";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { approvalThemeBootScript, escapeHtml } from "./ui";

export interface WebManifest {
  entry: string;
  css: string[];
  /** Chunks the entry statically imports; modulepreloaded by the shell. */
  preload?: string[];
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
  private shellCache: { html: string; key: string } | null = null;
  /** Configured deployment brand (serve.brand.name); undefined = plain AgentUse. */
  private readonly brandName: string | undefined;
  /** Configured display nouns (serve.terms); undefined = technical terms. */
  private readonly terms: Record<string, string> | undefined;

  constructor(rootOverride?: string, brandName?: string, terms?: Record<string, string>) {
    this.root = rootOverride ?? WebAssets.resolveRoot();
    this.brandName = brandName?.trim() || undefined;
    this.terms = terms && Object.keys(terms).length > 0 ? terms : undefined;
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

    let relPath: string;
    try {
      relPath = decodeURIComponent(pathname.slice("/assets/".length));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request");
      return true;
    }
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

    // Serve a precompressed sibling (.br/.gz) the build emitted when the client
    // accepts it. Filenames are content-hashed and immutable, so there is no
    // per-request compression cost — we just stream the smaller file.
    const ext = extname(filePath);
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      Vary: "Accept-Encoding",
    };
    let servePath = filePath;
    if (ext === ".js" || ext === ".css") {
      const accept = String(req.headers["accept-encoding"] ?? "");
      if (/\bbr\b/.test(accept) && existsSync(`${filePath}.br`)) {
        servePath = `${filePath}.br`;
        headers["Content-Encoding"] = "br";
      } else if (/\bgzip\b/.test(accept) && existsSync(`${filePath}.gz`)) {
        servePath = `${filePath}.gz`;
        headers["Content-Encoding"] = "gzip";
      }
    }
    headers["Content-Length"] = String(statSync(servePath).size);

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(servePath).pipe(res);
    return true;
  }

  /** The SPA HTML shell. Tiny and served no-store; all weight lives in hashed assets. */
  renderShell(): string | null {
    const manifest = this.manifest();
    if (!manifest) return null;
    // Key the cache on the entry AND the css hrefs: a CSS-only rebuild changes the
    // stylesheet hash but not the JS entry, and keying on entry alone would keep
    // serving the stale CSS link until the entry happened to change.
    const preload = manifest.preload ?? [];
    const fonts = manifest.files.filter((file) => file.endsWith(".woff2"));
    const key = `${manifest.entry}|${manifest.css.join(",")}|${preload.join(",")}|${fonts.join(",")}`;
    if (this.shellCache && this.shellCache.key === key) {
      return this.shellCache.html;
    }
    const cssLinks = manifest.css
      .map((href) => `<link rel="stylesheet" href="/assets/${escapeHtml(href)}">`)
      .join("\n  ");
    // Fonts are referenced only from inside the stylesheet, so without this the
    // browser can't even discover them until the CSS has downloaded and parsed:
    // an extra round trip on the critical path and a visible flash of fallback
    // text. Hashed filenames make them immutable, so preloading is never wasted.
    const fontLinks = fonts
      .map((href) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${escapeHtml(href)}">`)
      .join("\n  ");
    // Preload the entry's static-import chunks (shared framework/vendor code)
    // so they download alongside the entry rather than after it parses.
    const preloadLinks = preload
      .map((href) => `<link rel="modulepreload" href="/assets/${escapeHtml(href)}">`)
      .join("\n  ");
    // Configured deployment brand and display nouns, injected for the client
    // bundle (web/lib/brand.ts, web/lib/terms.ts) so the very first render
    // already knows them: no fetch, no title flash. Both are static per
    // server process, so the cached shell stays valid. JSON-escaping `<`
    // keeps the values from ever closing the script tag.
    const injectJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
    const brand = this.brandName;
    const globals: string[] = [];
    if (brand) globals.push(`window.__AGENTUSE_BRAND__ = ${injectJson({ name: brand })};`);
    if (this.terms) globals.push(`window.__AGENTUSE_TERMS__ = ${injectJson(this.terms)};`);
    const brandTag = globals.length > 0 ? `\n  <script>${globals.join(" ")}</script>` : "";
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>
    // iOS Safari auto-zooms the viewport when a focused field's font-size is
    // under 16px. Since iOS 10, Safari ignores maximum-scale for user pinch
    // zoom (accessibility) but still honors it for that focus auto-zoom, so
    // capping it here lets fields use design-sized text. iOS-only: Android
    // Chrome would genuinely lose pinch zoom under maximum-scale=1.
    if (/iP(hone|ad|od)/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
      document.querySelector('meta[name="viewport"]')
        .setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1");
    }
  </script>
  <meta name="color-scheme" content="dark light">
  <title>${escapeHtml(brand ? `${brand} · AgentUse` : "AgentUse")}</title>
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafaf9">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="${escapeHtml(brand ?? "AgentUse")}">${brandTag}
  <script>${approvalThemeBootScript()}</script>
  <style>
    /* Boot loader: visible from first paint until the first route commits
       (app.tsx removes #boot). Inline and theme-neutral because it must render
       before the app bundle — and possibly before app.css — arrives. The fade
       is delayed so fast loads never flash it. */
    #boot { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; opacity: 0; animation: boot-in 300ms ease 250ms forwards; }
    #boot .boot-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(128, 128, 128, 0.3); border-top-color: rgba(128, 128, 128, 0.9); animation: boot-spin 700ms linear infinite; }
    @keyframes boot-spin { to { transform: rotate(360deg); } }
    @keyframes boot-in { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { #boot .boot-spinner { animation-duration: 1.6s; } }
  </style>
  ${cssLinks}
  ${fontLinks}
  <link rel="modulepreload" href="/assets/${escapeHtml(manifest.entry)}">
  ${preloadLinks}
</head>
<body>
  <div id="boot" aria-hidden="true"><div class="boot-spinner"></div></div>
  <div id="app"></div>
  <script type="module" src="/assets/${escapeHtml(manifest.entry)}"></script>
</body>
</html>`;
    this.shellCache = { html, key };
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
