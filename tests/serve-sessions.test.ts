import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __testing } from '../src/cli/serve';
import { SESSION_SSE_IDLE_INTERVAL_MS, SESSION_SSE_LIVE_INTERVAL_MS } from '../src/cli/serve/sse';
import { sessionViewToken, validateSessionToken } from '../src/utils/session-token';
import { getStorageState, initStorage } from '../src/storage';
import { getSessionStorageDir } from '../src/storage/paths';
import { SessionManager } from '../src/session';

describe('session view token', () => {
  it('is empty on local (no api key) so links omit it', () => {
    expect(sessionViewToken('session-1', undefined)).toBe('');
  });

  it('mints a stable, session-scoped HMAC when an api key is set', () => {
    const a = sessionViewToken('session-1', 'key-A');
    const b = sessionViewToken('session-1', 'key-A');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    // Different session id or different key -> different token.
    expect(sessionViewToken('session-2', 'key-A')).not.toBe(a);
    expect(sessionViewToken('session-1', 'key-B')).not.toBe(a);
  });

  it('authorizes everything on local (no api key)', () => {
    expect(validateSessionToken(undefined, 'session-1', undefined)).toBe(true);
    expect(validateSessionToken('anything', 'session-1', undefined)).toBe(true);
  });

  it('requires the correct token when an api key is set', () => {
    const token = sessionViewToken('session-1', 'key-A');
    expect(validateSessionToken(token, 'session-1', 'key-A')).toBe(true);
    expect(validateSessionToken('wrong', 'session-1', 'key-A')).toBe(false);
    expect(validateSessionToken(undefined, 'session-1', 'key-A')).toBe(false);
  });

  it("a token for session A does not validate session B", () => {
    const tokenA = sessionViewToken('session-A', 'key-A');
    expect(validateSessionToken(tokenA, 'session-A', 'key-A')).toBe(true);
    expect(validateSessionToken(tokenA, 'session-B', 'key-A')).toBe(false);
  });

  it('does not throw on a malformed token of the wrong length', () => {
    expect(validateSessionToken('x', 'session-1', 'key-A')).toBe(false);
  });
});

describe('header-gate exemption (capability routes)', () => {
  it('exempts the session page and its action subroutes on the non-API surface', () => {
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc', false)).toBe(true);
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc/decision', false)).toBe(true);
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc/continue', false)).toBe(true);
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc/status', false)).toBe(true);
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc/stop', false)).toBe(true);
  });

  it('keeps the /sessions LIST page header-gated', () => {
    expect(__testing.isHeaderGateExemptRoute('/sessions', false)).toBe(false);
  });

  it('keeps the JSON twins header-gated (security boundary)', () => {
    // /api/sessions/:id and /api/sessions normalize to these routePaths with
    // isApi=true; they must NOT be exempt or they become unauthenticated.
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc', true)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/sessions/abc/decision', true)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/sessions', true)).toBe(false);
  });

  it('keeps legacy approval routes exempt (token-authenticated)', () => {
    expect(__testing.isHeaderGateExemptRoute('/approvals/abc', false)).toBe(true);
    expect(__testing.isHeaderGateExemptRoute('/approvals/abc/decision', true)).toBe(true);
  });

  it('does not exempt list event streams', () => {
    expect(__testing.isHeaderGateExemptRoute('/approvals/events', false)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/approvals/events', true)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/sessions/events', false)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/sessions/events', true)).toBe(false);
  });

  it('does not exempt unrelated routes', () => {
    expect(__testing.isHeaderGateExemptRoute('/agents', false)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/sessionsfoo', false)).toBe(false);
  });
});

describe('session list helpers', () => {
  const rows = [
    {
      projectId: 'project-1',
      multiProject: false,
      session: {
        sessionId: 'sess-abc',
        agent: { id: 'agents/review', name: 'Review agent', description: 'Reviews drafts' },
        status: 'completed',
        trigger: 'scheduled' as const,
        createdAt: Date.UTC(2026, 4, 1),
        updatedAt: Date.UTC(2026, 4, 1),
      },
    },
  ];

  it('defaults session list scans to 24 hours and allows all history', () => {
    const now = Date.UTC(2026, 4, 6);

    expect(__testing.sessionListCreatedAfter(new URL('http://127.0.0.1:12233/sessions'), now))
      .toBe(now - 24 * 60 * 60 * 1000);
    expect(__testing.sessionListCreatedAfter(new URL('http://127.0.0.1:12233/sessions?window=6h'), now))
      .toBe(now - 6 * 60 * 60 * 1000);
    expect(__testing.sessionListCreatedAfter(new URL('http://127.0.0.1:12233/sessions?hours=1'), now))
      .toBe(now - 1 * 60 * 60 * 1000);
    expect(__testing.sessionListCreatedAfter(new URL('http://127.0.0.1:12233/sessions?days=30'), now))
      .toBe(now - 30 * 24 * 60 * 60 * 1000);
    expect(__testing.sessionListCreatedAfter(new URL('http://127.0.0.1:12233/sessions?window=all'), now))
      .toBeUndefined();
  });

  it('matches the agent filter against partial agent names and ids', () => {
    const session = rows[0]!.session;

    expect(__testing.sessionMatchesAgentFilter(session, 'review')).toBe(true);
    expect(__testing.sessionMatchesAgentFilter(session, 'agents/rev')).toBe(true);
    expect(__testing.sessionMatchesAgentFilter(session, 'VIEW AG')).toBe(true);
    expect(__testing.sessionMatchesAgentFilter(session, 'research')).toBe(false);
  });

  it('keeps the sessions SSE list refresh at the old page polling cadence', () => {
    expect(__testing.SESSION_LIST_SSE_INTERVAL_MS).toBe(10_000);
  });

  it('keeps individual session SSE fast only while live', () => {
    expect(SESSION_SSE_LIVE_INTERVAL_MS).toBe(500);
    expect(SESSION_SSE_IDLE_INTERVAL_MS).toBe(10_000);
  });
});

describe('session trigger persistence', () => {
  it('defaults to manual and records an explicit trigger', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-trigger-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const base = {
        agent: { id: 'agents/review', name: 'review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      };

      const manualId = await sessionManager.createSession({ ...base });
      const manual = await sessionManager.getSession(manualId, 'agents/review');
      expect(manual?.trigger).toBe('manual');

      const scheduledId = await sessionManager.createSession({ ...base, trigger: 'scheduled' });
      const scheduled = await sessionManager.getSession(scheduledId, 'agents/review');
      expect(scheduled?.trigger).toBe('scheduled');
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('session tree stopping', () => {
  it('uses the latest initialized project when stopping sessions', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-stop-switch-'));
    const projectA = join(dataHome, 'project-a');
    const projectB = join(dataHome, 'project-b');
    process.env.XDG_DATA_HOME = dataHome;

    try {
      await initStorage(projectA);
      await initStorage(projectB);
      expect((await getStorageState()).dir).toBe(await getSessionStorageDir(projectB));

      const targetManager = new SessionManager();
      const sessionId = await targetManager.createSession({
        agent: { id: 'agents/target', name: 'target', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: {
          root: projectB,
          cwd: projectB,
        },
      });

      await initStorage(projectA);
      expect((await getStorageState()).dir).toBe(await getSessionStorageDir(projectA));
      await initStorage(projectB);
      expect((await getStorageState()).dir).toBe(await getSessionStorageDir(projectB));

      const stoppingManager = new SessionManager();
      const stopped = await stoppingManager.stopSessionTree(sessionId);

      expect(stopped.map((entry) => entry.sessionId)).toEqual([sessionId]);
      expect(stopped[0]?.stopped).toBe(true);

      const found = await stoppingManager.findSession(sessionId);
      expect(found?.session.status).toBe('error');
      expect(found?.session.error?.code).toBe('USER_STOPPED');
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  it('recursively marks running parent and subagent sessions as stopped', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-stop-tree-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const parentManager = new SessionManager();
      const base = {
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      };

      const parentId = await parentManager.createSession({
        ...base,
        agent: { id: 'agents/parent', name: 'parent', isSubAgent: false },
      });
      const parentMessageId = await parentManager.createMessage(parentId, 'agents/parent', {
        user: { prompt: { task: 'parent task' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      const parentApprovalPartId = await parentManager.addPart(parentId, 'agents/parent', parentMessageId, {
        type: 'tool',
        tool: 'await_human',
        state: {
          status: 'pending',
          input: { prompt: 'Approve parent?' },
          resumePayload: { kind: 'await_human', resumeToken: 'parent-token' },
          suspendedAt: Date.UTC(2026, 4, 1),
        },
      } as any);

      const childManager = new SessionManager();
      childManager.setParentPath(parentManager.getFullPath()!);
      const childId = await childManager.createSession({
        ...base,
        parentSessionID: parentId,
        agent: { id: 'agents/child', name: 'child', isSubAgent: true },
      });
      const childMessageId = await childManager.createMessage(childId, 'agents/child', {
        user: { prompt: { task: 'child task' } },
        assistant: {
          system: [],
          modelID: 'demo:test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      const childApprovalPartId = await childManager.addPart(childId, 'agents/child', childMessageId, {
        type: 'tool',
        tool: 'await_human',
        state: {
          status: 'pending',
          input: { prompt: 'Approve child?' },
          resumePayload: { kind: 'await_human', resumeToken: 'child-token' },
          suspendedAt: Date.UTC(2026, 4, 1),
        },
      } as any);

      const grandchildManager = new SessionManager();
      grandchildManager.setParentPath(childManager.getFullPath()!);
      const grandchildId = await grandchildManager.createSession({
        ...base,
        parentSessionID: childId,
        agent: { id: 'agents/grandchild', name: 'grandchild', isSubAgent: true },
      });
      await grandchildManager.setSessionCompleted(grandchildId, 'agents/grandchild');

      const stopped = await parentManager.stopSessionTree(parentId);

      expect(stopped.map((entry) => entry.sessionId)).toEqual([parentId, childId, grandchildId]);
      expect(stopped.map((entry) => entry.stopped)).toEqual([true, true, false]);

      const parent = await parentManager.findSession(parentId);
      const child = await parentManager.findSession(childId);
      const grandchild = await parentManager.findSession(grandchildId);
      expect(parent?.session.status).toBe('error');
      expect(parent?.session.error?.code).toBe('USER_STOPPED');
      expect(child?.session.status).toBe('error');
      expect(child?.session.error?.code).toBe('USER_STOPPED');
      expect(grandchild?.session.status).toBe('completed');

      const parentParts = await parentManager.getMessageParts(parentId, 'agents/parent', parentMessageId);
      const parentApproval = parentParts.find((part) => part.id === parentApprovalPartId) as any;
      expect(parentApproval?.state.status).toBe('error');
      expect(parentApproval?.state.error).toBe('Session stopped by user');
      expect(parentApproval?.state.metadata?.resumePayload?.resumeToken).toBe('parent-token');

      const childParts = await childManager.getMessageParts(childId, 'agents/child', childMessageId);
      const childApproval = childParts.find((part) => part.id === childApprovalPartId) as any;
      expect(childApproval?.state.status).toBe('error');
      expect(childApproval?.state.error).toBe('Session stopped by user');
      expect(childApproval?.state.metadata?.resumePayload?.resumeToken).toBe('child-token');

      const children = await parentManager.listChildSessions(parentId);
      expect(children.map((entry) => entry.session.id)).toEqual([childId]);
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('reading nested subagent sessions from a fresh manager', () => {
  // The serve worker answers session-view requests with a brand-new
  // SessionManager (no parentPath). Subagent sessions live nested under
  // `{parent}/subagent/...`, so the reader must resolve the real directory
  // rather than the computed top-level path. Regression for the subagent
  // session view rendering "No session events yet" while it was running.
  it('returns messages and parts for a subagent session', async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-nested-read-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const base = {
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      };
      const assistant = {
        system: [],
        modelID: 'demo:test',
        providerID: 'demo',
        mode: 'build',
        path: { cwd: projectRoot, root: projectRoot },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };

      const parentManager = new SessionManager();
      const parentId = await parentManager.createSession({
        ...base,
        agent: { id: 'agents/parent', name: 'parent', isSubAgent: false },
      });

      const childManager = new SessionManager();
      childManager.setParentPath(parentManager.getFullPath()!);
      const childId = await childManager.createSession({
        ...base,
        parentSessionID: parentId,
        agent: { id: 'agents/child', name: 'child', isSubAgent: true },
      });
      const childMessageId = await childManager.createMessage(childId, 'agents/child', {
        user: { prompt: { task: 'child task' } },
        assistant,
      });
      await childManager.addPart(childId, 'agents/child', childMessageId, {
        type: 'text',
        text: 'working on it',
        time: { start: Date.now(), end: Date.now() },
      } as any);

      const orphanChildManager = new SessionManager();
      const orphanChildId = await orphanChildManager.createSession({
        ...base,
        parentSessionID: parentId,
        agent: { id: 'agents/orphan-child', name: 'orphan child', isSubAgent: true },
      });

      // Fresh reader with no parentPath — mirrors the serve worker.
      const reader = new SessionManager();
      const parent = await reader.findSession(parentId);
      expect(parent?.session.id).toBe(parentId);
      expect(reader.getFullPath()).toBe(parentManager.getFullPath());

      const children = await reader.listChildSessions(parentId, parent!.path);
      expect(children.map((entry) => entry.session.id)).toEqual([childId, orphanChildId]);

      const found = await reader.findSession(childId);
      expect(found?.session.id).toBe(childId);

      const messages = await reader.getSessionMessages(childId, found!.agentId);
      expect(messages.map((message) => message.id)).toEqual([childMessageId]);

      const parts = await reader.getMessageParts(childId, found!.agentId, childMessageId);
      const text = parts.find((part) => part.type === 'text') as any;
      expect(text?.text).toBe('working on it');

      const primary = await reader.getPrimaryMessage(childId, found!.agentId);
      expect(primary?.id).toBe(childMessageId);

      await reader.setSessionCompleted(childId, found!.agentId);
      const updated = await reader.findSession(childId);
      expect(updated?.session.status).toBe('completed');
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
