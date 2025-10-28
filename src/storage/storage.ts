import fs from 'fs/promises';
import path from 'path';
import { getSessionStorageDir } from './paths';

export interface StorageState {
  dir: string;
}

let storageState: Promise<StorageState> | null = null;

/**
 * Initialize storage for a project
 */
export async function initStorage(projectRoot: string): Promise<StorageState> {
  if (storageState) {
    return storageState;
  }

  storageState = (async () => {
    const dir = await getSessionStorageDir(projectRoot);

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

  // Atomic write: temp file + rename
  const tmp = target + '.' + Date.now() + '.tmp';

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

  try {
    const content = await fs.readFile(target, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
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
