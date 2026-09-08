import * as path from 'node:path';

/**
 * Process-local serialization for read-modify-write operations on one file.
 *
 * Filesystem tool calls may execute concurrently. Without serialization, two
 * edits can read the same snapshot and whichever write finishes last silently
 * discards the other edit. The path validator resolves symlinks before this
 * queue is entered, so aliases converge while unrelated files stay concurrent.
 */
const pendingMutations = new Map<string, Promise<void>>();

function mutationKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

export async function withFileMutationQueue<T>(
  filePath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const key = mutationKey(filePath);
  const previous = pendingMutations.get(key) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingMutations.set(key, current);

  await previous;
  try {
    return await mutate();
  } finally {
    release();
    if (pendingMutations.get(key) === current) {
      pendingMutations.delete(key);
    }
  }
}
