import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getSessionStorageDir } from './paths';

export interface StorageState {
  dir: string;
}

let storageState: Promise<StorageState> | null = null;

/**
 * Raised when a stored JSON file exists but cannot be parsed (truncated,
 * concatenated, or otherwise malformed on disk). Distinct from a missing file
 * (which readJSON maps to null) so callers can decide per-context: a single-
 * session read surfaces it as an error, while bulk cross-session scans skip the
 * one bad file and keep going.
 */
export class CorruptStorageError extends Error {
  constructor(public readonly storageKey: string, parseError: unknown) {
    super(`Corrupt storage file at ${storageKey}: ${(parseError as Error)?.message ?? String(parseError)}`);
    this.name = 'CorruptStorageError';
  }
}

/**
 * Initialize storage for a project
 */
export async function initStorage(projectRoot: string): Promise<StorageState> {
  const dir = await getSessionStorageDir(projectRoot);

  if (storageState) {
    const current = await storageState;
    if (current.dir === dir) {
      return current;
    }
  }

  storageState = (async () => {
    // Ensure base directory exists
    await fs.mkdir(dir, { recursive: true });

    return { dir };
  })();

  return storageState;
}

/**
 * Get current storage state
 */
export function getStorageState(): Promise<StorageState> {
  if (!storageState) {
    throw new Error('Storage not initialized. Call initStorage first.');
  }
  return storageState;
}

/**
 * Write JSON with atomic operation
 */
export async function writeJSON<T>(key: string, content: T): Promise<void> {
  const state = await getStorageState();
  const target = path.join(state.dir, key + '.json');

  // Ensure directory exists
  await fs.mkdir(path.dirname(target), { recursive: true });

  // Atomic write: temp file + rename. The temp name must be unique per *writer*,
  // not just per millisecond: the serve daemon and the runner are separate
  // processes that both write the same session keys (e.g. session.json), and
  // serializedWrite only orders writes within a single SessionManager instance.
  // A Date.now()-only suffix collides when two processes write the same key in
  // the same ms, so their writes interleave into one temp file and a shorter
  // write fails to truncate a longer one, leaving valid JSON + trailing garbage.
  // pid + randomUUID makes the temp path collision-free across processes.
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(tmp, JSON.stringify(content, null, 2), 'utf-8');
    await fs.rename(tmp, target);
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tmp);
    } catch {
      // Ignore unlink errors
    }
    throw error;
  }
}

/**
 * Read JSON
 */
export async function readJSON<T>(key: string): Promise<T | null> {
  const state = await getStorageState();
  const target = path.join(state.dir, key + '.json');

  let content: string;
  try {
    content = await fs.readFile(target, 'utf-8');
  } catch (error) {
    // A missing file is an expected "not found" and maps to null. Other read
    // failures (permission denied, disk error) are real and must surface.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    // The file is present but unparseable. Wrap in a typed error carrying the
    // key so callers can distinguish corruption from absence and handle it per
    // context (surface vs. skip) rather than masquerading as an absent session.
    throw new CorruptStorageError(key, error);
  }
}

/**
 * List all keys matching a pattern (e.g., "session/info/*")
 */
export async function listKeys(pattern: string): Promise<string[]> {
  const state = await getStorageState();
  const baseDir = path.join(state.dir, pattern);

  try {
    const files = await fs.readdir(baseDir, { recursive: true });
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => path.relative(state.dir, path.join(baseDir, f)).replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
