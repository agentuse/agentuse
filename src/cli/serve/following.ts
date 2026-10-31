import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWriteFile } from '../../utils/atomic-write';
import { getAgentuseDataDir } from '../../utils/data-dir';

/**
 * The agents a person follows. Following narrows Sessions to the runs worth
 * reading and stars those agents on the Agents page. It lives on the daemon,
 * not in one browser's localStorage, so the phone and the desktop see the
 * same list.
 *
 * A key is `${projectId}::${runPath}`: the agent's project plus its
 * project-relative file path, the same pair a session row and an agent row
 * both carry.
 */
export interface FollowingStore {
  /** Follow order, oldest first. */
  list(): Promise<string[]>;
  has(projectId: string, runPath: string): Promise<boolean>;
  set(key: string, following: boolean): Promise<string[]>;
  /** Adds keys not already followed, keeping order. For a one-time import. */
  add(keys: string[]): Promise<string[]>;
}

interface FollowingFile {
  version: 1;
  agents: string[];
}

export function followingKey(projectId: string, runPath: string): string {
  return `${projectId}::${runPath}`;
}

export function isFollowingKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const at = value.indexOf('::');
  return at > 0 && at < value.length - 2;
}

export function followingFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentuseDataDir(env), 'following.json');
}

async function readFollowing(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<FollowingFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.agents) || !parsed.agents.every(isFollowingKey)) {
    throw new Error(`${path} is not a following list (expected {"version":1,"agents":["<project>::<path>"]})`);
  }
  return parsed.agents;
}

export function createFollowingStore(path: string = followingFilePath()): FollowingStore {
  let cache: string[] | undefined;
  // One write at a time, each starting from the last one's result, so two
  // toggles in quick succession never drop each other.
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<string[]> => {
    cache ??= await readFollowing(path);
    return cache;
  };

  const write = (change: (current: string[]) => string[]): Promise<string[]> => {
    const next = queue.then(async () => {
      const updated = change(await load());
      const file: FollowingFile = { version: 1, agents: updated };
      await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, { mkdir: true });
      cache = updated;
      return updated;
    });
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    list: async () => [...await load()],
    has: async (projectId, runPath) => (await load()).includes(followingKey(projectId, runPath)),
    set: (key, following) => write((current) => {
      const without = current.filter((k) => k !== key);
      return following ? [...without, key] : without;
    }),
    add: (keys) => write((current) => [...current, ...keys.filter((k) => !current.includes(k))]),
  };
}
