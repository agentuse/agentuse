import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __testing } from '../src/cli/serve';
import { sessionViewToken, validateSessionToken } from '../src/utils/session-token';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

const suspendedApproval = {
  sessionId: 'session-1',
  sessionStatus: 'suspended',
  agent: {
    id: 'agents/review',
    name: 'Review agent',
    filePath: '/tmp/review.agentuse',
  },
  prompt: 'Approve the draft?',
  currentResumeToken: 'gate-token-1',
  decision: undefined,
  logs: [{
    id: 'part-1',
    type: 'tool',
    tool: 'await_human',
    status: 'pending',
    title: 'Pending for approval',
    details: { resumeToken: 'gate-token-1', prompt: 'Approve the draft?' },
  }],
};

const completedApproval = {
  sessionId: 'session-2',
  sessionStatus: 'completed',
  agent: {
    id: 'agents/review',
    name: 'Review agent',
    filePath: '/tmp/review.agentuse',
  },
  prompt: 'Approve the draft?',
  decision: { status: 'approve' },
  logs: [],
};

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

  it('does not exempt unrelated routes', () => {
    expect(__testing.isHeaderGateExemptRoute('/agents', false)).toBe(false);
    expect(__testing.isHeaderGateExemptRoute('/sessionsfoo', false)).toBe(false);
  });
});

describe('renderSessionPage canAct gating', () => {
  it('canAct=true reproduces the legacy approval page byte-for-byte', () => {
    const opts = { approval: suspendedApproval, token: 'sess-token', projectId: 'project-1' } as const;
    expect(__testing.renderSessionPage({ ...opts, canAct: true })).toBe(__testing.renderApprovalPage(opts));
  });

  it('shows the approve affordance for a suspended session when canAct', () => {
    const html = __testing.renderSessionPage({
      approval: suspendedApproval,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });
    expect(html).toContain('human approval requested');
    // pendingActionable is the server-injected flag the page initializes from;
    // the rendered comment dialog (id="comment-dialog", distinct from the JS's
    // getElementById('comment-dialog')) only exists when actionable.
    expect(html).toContain('let pendingActionable = true;');
    expect(html).toContain('id="comment-dialog"');
  });

  it('renders a suspended session as log-only when canAct is false', () => {
    const html = __testing.renderSessionPage({
      approval: suspendedApproval,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: false,
    });
    expect(html).toContain('let pendingActionable = false;');
    expect(html).not.toContain('id="comment-dialog"');
    // no approval affordance; the page falls back to the view-only eyebrow
    expect(html).not.toContain('human approval requested');
    expect(html).toContain('id="continue-panel" class="continue-panel" hidden');
    expect(html).toContain('session log');
  });

  it('renders a completed session as log-only when canAct is false', () => {
    const html = __testing.renderSessionPage({
      approval: completedApproval,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: false,
    });
    expect(html).toContain('id="continue-panel" class="continue-panel" hidden');
    expect(html).toContain('let pendingActionable = false;');
    expect(html).toContain('let continueActionable = false;');
  });

  it('sends the session token on decision/continue fetches', () => {
    const html = __testing.renderSessionPage({
      approval: suspendedApproval,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });
    expect(html).toContain("location.pathname + '/decision' + (token ? '?token=' + encodeURIComponent(token) : '')");
    expect(html).toContain("location.pathname + '/continue' + (token ? '?token=' + encodeURIComponent(token) : '')");
    expect(html).toContain("location.pathname + '/stop' + (token ? '?token=' + encodeURIComponent(token) : '')");
  });

  it('surfaces child subagent sessions with a direct inspect command', () => {
    const html = __testing.renderSessionPage({
      approval: {
        ...completedApproval,
        childSessions: [{
          sessionId: '01KTCBC4FJHBMXPKE0ZEXX8S6V',
          agent: { id: 'agents/research', name: 'Research subagent' },
          status: 'running',
          createdAt: Date.UTC(2026, 4, 1),
          updatedAt: Date.UTC(2026, 4, 1),
        }],
      },
      token: 'sess-token',
      projectId: 'project-1',
      childSessionToken: (id) => `tok-${id}`,
      canAct: false,
    });

    expect(html).toContain('subagents');
    expect(html).toContain('Research subagent');
    expect(html).toContain('01KTCBC4FJHBMXPKE0ZEXX8S6V');
    expect(html).toContain('href="/sessions/01KTCBC4FJHBMXPKE0ZEXX8S6V?token=tok-01KTCBC4FJHBMXPKE0ZEXX8S6V&amp;project=project-1"');
    expect(html).toContain('agentuse sessions show 01KTCBC4FJHB --all-search');
  });

  it('renders a stop control for active sessions', () => {
    const html = __testing.renderSessionPage({
      approval: {
        ...completedApproval,
        sessionId: 'session-running',
        sessionStatus: 'running',
      },
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });

    expect(html).toContain('id="stop-panel" class="stop-panel"');
    expect(html).toContain('Stop this session and any running subagents.');
    expect(html).toContain('id="stop-submit"');
  });

  it('labels stopped sessions as stopped instead of a generic error', () => {
    const html = __testing.renderSessionPage({
      approval: {
        ...completedApproval,
        sessionId: 'session-stopped',
        sessionStatus: 'error',
        errorCode: 'USER_STOPPED',
        errorMessage: 'Stopped from session UI',
      },
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });

    expect(html).toContain('<span class="status stopped">stopped</span>');
    expect(html).toContain('Stopped from session UI');
  });
});

describe('renderSessionsListPage', () => {
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

  it('links rows to the unified session page with a token', () => {
    const html = __testing.renderSessionsListPage({
      rows,
      errors: [],
      multiProject: false,
      sessionToken: (id) => `tok-${id}`,
    });
    expect(html).toContain('href="/sessions/sess-abc?token=tok-sess-abc"');
    expect(html).toContain('Review agent');
    expect(html).toContain('scheduled');
    expect(html).toContain('completed');
  });

  it('omits the token from links on local (empty token)', () => {
    const html = __testing.renderSessionsListPage({
      rows,
      errors: [],
      multiProject: false,
      sessionToken: () => '',
    });
    expect(html).toContain('href="/sessions/sess-abc"');
  });

  it('surfaces active filters and a clear link', () => {
    const html = __testing.renderSessionsListPage({
      rows,
      errors: [],
      multiProject: false,
      agentFilter: 'agents/review',
      triggerFilter: 'scheduled',
      statusFilter: 'completed',
      approvalFilter: 'completed',
      daysFilter: 'all',
      sessionToken: () => '',
    });
    expect(html).toContain('agents/review');
    expect(html).toContain('status <code>completed</code>');
    expect(html).toContain('trigger <code>scheduled</code>');
    expect(html).toContain('approval <code>completed</code>');
    expect(html).toContain('window <code>all</code>');
    expect(html).toContain('href="/sessions">clear');
  });

  it('renders session filter controls with the selected values', () => {
    const html = __testing.renderSessionsListPage({
      rows,
      errors: [],
      multiProject: false,
      agentFilter: 'agents/review',
      agentOptions: [
        { id: 'agents/review', name: 'Review agent' },
        { id: 'agents/research', name: 'Research agent' },
      ],
      triggerFilter: 'scheduled',
      statusFilter: 'error',
      approvalFilter: 'errored',
      daysFilter: '90d',
      sessionToken: () => '',
    });

    expect(html).toContain('<form class="filter-bar" method="get" action="/sessions">');
    expect(html).toContain('name="agent" value="agents/review" placeholder="Any agent" autocomplete="off" role="combobox"');
    expect(html).toContain('id="session-agent-options" class="agent-options" data-agent-options role="listbox" hidden');
    expect(html).toContain('data-agent-name="Review agent" data-agent-id="agents/review"');
    expect(html).toContain('data-agent-name="Research agent" data-agent-id="agents/research"');
    expect(html).toContain('<div class="agent-option-name">Review agent</div>');
    expect(html).not.toContain('agent-option-id');
    expect(html).not.toContain('<button type="submit">Apply</button>');
    expect(html).not.toContain('.filter-bar button,');
    expect(html).toContain('function filterOptions()');
    expect(html).toContain('function scheduleSubmit()');
    expect(html).toContain("form.requestSubmit");
    expect(html).toContain("event.key === 'Enter'");
    expect(html).toContain("select.addEventListener('change', submitFilters)");
    expect(html).toContain('<select name="window">');
    expect(html).toContain('<option value="1h">1 hour</option>');
    expect(html).toContain('<option value="6h">6 hours</option>');
    expect(html).toContain('<option value="24h">24 hours</option>');
    expect(html).toContain('<option value="error" selected>Error</option>');
    expect(html).toContain('<option value="scheduled" selected>Scheduled</option>');
    expect(html).toContain('<option value="errored" selected>Errored</option>');
    expect(html).toContain('<option value="90d" selected>90 days</option>');
  });

  it('matches the agent filter against partial agent names and ids', () => {
    const session = rows[0]!.session;

    expect(__testing.sessionMatchesAgentFilter(session, 'review')).toBe(true);
    expect(__testing.sessionMatchesAgentFilter(session, 'agents/rev')).toBe(true);
    expect(__testing.sessionMatchesAgentFilter(session, 'VIEW AG')).toBe(true);
    expect(__testing.sessionMatchesAgentFilter(session, 'research')).toBe(false);
  });

  it('shows an empty state and the sessions topbar tab', () => {
    const html = __testing.renderSessionsListPage({
      rows: [],
      errors: [],
      multiProject: false,
      sessionToken: () => '',
    });
    expect(html).toContain('No sessions yet.');
    expect(html).toContain('href="/sessions"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<option value="24h" selected>24 hours</option>');
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

      // Fresh reader with no parentPath — mirrors the serve worker.
      const reader = new SessionManager();
      const found = await reader.findSession(childId);
      expect(found?.session.id).toBe(childId);

      const messages = await reader.getSessionMessages(childId, found!.agentId);
      expect(messages.map((message) => message.id)).toEqual([childMessageId]);

      const parts = await reader.getMessageParts(childId, found!.agentId, childMessageId);
      const text = parts.find((part) => part.type === 'text') as any;
      expect(text?.text).toBe('working on it');

      const primary = await reader.getPrimaryMessage(childId, found!.agentId);
      expect(primary?.id).toBe(childMessageId);
    } finally {
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
