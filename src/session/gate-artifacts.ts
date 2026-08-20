/**
 * Gate-time artifact snapshots for `await_human`.
 *
 * The approval Web UI shows files a gate references (explicit artifact_paths
 * plus media paths mentioned in the payload prose). Serving the live workspace
 * path is wrong for review integrity: agents overwrite tmp/ files between gate
 * rounds, so the reviewer can approve bytes that no longer exist by the time
 * the action runs. At gate time we copy each referenced file into the
 * session's own storage (content-addressed, immutable, removed with the
 * session) and the viewer serves the snapshot. Gates recorded before snapshot
 * support may still use a live path; a current gate that declares an artifact
 * must snapshot it successfully before it can suspend.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { getSessionStorageDir, getStorageState } from '../storage/index.js';
import { SessionManager } from './manager.js';
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

interface GateArtifactCandidate {
  path: string;
  /** Declared as review material (fail the gate if it cannot be snapshotted)
   *  vs. merely parsed out of a command string (best-effort). */
  required: boolean;
}

/**
 * Explicit artifact paths + media paths mentioned in payload prose, deduped.
 *
 * `changes[].content` is the command the reviewer is approving to RUN, so a
 * media path in there is as often the command's OUTPUT as its input. Those are
 * collected best-effort: shown when the bytes already exist, skipped when they
 * do not. Everything else is review material and stays fail-closed.
 */
function collectGateArtifactCandidates(input: Record<string, unknown>): GateArtifactCandidate[] {
  const out: GateArtifactCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown, required: boolean) => {
    if (typeof raw !== 'string') return;
    const p = raw.trim().replace(/^\.\//, '');
    // First mention wins, so a path named in prose AND in a command stays required.
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ path: p, required });
  };

  push(input.artifact_path, true);
  if (Array.isArray(input.artifact_paths)) for (const p of input.artifact_paths) push(p, true);

  const texts: { text: string; required: boolean }[] = [];
  for (const key of ['summary', 'draft', 'context', 'risk'] as const) {
    if (typeof input[key] === 'string') texts.push({ text: input[key] as string, required: true });
  }
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      const content = (change as Record<string, unknown> | null)?.content;
      if (typeof content === 'string') texts.push({ text: content, required: false });
    }
  }
  // Prose first so a path shared with a command is classified as required.
  for (const { text, required } of [...texts].sort((a, b) => Number(b.required) - Number(a.required))) {
    for (const match of text.matchAll(PAYLOAD_MEDIA_PATH_RE)) {
      const raw = match[0];
      // URL host segment, not a local path.
      if (raw.startsWith('//') || (match.index !== undefined && text[match.index - 1] === ':')) continue;
      push(raw, required);
    }
  }
  return out;
}

/** Explicit artifact paths + media paths mentioned in payload prose, deduped. */
export function collectGateArtifactPaths(input: Record<string, unknown>): string[] {
  return collectGateArtifactCandidates(input).map((c) => c.path);
}

/**
 * Ask SessionManager's index-based resolver, or `undefined` when it cannot
 * answer for this store: storage is bound to a different project root, was
 * never initialized in this process, or a session file on the way is corrupt.
 * Only then is the caller's full walk worth paying for.
 */
async function indexedSessionDir(storageRoot: string, sessionId: string): Promise<string | null | undefined> {
  try {
    const state = await getStorageState();
    if (state.dir !== storageRoot) return undefined;
    return await new SessionManager().resolveSessionDirectoryById(sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the on-disk session dir (`<storage>/session/<id>-<agent>`) by id.
 *
 * The durable session index maps every id — nested subagents included — to its
 * directory for the cost of one small JSON read. The walk below readdirs every
 * session in the store instead, which is seconds once a store holds thousands
 * of them, and it is paid on every approval gate and every artifact request. So
 * consult the index first and trust its answer, including its silence; walk
 * only when the index could not speak for this store at all.
 */
async function findSessionDir(projectRoot: string, sessionId: string): Promise<string | null> {
  const storageRoot = await getSessionStorageDir(projectRoot);

  const indexed = await indexedSessionDir(storageRoot, sessionId);
  if (indexed !== undefined) return indexed;

  const walk = async (dir: string): Promise<string | null> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const match = entries.find((entry) =>
      entry.isDirectory() && entry.name.startsWith(`${sessionId}-`)
    );
    if (match) return path.join(dir, match.name);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.index') continue;
      const found = await walk(path.join(dir, entry.name));
      if (found) return found;
    }
    return null;
  };
  return walk(storageRoot);
}

/**
 * Snapshot every file the gate explicitly references (plus detected media)
 * into the session dir. This is fail-closed: returning a partial set would make
 * the approval surface silently substitute mutable workspace bytes.
 */
export async function snapshotGateArtifacts(
  projectRoot: string,
  sessionId: string,
  input: Record<string, unknown>
): Promise<GateArtifactSnapshot[]> {
  const candidates = collectGateArtifactCandidates(input);
  if (candidates.length === 0) return [];
  const sessionDir = await findSessionDir(projectRoot, sessionId);
  if (!sessionDir) {
    throw new Error(`cannot locate session ${sessionId} for artifact snapshots`);
  }

  const outDir = path.join(sessionDir, GATE_MEDIA_DIR);
  const snapshots: GateArtifactSnapshot[] = [];
  const failures: string[] = [];
  const realProjectRoot = await fs.realpath(projectRoot);
  for (const { path: rel, required } of candidates) {
    try {
      const resolved = path.resolve(projectRoot, rel);
      if (!isPathInside(projectRoot, resolved)) {
        throw new Error('path is outside the project');
      }
      const real = await fs.realpath(resolved).catch(() => null);
      if (!real) throw new Error('file does not exist');
      if (!isPathInside(realProjectRoot, real)) {
        throw new Error('resolved path is outside the project');
      }
      if (isBlockedProjectPath(realProjectRoot, real)) {
        throw new Error('path is blocked from approval disclosure');
      }
      const fileStat = await fs.stat(real);
      if (!fileStat.isFile()) throw new Error('path is not a regular file');
      const ext = path.extname(rel).toLowerCase();
      const cap = AV_EXT_RE.test(ext) ? MAX_AV_BYTES : MAX_STATIC_BYTES;
      if (fileStat.size > cap) {
        throw new Error(`${fileStat.size} bytes exceeds the ${cap}-byte snapshot cap`);
      }
      const content = await fs.readFile(real);
      if (content.length > cap) {
        throw new Error(`file grew beyond the ${cap}-byte snapshot cap while reading`);
      }
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
      const message = error instanceof Error ? error.message : String(error);
      if (!required) {
        // Command-only path: nothing is displayed, so nothing mutable can be
        // substituted. Blocking here would deadlock the common case of gating
        // the very command that creates the file.
        logger.debug(`gate-artifacts: skipping command-referenced ${rel}: ${message}`);
        continue;
      }
      logger.warn(`gate-artifacts: failed to snapshot ${rel}: ${message}`);
      failures.push(`${rel}: ${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Approval artifact snapshot failed; the gate was not opened because review bytes must be immutable. ${failures.join('; ')}`
    );
  }
  return snapshots;
}

/**
 * Look for `<hash>` in this session dir's gate store, then in its sub-agents'.
 *
 * Delegated sessions are the only descendants that own a gate store, and they
 * live at `<session>/subagent/<id>-<agent>` (recursively). Descending into every
 * other child would readdir the session's whole message and part tree on each
 * artifact request to find nothing.
 */
async function findSnapshotUnder(dir: string, hash: string): Promise<string | null> {
  const gateDir = path.join(dir, GATE_MEDIA_DIR);
  const gateEntries = await fs.readdir(gateDir).catch(() => null);
  if (gateEntries) {
    const name = gateEntries.find((e) => e.startsWith(`${hash}.`) || e === hash);
    if (name) return path.join(gateDir, name);
  }
  const subagentDir = path.join(dir, 'subagent');
  const children = await fs.readdir(subagentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of children) {
    if (!entry.isDirectory()) continue;
    const found = await findSnapshotUnder(path.join(subagentDir, entry.name), hash);
    if (found) return found;
  }
  return null;
}

/**
 * Locate a snapshot file for serving. The hash doubles as the filename, so
 * lookups cannot traverse; a malformed hash simply finds nothing.
 *
 * The search covers the session's own gate store AND its delegated sub-agents'.
 * A sub-agent's gate is surfaced and decided on its PARENT's approval page, so
 * the link carries the parent's session id while the snapshot lives in the
 * child's storage. Looking only at the session's own dir fails those closed
 * ("snapshot unavailable") even though the bytes are right there.
 */
export async function findGateSnapshotFile(
  projectRoot: string,
  sessionId: string,
  hash: string
): Promise<string | null> {
  if (!/^[a-f0-9]{16}$/.test(hash)) return null;
  const sessionDir = await findSessionDir(projectRoot, sessionId);
  if (!sessionDir) return null;
  return findSnapshotUnder(sessionDir, hash);
}
