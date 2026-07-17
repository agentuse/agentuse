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
  it('serves Web UI summaries from a durable index and rebuilds it when missing', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-session-index-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      const state = await initStorage(projectRoot);
      const manager = new SessionManager();
      const id = await manager.createSession({
        agent: { id: 'agents/indexed', name: 'Indexed', isSubAgent: false },
        model: 'demo:test', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });

      const indexPath = join(state.dir, '.index', 'sessions.v1.json');
      const first = await manager.listSessionSummaries();
      expect(first).toHaveLength(1);
      expect(first[0]?.sessionId).toBe(id);
      expect(first[0]?.status).toBe('running');

      await manager.setSessionCompleted(id, 'agents/indexed');
      const updated = await manager.listSessionSummaries();
      expect(updated[0]?.status).toBe('completed');

      await rm(indexPath);
      const rebuilt = await manager.listSessionSummaries();
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]?.status).toBe('completed');

      // A left-behind marker represents a process that died between writing
      // session.json and publishing the index. The next reader repairs it.
      await mkdir(join(state.dir, '.index'), { recursive: true });
      await writeFile(join(state.dir, '.index', 'dirty.json'), '{"startedAt":0}', 'utf-8');
      const recovered = await manager.listSessionSummaries();
      expect(recovered).toHaveLength(1);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

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

  it('marks a suspended parent with a running delegated child as subagentActive', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-subagent-active-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      const state = await initStorage(projectRoot);
      const parentId = ulid();
      const childId = ulid();

      const parent = sessionInfo({
        id: parentId, agentId: 'agents/manager', agentName: 'Manager', projectRoot, created: Date.now(),
      });
      parent.status = 'suspended';
      const parentDir = await writeSession(state.dir, '', parent);

      const child = sessionInfo({
        id: childId, agentId: 'agents/leaf', agentName: 'Leaf', projectRoot, created: Date.now(),
        isSubAgent: true, parentSessionID: parentId,
      });
      child.status = 'running';
      await writeSession(state.dir, join(parentDir, 'subagent'), child);

      // The default list drops subagents, yet the parent must still carry the
      // flag: it is derived over the full set (incl. the running leaf) before the
      // includeSubagents filter removes that leaf.
      const topLevel = await new SessionManager().listSessionSummaries();
      expect(topLevel.map((s) => s.sessionId)).toEqual([parentId]);
      expect(topLevel[0]?.subagentActive).toBe(true);

      // When the child stops running (e.g. it too parks at its own gate), the
      // parent is no longer subagent-active — it is genuinely blocked.
      child.status = 'suspended';
      await writeSession(state.dir, join(parentDir, 'subagent'), child);
      await rm(join(state.dir, '.index'), { recursive: true, force: true });
      const afterGate = await new SessionManager().listSessionSummaries();
      expect(afterGate[0]?.subagentActive).toBeUndefined();
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('prefilters non-approval part files before parsing latest approval parts', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-approval-prefilter-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      const state = await initStorage(projectRoot);
      const created = Date.UTC(2026, 0, 3);
      const sessionId = ulid(created);
      const session = sessionInfo({
        id: sessionId,
        agentId: 'agents/review',
        agentName: 'review',
        projectRoot,
        created,
      });
      const sessionDir = await writeSession(state.dir, '', session);
      const messageId = ulid(created + 1);
      const partDir = join(state.dir, sessionDir, messageId, 'part');
      await mkdir(partDir, { recursive: true });

      const approvalPartId = ulid(created + 3);
      await writeFile(
        join(partDir, `${approvalPartId}.json`),
        JSON.stringify({
          id: approvalPartId,
          sessionID: sessionId,
          messageID: messageId,
          type: 'tool',
          tool: 'await_human',
          state: {
            status: 'pending',
            input: { prompt: 'Approve?' },
            resumePayload: { kind: 'await_human', resumeToken: 'token-1' },
            suspendedAt: created + 3,
          },
        }, null, 2),
        'utf-8'
      );

      await writeFile(
        join(partDir, `${ulid(created + 4)}.json`),
        '{ "type": "tool", "tool": "shell", "output": ',
        'utf-8'
      );

      const approvalPart = await new SessionManager().getLatestApprovalPart(sessionId, 'agents/review');
      expect(approvalPart?.id).toBe(approvalPartId);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
