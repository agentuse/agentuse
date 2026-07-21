/**
 * Gate-time artifact snapshots for `await_human`.
 *
 * The approval Web UI shows files a gate references (explicit artifact_paths
 * plus media paths mentioned in the payload prose). Serving the live workspace
 * path is wrong for review integrity: agents overwrite tmp/ files between gate
 * rounds, so the reviewer can approve bytes that no longer exist by the time
 * the action runs. At gate time we copy each referenced file into the
 * session's own storage (content-addressed, immutable, removed with the
 * session) and the viewer serves the snapshot, falling back to the live path
 * only for gates recorded before this existed.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { getSessionStorageDir } from '../storage/index.js';
import { logger } from '../utils/logger.js';

export interface GateArtifactSnapshot {
  /** Project-root-relative path the gate referenced. */
  path: string;
  /** sha256 (first 16 hex chars) of the snapshotted bytes. */
  hash: string;
  /** Original file extension including the dot, lowercased (drives MIME on serve). */
  ext: string;
  bytes: number;
}

/** Subdirectory of the session dir holding gate snapshots. */
const GATE_MEDIA_DIR = path.join('media', 'gate');

/** Extensions worth snapshotting: everything the approval viewer can preview. */
const SNAPSHOT_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|pdf|html?|mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i;

/** Media path tokens inside gate payload prose (images + audio/video only —
 *  html/pdf mentions in prose are usually links or docs, not review media). */
const PAYLOAD_MEDIA_PATH_RE = /[\w.~@/-]+\.(?:png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v|mp3|m4a|wav)\b/gi;

const AV_EXT_RE = /\.(mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i;
/** Static previews stay within the viewer's 10MB render cap; AV streams, so it
 *  gets a larger allowance. */
const MAX_STATIC_BYTES = 10 * 1024 * 1024;
const MAX_AV_BYTES = 128 * 1024 * 1024;

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Mirror of the serve-side denylist: never snapshot secrets or internal state. */
function isBlockedProjectPath(projectRoot: string, resolved: string): boolean {
  const segments = path.relative(projectRoot, resolved).split(/[\\/]+/);
  const blockedRoots = new Set(['.git', 'node_modules']);
  return segments.some((seg) => seg.startsWith('.env'))
    || blockedRoots.has(segments[0])
    || (segments[0] === '.agentuse' && (segments[1] === 'store' || segments[1] === 'sessions' || segments[1] === 'env'));
}

/** Explicit artifact paths + media paths mentioned in payload prose, deduped. */
export function collectGateArtifactPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const p = raw.trim().replace(/^\.\//, '');
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  push(input.artifact_path);
  if (Array.isArray(input.artifact_paths)) for (const p of input.artifact_paths) push(p);

  const texts: string[] = [];
  for (const key of ['summary', 'draft', 'context', 'risk'] as const) {
    if (typeof input[key] === 'string') texts.push(input[key] as string);
  }
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      const content = (change as Record<string, unknown> | null)?.content;
      if (typeof content === 'string') texts.push(content);
    }
  }
  for (const text of texts) {
    for (const match of text.matchAll(PAYLOAD_MEDIA_PATH_RE)) {
      const raw = match[0];
      // URL host segment, not a local path.
      if (raw.startsWith('//') || (match.index !== undefined && text[match.index - 1] === ':')) continue;
      push(raw);
    }
  }
  return out;
}

/** Resolve the on-disk session dir (`<storage>/session/<id>-<agent>`) by id. */
async function findSessionDir(projectRoot: string, sessionId: string): Promise<string | null> {
  const storageRoot = await getSessionStorageDir(projectRoot);
  let entries;
  try {
    entries = await fs.readdir(storageRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const match = entries.find((e) => e.isDirectory() && e.name.startsWith(`${sessionId}-`));
  return match ? path.join(storageRoot, match.name) : null;
}

/**
 * Snapshot every previewable file the gate references into the session dir.
 * Best-effort by design: a missing/oversized/outside-project file is skipped
 * (the viewer falls back to the live path), and no failure here may ever block
 * the gate itself.
 */
export async function snapshotGateArtifacts(
  projectRoot: string,
  sessionId: string,
  input: Record<string, unknown>
): Promise<GateArtifactSnapshot[]> {
  const candidates = collectGateArtifactPaths(input).filter((p) => SNAPSHOT_EXT_RE.test(p));
  if (candidates.length === 0) return [];
  const sessionDir = await findSessionDir(projectRoot, sessionId);
  if (!sessionDir) return [];

  const outDir = path.join(sessionDir, GATE_MEDIA_DIR);
  const snapshots: GateArtifactSnapshot[] = [];
  for (const rel of candidates) {
    try {
      const resolved = path.resolve(projectRoot, rel);
      if (!isPathInside(projectRoot, resolved)) continue;
      const real = await fs.realpath(resolved).catch(() => null);
      if (!real || !isPathInside(await fs.realpath(projectRoot), real)) continue;
      if (isBlockedProjectPath(projectRoot, resolved)) continue;
      const fileStat = await fs.stat(real);
      if (!fileStat.isFile()) continue;
      const ext = path.extname(rel).toLowerCase();
      const cap = AV_EXT_RE.test(ext) ? MAX_AV_BYTES : MAX_STATIC_BYTES;
      if (fileStat.size > cap) {
        logger.warn(`gate-artifacts: skipping ${rel} (${fileStat.size} bytes exceeds snapshot cap)`);
        continue;
      }
      const content = await fs.readFile(real);
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      await fs.mkdir(outDir, { recursive: true });
      const file = path.join(outDir, `${hash}${ext}`);
      try {
        await fs.writeFile(file, content, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      snapshots.push({ path: rel, hash, ext, bytes: content.length });
    } catch (error) {
      logger.warn(`gate-artifacts: failed to snapshot ${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return snapshots;
}

/**
 * Locate a snapshot file for serving. The hash doubles as the filename, so
 * lookups cannot traverse; a malformed hash simply finds nothing.
 */
export async function findGateSnapshotFile(
  projectRoot: string,
  sessionId: string,
  hash: string
): Promise<string | null> {
  if (!/^[a-f0-9]{16}$/.test(hash)) return null;
  const sessionDir = await findSessionDir(projectRoot, sessionId);
  if (!sessionDir) return null;
  const dir = path.join(sessionDir, GATE_MEDIA_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const name = entries.find((e) => e.startsWith(`${hash}.`) || e === hash);
  return name ? path.join(dir, name) : null;
}
