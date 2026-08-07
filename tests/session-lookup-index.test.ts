import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getStorageState, initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

/**
 * findSession's last resort readdirs every session directory in the store. That
 * cost lands on misses, and a multi-project daemon resolving a bare
 * `/sessions/{id}` URL misses in every project that does not hold the session,
 * so the scan has to stay off the common path.
 */
describe('session lookup via the durable index', () => {
  let projectRoot: string;
  let originalXdgDataHome: string | undefined;

  const base = (agentId: string) => ({
    agent: { id: agentId, name: agentId.split('/').pop()!, isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });

  /**
   * Records the session ids the full-store scan was entered for, keeping its
   * real behavior. The scan recurses through itself, so only the entry call
   * (no relative dir yet) counts as "a scan happened".
   */
  const watchScan = (manager: SessionManager) => {
    const calls: string[] = [];
    const proto = SessionManager.prototype as unknown as Record<string, unknown>;
    const real = proto.findSessionDirById as (...args: unknown[]) => Promise<string | null>;
    (manager as unknown as Record<string, unknown>).findSessionDirById = function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (args[2] === undefined || args[2] === '') calls.push(String(args[1]));
      return real.apply(this, args);
    };
    return calls;
  };

  beforeEach(async () => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-session-lookup-'));
    process.env.XDG_DATA_HOME = projectRoot;
    await initStorage(projectRoot);
    // findSession's positive cache is process-wide; a stale entry from another
    // test would answer before the code under test runs.
    (SessionManager as unknown as { foundSessionPathCache: Map<string, string> })
      .foundSessionPathCache.clear();
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('answers "not in this store" without scanning it', async () => {
    const manager = new SessionManager();
    await manager.createSession(base('agents/review'));
    await manager.createSession(base('agents/triage'));

    const scans = watchScan(manager);
    expect(await manager.findSession('01ABSENTSESSIONID0000000AA')).toBeNull();
    expect(scans).toEqual([]);
  });

  it('finds a nested subagent session without scanning', async () => {
    const parentManager = new SessionManager();
    const parentId = await parentManager.createSession(base('agents/manager'));

    const childManager = new SessionManager();
    childManager.setParentPath(parentManager.getFullPath()!);
    const childId = await childManager.createSession({
      ...base('agents/worker'),
      agent: { id: 'agents/worker', name: 'worker', isSubAgent: true },
      parentSessionID: parentId,
    } as Parameters<SessionManager['createSession']>[0]);

    // A fresh manager has no cached path, so this is the cold lookup a serve
    // request makes after a restart.
    const lookup = new SessionManager();
    (SessionManager as unknown as { foundSessionPathCache: Map<string, string> })
      .foundSessionPathCache.clear();
    const scans = watchScan(lookup);

    const found = await lookup.findSession(childId);
    expect(found?.session.id).toBe(childId);
    expect(scans).toEqual([]);
  });

  it('still scans when the index is missing, so lookups never depend on it', async () => {
    const manager = new SessionManager();
    const sessionId = await manager.createSession(base('agents/review'));

    const state = await getStorageState();
    await unlink(join(state.dir, '.index', 'sessions.v1.json'));
    (SessionManager as unknown as { foundSessionPathCache: Map<string, string> })
      .foundSessionPathCache.clear();

    const lookup = new SessionManager();
    const scans = watchScan(lookup);
    // Top-level sessions resolve from one readdir, so force the scan path by
    // asking for an id the shallow probe cannot match.
    expect(await lookup.findSession('01ABSENTSESSIONID0000000AA')).toBeNull();
    expect(scans).toEqual(['01ABSENTSESSIONID0000000AA']);

    // And the real session is still resolvable with no index at all.
    expect((await lookup.findSession(sessionId))?.session.id).toBe(sessionId);
  });

  it('does not trust the index while a write is half-applied', async () => {
    const manager = new SessionManager();
    await manager.createSession(base('agents/review'));

    const state = await getStorageState();
    await writeFile(
      join(state.dir, '.index', 'dirty.json'),
      JSON.stringify({ startedAt: Date.now(), pid: process.pid })
    );
    (SessionManager as unknown as { foundSessionPathCache: Map<string, string> })
      .foundSessionPathCache.clear();

    const lookup = new SessionManager();
    const scans = watchScan(lookup);
    expect(await lookup.findSession('01ABSENTSESSIONID0000000AA')).toBeNull();
    expect(scans).toEqual(['01ABSENTSESSIONID0000000AA']);
  });

  it('rejects a stale index entry rather than resolving the wrong directory', async () => {
    const manager = new SessionManager();
    await manager.createSession(base('agents/review'));

    // Point a live index entry at a directory that no longer holds that session.
    const state = await getStorageState();
    const indexPath = join(state.dir, '.index', 'sessions.v1.json');
    const index = JSON.parse(await Bun.file(indexPath).text());
    index.sessions['01STALESESSIONID00000000AA'] = {
      sessionId: '01STALESESSIONID00000000AA',
      agent: { id: 'agents/ghost', name: 'ghost', isSubAgent: false },
      status: 'running',
      trigger: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      path: '01STALESESSIONID00000000AA-agents-ghost',
    };
    await writeFile(indexPath, JSON.stringify(index));
    (SessionManager as unknown as { foundSessionPathCache: Map<string, string> })
      .foundSessionPathCache.clear();

    const lookup = new SessionManager();
    const scans = watchScan(lookup);
    // The entry does not verify, so the lookup falls back to the scan and
    // reports the session as absent instead of returning a bogus path.
    expect(await lookup.findSession('01STALESESSIONID00000000AA')).toBeNull();
    expect(scans).toEqual(['01STALESESSIONID00000000AA']);
  });
});
