import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';

/**
 * Project artifact manifest.
 *
 * Project artifacts (reports/plans/HTML deliverables under `.agentuse/artifacts/`)
 * are written by `tools__artifact_save`. Unlike auto-generated tool-output artifacts,
 * they live in the project tree, so this manifest is what links each one back to
 * the run that produced it and lets the agent (and serve) enumerate them across
 * runs. It is the single source of truth for `tools__artifact_list`.
 */

export const DEFAULT_ARTIFACTS_DIR = '.agentuse/artifacts';
export const MANIFEST_FILENAME = 'manifest.json';

export interface ArtifactManifestEntry {
  /** Project-root-relative POSIX path. Stable id (keyed on path, not content). */
  name: string;
  /** Group folder slug, e.g. "client-report". */
  group: string;
  /** Human-readable title, when provided. */
  title?: string;
  /** Lowercased extension without the dot: md, html, svg, pdf, txt, json, ... */
  type: string;
  /** Size in bytes of the written content (UTF-8). */
  bytes: number;
  /** Session that produced the artifact, when run inside a session. */
  sessionId?: string;
  /** Stable agent id that produced the artifact. */
  agentId?: string;
  /** ISO timestamp of first write. */
  createdAt: string;
  /** ISO timestamp of the most recent write. */
  updatedAt: string;
}

export interface ArtifactManifest {
  version: 1;
  artifacts: ArtifactManifestEntry[];
}

/** Absolute path to the manifest for a project + artifact dir. */
export function getManifestPath(projectRoot: string, dir: string = DEFAULT_ARTIFACTS_DIR): string {
  return path.join(projectRoot, dir, MANIFEST_FILENAME);
}

function emptyManifest(): ArtifactManifest {
  return { version: 1, artifacts: [] };
}

/**
 * Read the manifest. A missing or corrupt file is treated as empty rather than
 * an error, so a hand-deleted manifest or a partially written one never crashes
 * a run or the viewer.
 */
export async function readArtifactManifest(manifestPath: string): Promise<ArtifactManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return emptyManifest();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ArtifactManifest).artifacts)) {
      return { version: 1, artifacts: (parsed as ArtifactManifest).artifacts };
    }
  } catch {
    /* corrupt → empty */
  }
  return emptyManifest();
}

// Per-manifest-path promise chain. Serializes read-modify-write so concurrent
// tool calls within a run (and in-process subagents) never interleave and drop
// each other's entries. The atomic temp+rename below guarantees no reader ever
// observes a half-written file even across separate processes.
const writeChains = new Map<string, Promise<unknown>>();

function withWriteChain<T>(key: string, op: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const result = previous.then(() => op(), () => op());
  writeChains.set(key, result.then(() => {}, () => {}));
  return result;
}

async function writeManifestAtomic(manifestPath: string, manifest: ArtifactManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, manifestPath);
}

/**
 * Insert or update an entry, keyed on `name` (the project-relative path). An
 * existing entry keeps its original `createdAt`. Serialized + atomic.
 */
export async function upsertArtifactEntry(
  manifestPath: string,
  entry: ArtifactManifestEntry
): Promise<void> {
  await withWriteChain(manifestPath, async () => {
    const manifest = await readArtifactManifest(manifestPath);
    const idx = manifest.artifacts.findIndex((a) => a.name === entry.name);
    if (idx >= 0) {
      manifest.artifacts[idx] = { ...entry, createdAt: manifest.artifacts[idx].createdAt };
    } else {
      manifest.artifacts.push(entry);
    }
    await writeManifestAtomic(manifestPath, manifest);
  });
}
