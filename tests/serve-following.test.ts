import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFollowingStore, followingKey, isFollowingKey } from '../src/cli/serve/following';

const dirs: string[] = [];
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'following-'));
  dirs.push(dir);
  return join(dir, 'nested', 'following.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('following store', () => {
  it('starts empty when no file exists, and persists follow order', async () => {
    const path = await tempFile();
    const store = createFollowingStore(path);
    expect(await store.list()).toEqual([]);

    await store.set(followingKey('p1', 'agents/a.agentuse'), true);
    await store.set(followingKey('p2', 'b.agentuse'), true);
    expect(await store.has('p1', 'agents/a.agentuse')).toBe(true);

    const reread = createFollowingStore(path);
    expect(await reread.list()).toEqual(['p1::agents/a.agentuse', 'p2::b.agentuse']);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  });

  it('unfollows, and following again moves the agent to the end', async () => {
    const store = createFollowingStore(await tempFile());
    await store.set('p::a', true);
    await store.set('p::b', true);
    await store.set('p::a', true);
    expect(await store.list()).toEqual(['p::b', 'p::a']);
    await store.set('p::b', false);
    expect(await store.list()).toEqual(['p::a']);
  });

  it('imports a batch without duplicating what is already followed', async () => {
    const store = createFollowingStore(await tempFile());
    await store.set('p::a', true);
    expect(await store.add(['p::a', 'p::c'])).toEqual(['p::a', 'p::c']);
  });

  it('keeps every toggle when several land at once', async () => {
    const store = createFollowingStore(await tempFile());
    await Promise.all(['p::1', 'p::2', 'p::3', 'p::4'].map((key) => store.set(key, true)));
    expect((await store.list()).sort()).toEqual(['p::1', 'p::2', 'p::3', 'p::4']);
  });

  it('throws on a file that is not a following list instead of treating it as empty', async () => {
    const path = await tempFile();
    await createFollowingStore(path).set('p::a', true);
    await writeFile(path, JSON.stringify({ agents: 'nope' }));
    await expect(createFollowingStore(path).list()).rejects.toThrow('is not a following list');
  });

  it('accepts only project::path keys', () => {
    expect(isFollowingKey('p::agents/a.agentuse')).toBe(true);
    expect(isFollowingKey('::a')).toBe(false);
    expect(isFollowingKey('p::')).toBe(false);
    expect(isFollowingKey('plain')).toBe(false);
    expect(isFollowingKey(3)).toBe(false);
  });
});
