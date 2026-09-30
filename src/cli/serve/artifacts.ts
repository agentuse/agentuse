/**
 * Serving a session's artifact files to the browser.
 *
 * Range-served audio/video, CSP-locked HTML and SVG, rendered Markdown, and the
 * raw passthrough for everything else. Moved verbatim out of serve.ts.
 */
import { findGateSnapshotFile } from "../../session/gate-artifacts.js";
import { getSessionStorageDir } from "../../storage/index.js";
import { isPathInside } from "../../utils/path-policy";
import { sendHTML } from "./http";
import { approvalListThemeStyles, escapeHtml, renderMarkdownArtifact } from "./ui";
import { createReadStream, realpathSync } from "fs";
import { readFile, stat } from "fs/promises";
import { ServerResponse } from "http";
import { basename, extname, relative, resolve } from "path";

export const ARTIFACT_RAW_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
};

/** Audio/video artifacts: streamed with Range support (native <video>/<audio>
 *  scrubbing) instead of buffered whole, and exempt from the 10MB preview cap. */
export const ARTIFACT_AV_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
};

export const MAX_AV_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** Stream an audio/video artifact, honoring a single-range Range header. */
export function serveAvArtifact(res: ServerResponse, resolved: string, mime: string, size: number, rangeHeader?: string): void {
  const base: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Accept-Ranges': 'bytes',
  };
  const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    createReadStream(resolved, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': String(size) });
  createReadStream(resolved).pipe(res);
}

/**
 * CSP for script-capable artifacts shown in the (allow-scripts, opaque-origin)
 * preview iframe. Inline script/style is permitted so self-contained dashboards
 * and charts render, but `connect-src 'none'` cuts every network egress path
 * (fetch/XHR/WebSocket/beacon), so a malicious artifact cannot exfiltrate data
 * or pull in remote code. No external script/style hosts: artifacts must inline
 * their own libraries. `base-uri`/`form-action 'none'` block relative-URL and
 * form-submission hijacks.
 */
export const ARTIFACT_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; " +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * CSP for SVG artifacts. SVG can carry inline <script>, and the preview iframe
 * now allows scripts, so block script execution entirely here (default-src
 * 'none' with no script-src) while still letting static SVG with inline styles
 * and embedded data: images render.
 */
export const ARTIFACT_SVG_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'";

/**
 * Wrap rendered artifact body (markdown/text/json) in a standalone themed HTML
 * document so it looks right inside the popup iframe. The iframe is sandboxed
 * with scripts disabled, so it cannot detect the theme client-side: the parent
 * page passes its resolved theme via `?theme=`, which we bake into `data-theme`
 * here. When no theme is supplied (e.g. opened directly), default to dark and
 * let the progressive-enhancement script follow prefers-color-scheme in a real
 * (non-sandboxed) tab.
 */
export function renderArtifactDocument(title: string, bodyHtml: string, theme?: string): string {
  const resolved = theme === 'light' || theme === 'dark' ? theme : null;
  const themeScript = resolved
    ? ''
    : `<script>(function(){try{var m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches;document.documentElement.setAttribute('data-theme',m?'light':'dark');}catch(e){}})();</script>`;
  return `<!doctype html><html data-theme="${resolved ?? 'dark'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP}">
<title>${escapeHtml(title)}</title>
<style>
${approvalListThemeStyles()}
html[data-theme] { background: var(--bg); color: var(--fg); }
body { margin: 0; padding: 20px; font-family: var(--sans); color: var(--fg); background: var(--bg); }
.content-markdown { padding: 0; color: var(--fg); font-size: 15px; line-height: 1.6; }
.content-markdown h1, .content-markdown h2, .content-markdown h3, .content-markdown h4 { color: var(--fg); }
.content-markdown code { font-family: var(--mono); background: var(--panel-hover); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
.content-markdown pre.content-code { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; }
.content-markdown pre.content-code code { background: transparent; border: 0; padding: 0; }
.content-code .json-key { color: var(--cyan); }
.content-code .json-string { color: var(--green); }
.content-code .json-number { color: var(--amber); }
.content-code .json-literal { color: var(--amber); }
.content-frontmatter { border-collapse: collapse; margin: 0 0 24px; width: 100%; font-size: 13px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.content-frontmatter th { text-align: left; vertical-align: top; padding: 7px 12px; color: var(--muted); font-weight: 600; white-space: nowrap; width: 1%; }
.content-frontmatter td { padding: 7px 12px; color: var(--fg); overflow-wrap: anywhere; }
.content-frontmatter tr + tr th, .content-frontmatter tr + tr td { border-top: 1px solid var(--line); }
.content-frontmatter td code { font-family: var(--mono); }
.fm-chip { display: inline-block; background: var(--panel-hover); border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px; margin: 1px 2px; font-size: 12px; }
.fm-empty { color: var(--muted); }
pre.artifact-raw { font-family: var(--mono); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
img { max-width: 100%; height: auto; }
</style>
${themeScript}
</head><body>${bodyHtml}</body></html>`;
}

export async function serveResolvedArtifactFile(res: ServerResponse, resolved: string, theme?: string, rangeHeader?: string): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    fileStat = null;
  }
  if (!fileStat || !fileStat.isFile()) {
    sendHTML(res, 404, '<!doctype html><title>Artifact</title><p>Artifact not found.</p>');
    return;
  }
  const avMime = ARTIFACT_AV_MIME[extname(resolved).toLowerCase()];
  if (avMime) {
    if (fileStat.size > MAX_AV_ARTIFACT_BYTES) {
      sendHTML(res, 413, '<!doctype html><title>Artifact</title><p>Media artifact is too large to stream (over 512 MB).</p>');
      return;
    }
    serveAvArtifact(res, resolved, avMime, fileStat.size, rangeHeader);
    return;
  }
  const MAX_BYTES = 10 * 1024 * 1024;
  if (fileStat.size > MAX_BYTES) {
    sendHTML(res, 413, '<!doctype html><title>Artifact</title><p>Artifact is too large to preview (over 10 MB).</p>');
    return;
  }

  const ext = extname(resolved).toLowerCase();
  const title = basename(resolved);
  const content = await readFile(resolved);
  const rawMime = ARTIFACT_RAW_MIME[ext];
  if (rawMime) {
    const headers: Record<string, string> = {
      'Content-Type': rawMime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    // The in-page preview iframe sandboxes the artifact (allow-scripts, no
    // same-origin), but the "open in tab" link loads this same URL as a
    // top-level document where the iframe sandbox no longer applies. Deliver the
    // `sandbox` directive as an HTTP-header CSP (it is ignored via <meta>) so a
    // directly-opened HTML artifact still gets an opaque origin and cannot reach
    // the serve app's same-origin cookies/storage.
    //
    // Cross-origin framing of the token-bearing URL is blocked with CSP
    // frame-ancestors, NOT X-Frame-Options: the `sandbox` directive gives the
    // response an opaque origin, so XFO SAMEORIGIN can never match and would
    // block the session page's own preview iframe too. frame-ancestors compares
    // the ancestor's URL origin against this resource's URL origin instead.
    if (rawMime.startsWith('text/html')) {
      headers['Content-Security-Policy'] = `${ARTIFACT_HTML_CSP}; frame-ancestors 'self'; sandbox allow-scripts`;
    } else if (rawMime === 'image/svg+xml') {
      headers['Content-Security-Policy'] = `${ARTIFACT_SVG_CSP}; frame-ancestors 'self'`;
    } else {
      headers['X-Frame-Options'] = 'SAMEORIGIN';
    }
    res.writeHead(200, headers);
    res.end(content);
    return;
  }
  // Anything that isn't a raw-streamed type previews as text when the bytes
  // actually are text (sniffed, not extension-guessed), so new text formats
  // work without being enumerated here. The sniff only ever routes into the
  // escaped/rendered HTML documents, never the script-capable raw branches
  // above, so it cannot widen the CSP-sandboxed surface.
  const text = decodeArtifactText(content);
  if (text !== null) {
    const isMarkdown = ext === '.md' || ext === '.markdown' || ext === '.agentuse';
    const body = isMarkdown
      ? renderMarkdownArtifact(text)
      : `<pre class="artifact-raw">${escapeHtml(text)}</pre>`;
    sendHTML(res, 200, renderArtifactDocument(title, body, theme));
    return;
  }
  // Binary content: hand it to the browser as a download rather than guess.
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${title.replace(/["\\]/g, '')}"`
  });
  res.end(content);
}

/**
 * Decode artifact bytes as text for preview, or return null for binary
 * content. Uses the git-style heuristic (a NUL byte in the leading window
 * means binary) plus a strict UTF-8 decode so mojibake never renders.
 */
export function decodeArtifactText(content: Buffer): string | null {
  if (content.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

type ArtifactLogEntry = {
  details?: {
    artifactPaths?: string[];
    artifactSnapshots?: Array<{ path: string }>;
    savedArtifact?: { path: string };
  } | undefined;
};

/**
 * Every project file a session showed its reviewer: gate artifact paths and
 * snapshots, deliverables saved through `tools__artifact_save`, and manifest
 * entries recorded under the session. Resolved against the project root the
 * same way serveSessionArtifact resolves a request, so the two compare as-is.
 */
export function sessionDeclaredArtifactPaths(
  projectRoot: string,
  logs: readonly ArtifactLogEntry[],
  manifestNames: readonly string[],
): Set<string> {
  const paths = [...manifestNames];
  for (const entry of logs) {
    const details = entry.details;
    if (!details) continue;
    paths.push(...(details.artifactPaths ?? []));
    paths.push(...(details.artifactSnapshots ?? []).map((snapshot) => snapshot.path));
    if (details.savedArtifact?.path) paths.push(details.savedArtifact.path);
  }
  return new Set(paths.map((path) => resolve(projectRoot, path)));
}

/**
 * Resolve, authorize, and serve a local file artifact referenced by an
 * `await_human` gate. The path is interpreted relative to the project root and
 * must resolve inside it (no traversal), and a small denylist keeps secrets and
 * internal session state out of reach even if a prompt coaxed the agent into
 * pointing the gate at them. html/images/pdf are streamed raw for the iframe to
 * display; anything whose bytes sniff as UTF-8 text renders as a themed doc
 * (markdown-family extensions get the markdown renderer); binaries download.
 */
export async function serveSessionArtifact(
  res: ServerResponse,
  projectRoot: string,
  rawPath: string,
  theme?: string,
  opts?: {
    sessionId?: string | undefined;
    snapHash?: string | undefined;
    rangeHeader?: string | undefined;
    /**
     * Absolute paths this session put in front of its reviewer (see
     * sessionDeclaredArtifactPaths). When set, any other project file is
     * refused: a session link is not a read handle on the whole project.
     * Operators (API key, or a keyless local daemon) pass none.
     */
    declaredPaths?: ReadonlySet<string> | undefined;
  }
): Promise<void> {
  // A gate-time snapshot takes priority over the live workspace path: the
  // reviewer must see the exact bytes the approval covers. Snapshot files are
  // hash-named inside the session's own storage, so no traversal or denylist
  // concerns apply. A declared snapshot that is missing fails closed; only
  // legacy gates with no snapshot hash may use the live-path compatibility path.
  if (opts?.snapHash && opts.sessionId) {
    const snapshotFile = await findGateSnapshotFile(projectRoot, opts.sessionId, opts.snapHash);
    if (snapshotFile) {
      await serveResolvedArtifactFile(res, snapshotFile, theme, opts.rangeHeader);
      return;
    }
    sendHTML(
      res,
      410,
      '<!doctype html><title>Artifact unavailable</title><p>The immutable approval snapshot is unavailable. The live workspace file was not substituted.</p>'
    );
    return;
  }
  const decoded = (() => { try { return decodeURIComponent(rawPath); } catch { return rawPath; } })();
  const resolved = resolve(projectRoot, decoded);
  if (opts?.declaredPaths && !opts.declaredPaths.has(resolved)) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This file is not part of this session.</p>');
    return;
  }
  // Lexical containment first. Then, when the target exists, resolve symlinks on
  // both sides and re-check so a link inside the project cannot point the served
  // file at a target outside it. A non-existent path has no realpath to resolve
  // and falls through to the 404 below.
  const realRoot = (() => { try { return realpathSync(projectRoot); } catch { return projectRoot; } })();
  const realResolved = (() => { try { return realpathSync(resolved); } catch { return null; } })();
  if (!isPathInside(projectRoot, resolved) || (realResolved && !isPathInside(realRoot, realResolved))) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This artifact path is outside the project.</p>');
    return;
  }
  // Apply the secret/internal-state denylist to the canonical target too. A
  // lexical in-project alias must not make .env, .git, or .agentuse state
  // reviewable through a symlink.
  const policyRoot = realResolved ? realRoot : projectRoot;
  const policyPath = realResolved ?? resolved;
  const rel = relative(policyRoot, policyPath);
  const segments = rel.split(/[\\/]+/);
  const blockedRoots = new Set(['.git', 'node_modules']);
  const isBlocked = segments.some((seg) => seg.startsWith('.env'))
    || blockedRoots.has(segments[0])
    || (segments[0] === '.agentuse' && (segments[1] === 'store' || segments[1] === 'sessions' || segments[1] === 'env'));
  if (isBlocked) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This artifact path is not viewable.</p>');
    return;
  }
  await serveResolvedArtifactFile(res, resolved, theme, opts?.rangeHeader);
}

export async function serveSessionToolOutputArtifact(
  res: ServerResponse,
  projectRoot: string,
  sessionId: string,
  rawPath: string,
  theme?: string
): Promise<void> {
  const decoded = (() => { try { return decodeURIComponent(rawPath); } catch { return rawPath; } })();
  const storageRoot = await getSessionStorageDir(projectRoot);
  const resolved = resolve(storageRoot, decoded);
  const realRoot = (() => { try { return realpathSync(storageRoot); } catch { return storageRoot; } })();
  const realResolved = (() => { try { return realpathSync(resolved); } catch { return null; } })();

  if (!isPathInside(storageRoot, resolved) || (realResolved && !isPathInside(realRoot, realResolved))) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This tool output path is outside session storage.</p>');
    return;
  }

  const rel = relative(storageRoot, resolved);
  const segments = rel.split(/[\\/]+/);
  const sessionSegment = segments.find((segment) => segment.startsWith(`${sessionId}-`));
  const artifactIndex = segments.lastIndexOf('artifact');
  const fileName = segments[segments.length - 1] ?? '';
  if (!sessionSegment || artifactIndex < 0 || !fileName.startsWith('tool-output-')) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This tool output path is not viewable for this session.</p>');
    return;
  }

  await serveResolvedArtifactFile(res, resolved, theme);
}
