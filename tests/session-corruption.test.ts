import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage, readJSON, CorruptStorageError } from '../src/storage';
import { SessionManager } from '../src/session';

const baseAgent = (id: string, name: string, root: string) => ({
  agent: { id, name, isSubAgent: false },
  model: 'demo:test',
  version: 'test',
  config: {},
  project: { root, cwd: root },
});

// Mimic the on-disk corruption signature we recovered in production: a complete
// valid JSON object followed by leftover bytes from an interleaved write that a
// shorter write failed to truncate.
async function corruptSessionFile(path: string): Promise<void> {
  const good = await readFile(path, 'utf-8');
  await writeFile(path, good + '\n  }\n}', 'utf-8');
}

describe('storage corruption handling', () => {
  it('readJSON throws a typed CorruptStorageError on malformed JSON (not null)', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-corrupt-read-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      const state = await initStorage(projectRoot);
      // A missing key is "not found" -> null.
      expect(await readJSON(`${projectRoot}/missing`)).toBeNull();
      // A present-but-broken key -> typed corruption error.
      await writeFile(join(state.dir, 'broken.json'), '{"a":1}garbage', 'utf-8');
      let caught: unknown;
      try {
        await readJSON('broken');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CorruptStorageError);
      expect((caught as CorruptStorageError).storageKey).toBe('broken');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('skips an unrelated corrupt session during a cross-session scan (no throw)', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-corrupt-scan-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      const state = await initStorage(projectRoot);
      const mgr = new SessionManager();

      // A parent + its child, plus an unrelated session that we corrupt.
      const parentId = await mgr.createSession({ ...baseAgent('agents/parent', 'parent', projectRoot) });
      const childId = await mgr.createSession({
        ...baseAgent('agents/child', 'child', projectRoot),
        parentSessionID: parentId,
      });
      const unrelatedId = await mgr.createSession({ ...baseAgent('agents/other', 'other', projectRoot) });

      // Corrupt the unrelated session's session.json on disk.
      await corruptSessionFile(join(state.dir, `${unrelatedId}-agents-other`, 'session.json'));

      // listChildSessions walks every session.json (this is the production path
      // that 500'd). It must skip the bad file and still return the real child.
      const children = await mgr.listChildSessions(parentId);
      expect(children.map((c) => c.session.id)).toContain(childId);

      // The corrupt session is simply absent from scans, not fatal.
      const stopped = await mgr.stopSessionTree(parentId);
      expect(stopped.map((s) => s.sessionId)).toContain(parentId);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces corruption of the requested session itself as an error', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-corrupt-self-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      const state = await initStorage(projectRoot);
      const mgr = new SessionManager();
      const id = await mgr.createSession({ ...baseAgent('agents/review', 'review', projectRoot) });

      await corruptSessionFile(join(state.dir, `${id}-agents-review`, 'session.json'));

      // findSession reads the requested session's own file strictly: corruption
      // here must throw (so the API maps it to SESSION_CORRUPTED), not be skipped.
      let caught: unknown;
      try {
        await new SessionManager().findSession(id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CorruptStorageError);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
