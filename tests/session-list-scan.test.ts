import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ulid } from 'ulid';
import { initStorage, sanitizeAgentName } from '../src/storage';
import { SessionManager } from '../src/session';
import type { SessionInfo } from '../src/session/types';

function sessionInfo(options: {
  id: string;
  agentId: string;
  agentName: string;
  projectRoot: string;
  created: number;
  isSubAgent?: boolean;
  parentSessionID?: string;
}): SessionInfo {
  return {
    id: options.id,
    agent: {
      id: options.agentId,
      name: options.agentName,
      isSubAgent: options.isSubAgent ?? false,
    },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: options.projectRoot, cwd: options.projectRoot },
    status: 'completed',
    trigger: 'manual',
    time: {
      created: options.created,
      updated: options.created,
    },
    ...(options.parentSessionID && { parentSessionID: options.parentSessionID }),
  } as SessionInfo;
}

async function writeSession(
  storageDir: string,
  relativeParent: string,
  session: SessionInfo
): Promise<string> {
  const dir = join(relativeParent, `${session.id}-${sanitizeAgentName(session.agent.id)}`);
  const absoluteDir = join(storageDir, dir);
  await mkdir(absoluteDir, { recursive: true });
  await writeFile(join(absoluteDir, 'session.json'), JSON.stringify(session, null, 2), 'utf-8');
  return dir;
}

describe('session list scanning', () => {
  it('can skip stale top-level session trees unless subagents are requested', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-session-scan-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      const state = await initStorage(projectRoot);
      const oldTime = Date.UTC(2026, 0, 1);
      const cutoff = Date.UTC(2026, 0, 2);
      const recentTime = Date.UTC(2026, 0, 3);

      const oldParentId = ulid(oldTime);
      const recentChildId = ulid(recentTime);
      const recentTopLevelId = ulid(recentTime + 1);

      const oldParentDir = await writeSession(state.dir, '', sessionInfo({
        id: oldParentId,
        agentId: 'agents/parent',
        agentName: 'parent',
        projectRoot,
        created: oldTime,
      }));

      await writeSession(state.dir, join(oldParentDir, 'subagent'), sessionInfo({
        id: recentChildId,
        agentId: 'agents/child',
        agentName: 'child',
        projectRoot,
        created: recentTime,
        isSubAgent: true,
        parentSessionID: oldParentId,
      }));

      await writeSession(state.dir, '', sessionInfo({
        id: recentTopLevelId,
        agentId: 'agents/recent',
        agentName: 'recent',
        projectRoot,
        created: recentTime + 1,
      }));

      const topLevelOnly = await new SessionManager().listSessionsCreatedAfter(cutoff, {
        includeSubagents: false,
      });
      expect(topLevelOnly.map(({ session }) => session.id)).toEqual([recentTopLevelId]);

      const withSubagents = await new SessionManager().listSessionsCreatedAfter(cutoff, {
        includeSubagents: true,
      });
      expect(withSubagents.map(({ session }) => session.id).sort()).toEqual([
        recentChildId,
        recentTopLevelId,
      ].sort());
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
