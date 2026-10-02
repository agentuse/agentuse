import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withSerializedOwnershipLock } from '../utils/ownership-lock.js';

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
 * Strict read for the write path. Only a missing file counts as empty: an
 * unreadable file, bad JSON, or a root without an `artifacts` array throws, so
 * an upsert never replaces entries it failed to read.
 */
async function readArtifactManifestStrict(manifestPath: string): Promise<ArtifactManifest> {
  const unusable = (reason: string) => new Error(
    `Artifact manifest ${manifestPath} ${reason}. It was left unchanged. Fix or move it aside, then save the artifact again.`
  );
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
    throw unusable(`could not be read (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw unusable(`is not valid JSON (${(error as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ArtifactManifest).artifacts)) {
    throw unusable('does not contain an object with an "artifacts" array');
  }
  return { version: 1, artifacts: (parsed as ArtifactManifest).artifacts };
}

/**
 * Read the manifest for listing and display. A missing or corrupt file is
 * treated as empty rather than an error, so a hand-deleted manifest or a
 * partially written one never crashes a run or the viewer. Writes go through
 * the strict read instead.
 */
export async function readArtifactManifest(manifestPath: string): Promise<ArtifactManifest> {
  try {
    return await readArtifactManifestStrict(manifestPath);
  } catch {
    return emptyManifest();
  }
}

async function writeManifestAtomic(manifestPath: string, manifest: ArtifactManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Insert or update an entry, keyed on `name` (the project-relative path). An
 * existing entry keeps its original `createdAt`. Locked across processes + atomic.
 */
export async function upsertArtifactEntry(
  manifestPath: string,
  entry: ArtifactManifestEntry
): Promise<void> {
  // Serve workers and a CLI run can write one project's manifest at the same
  // time; the atomic rename only stops torn reads, the lock stops lost updates.
  await withSerializedOwnershipLock(`${manifestPath}.lock`, async () => {
    const manifest = await readArtifactManifestStrict(manifestPath);
    const idx = manifest.artifacts.findIndex((a) => a.name === entry.name);
    if (idx >= 0) {
      manifest.artifacts[idx] = { ...entry, createdAt: manifest.artifacts[idx].createdAt };
    } else {
      manifest.artifacts.push(entry);
    }
    await writeManifestAtomic(manifestPath, manifest);
  }, { label: 'artifact-manifest' });
}
