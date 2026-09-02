import { describe, expect, it } from 'bun:test';
import render from 'preact-render-to-string';
import { LogEntry } from '../src/cli/serve/web/components/log-entry';
import type { ApprovalLogEntry, LogSubagentEvent, LogSubagentSession } from '../src/cli/serve/types';

function row(options: {
  id: string;
  name: string;
  href: string;
  createdAt: number;
  parentSessionId: string;
  breadcrumb: Array<{ sessionId: string; agentName: string }>;
  label?: string;
  judge?: boolean;
  events?: LogSubagentEvent[];
  children?: LogSubagentSession[];
}): LogSubagentSession {
  return {
    sessionId: options.id,
    parentSessionId: options.parentSessionId,
    agent: { id: `agents/${options.id}`, name: options.name },
    status: 'completed',
    displayStatus: 'completed',
    trigger: 'manual',
    createdAt: options.createdAt,
    updatedAt: options.createdAt + 65_000,
    durationMs: 65_000,
    command: `agentuse sessions show ${options.id} --all-search`,
    href: options.href,
    breadcrumb: options.breadcrumb,
    ...(options.judge && { kinds: ['judge'] as const, important: true }),
    ...(options.label && { label: options.label }),
    ...(options.events && { events: options.events }),
    ...(options.children && { children: options.children }),
  };
}

function renderEntry(session: LogSubagentSession): string {
  const entry: ApprovalLogEntry = {
    id: 'subagent-session-pipeline',
    type: 'subagent',
    title: 'Pipeline completed',
    time: session.createdAt,
    subagentSession: session,
  };
  return render(<LogEntry
    entry={entry}
    expanded={undefined}
    showActions={false}
    actionsDisabled={false}
    projectId="project"
    sessionId="manager"
    token={undefined}
    onToggle={() => {}}
    onAction={() => {}}
  />);
}

describe('nested descendant session rows', () => {
  it('labels a childless subagent widget as a call instead of a real session', () => {
    const html = renderEntry({
      sessionId: 'call-pr-1',
      agent: { id: 'pr', name: 'PR' },
      status: 'error',
      displayStatus: 'error',
      trigger: 'manual',
      createdAt: Date.UTC(2026, 8, 1, 17, 10),
      updatedAt: Date.UTC(2026, 8, 1, 17, 10),
      command: '',
      synthetic: true,
      errorMessage: 'All MCP servers failed to connect',
    });

    expect(html).toContain('class="subagent-event"');
    expect(html).toContain('call call-pr-1');
    expect(html).toContain('All MCP servers failed to connect');
    expect(html).not.toContain('Open subagent session');
  });

  it('renders Judge attempts as indented links with status, breadcrumb, timestamp, and duration', () => {
    const judge = row({
      id: 'judge-1',
      name: 'Newsletter Pipeline Gate',
      href: '/sessions/judge-1',
      createdAt: Date.UTC(2026, 7, 24, 15, 10),
      parentSessionId: 'pipeline',
      breadcrumb: [
        { sessionId: 'manager', agentName: 'Newsletter Manager' },
        { sessionId: 'pipeline', agentName: 'Newsletter Pipeline' },
      ],
      label: 'Judge attempt 1 of 2',
      judge: true,
    });
    const pipeline = row({
      id: 'pipeline',
      name: 'Newsletter Pipeline',
      href: '/sessions/pipeline',
      createdAt: Date.UTC(2026, 7, 24, 15, 8),
      parentSessionId: 'manager',
      breadcrumb: [{ sessionId: 'manager', agentName: 'Newsletter Manager' }],
      children: [judge],
    });

    const html = renderEntry(pipeline);
    expect(html).toContain('class="subagent-children"');
    expect(html).toContain('href="/sessions/pipeline"');
    expect(html).toContain('href="/sessions/judge-1"');
    expect(html).toContain('Judge attempt 1 of 2');
    expect(html).toContain('class="subagent-role judge">Judge</span>');
    expect(html).toContain('Newsletter Manager › Newsletter Pipeline');
    expect(html).toContain('1m 5s');
    expect(html.match(/data-session-id="pipeline"/g)).toHaveLength(1);
    expect(html.match(/data-session-id="judge-1"/g)).toHaveLength(1);
  });

  it('keeps the existing direct-child card when there are no nested descendants', () => {
    const pipeline = row({
      id: 'pipeline',
      name: 'Newsletter Pipeline',
      href: '/sessions/pipeline',
      createdAt: Date.UTC(2026, 7, 24, 15, 8),
      parentSessionId: 'manager',
      breadcrumb: [{ sessionId: 'manager', agentName: 'Newsletter Manager' }],
    });
    const html = renderEntry(pipeline);
    expect(html).toContain('href="/sessions/pipeline"');
    expect(html).toContain('Newsletter Pipeline');
    expect(html).not.toContain('subagent-children');
  });

  it('renders an inline Judge event linked to the owning Pipeline log without a fake session', () => {
    const event: LogSubagentEvent = {
      id: 'verify-event-pipeline-verify-1',
      sourceLogId: 'verify-1',
      type: 'verify',
      ownerSessionId: 'pipeline',
      depth: 2,
      breadcrumb: [
        { sessionId: 'manager', agentName: 'Newsletter Manager' },
        { sessionId: 'pipeline', agentName: 'Newsletter Pipeline' },
      ],
      verdict: 'fail',
      judge: 'openai:gpt-5',
      mode: 'inline',
      attempt: 0,
      maxAttempts: 2,
      attemptLabel: 'Attempt 1 of 2',
      time: Date.UTC(2026, 7, 24, 15, 10),
      critique: 'Missing citation',
      displayStatus: 'failed',
      href: '/sessions/pipeline#log-verify-1',
    };
    const pipeline = row({
      id: 'pipeline',
      name: 'Newsletter Pipeline',
      href: '/sessions/pipeline',
      createdAt: Date.UTC(2026, 7, 24, 15, 8),
      parentSessionId: 'manager',
      breadcrumb: [{ sessionId: 'manager', agentName: 'Newsletter Manager' }],
      events: [event],
    });

    const html = renderEntry(pipeline);
    expect(html).toContain('Inline criteria');
    expect(html).toContain('class="subagent-role judge">Judge</span>');
    expect(html).toContain('Attempt 1 of 2');
    expect(html).toContain('Newsletter Manager › Newsletter Pipeline');
    expect(html).toContain('Missing citation');
    expect(html).toContain('href="/sessions/pipeline#log-verify-1"');
    expect(html.match(/data-session-id=/g)).toHaveLength(1);
    expect(html).toContain('data-event-id="verify-event-pipeline-verify-1"');
  });

  it('renders the human comment as the transition between an earlier Judge and a revision', () => {
    const feedback: LogSubagentEvent = {
      id: 'reviewer-feedback-event-pipeline-gate-2',
      sourceLogId: 'gate-2',
      type: 'reviewer-feedback',
      ownerSessionId: 'pipeline',
      depth: 2,
      breadcrumb: [
        { sessionId: 'manager', agentName: 'Newsletter Manager' },
        { sessionId: 'pipeline', agentName: 'Newsletter Pipeline' },
      ],
      reviewer: 'web',
      comment: 'Not good ideas\nUse the Midlife ICP without a news reference',
      round: 1,
      roundLabel: 'Revision request 1',
      time: Date.UTC(2026, 7, 24, 15, 12),
      displayStatus: 'commented',
      href: '/sessions/pipeline#log-gate-2',
    };
    const pipeline = row({
      id: 'pipeline',
      name: 'Newsletter Pipeline',
      href: '/sessions/pipeline',
      createdAt: Date.UTC(2026, 7, 24, 15, 8),
      parentSessionId: 'manager',
      breadcrumb: [{ sessionId: 'manager', agentName: 'Newsletter Manager' }],
      label: 'Revising after reviewer feedback',
      events: [feedback],
    });
    pipeline.status = 'running';
    pipeline.displayStatus = 'revising';
    pipeline.phase = 'revising';

    const html = renderEntry(pipeline);
    expect(html).toContain('>revising</span>');
    expect(html).toContain('Revising after reviewer feedback');
    expect(html).toContain('Reviewer feedback');
    expect(html).toContain('class="subagent-role reviewer">Human</span>');
    expect(html).toContain('Revision request 1');
    expect(html).toContain('by web');
    expect(html).toContain('Not good ideas\nUse the Midlife ICP without a news reference');
    expect(html).toContain('href="/sessions/pipeline#log-gate-2"');
  });
});

describe('running subagent activity line', () => {
  it('shows the newest tool step and its step count on a running card', () => {
    const child = row({
      id: 'growth',
      name: 'X Growth Manager',
      href: '/sessions/growth',
      createdAt: Date.UTC(2026, 8, 2, 15, 44),
      parentSessionId: 'manager',
      breadcrumb: [{ sessionId: 'manager', agentName: 'Demo Manager' }],
    });
    child.status = 'running';
    child.displayStatus = 'running';
    delete child.durationMs;
    child.activity = {
      tool: 'bash',
      detail: 'birdc search "small live tests"',
      steps: 7,
      startedAt: Date.now() - 14_000,
      running: true,
    };

    const html = renderEntry(child);
    expect(html).toContain('subagent-activity is-running');
    expect(html).toContain('>now</span>');
    expect(html).toContain('>bash</code>');
    expect(html).toContain('birdc search &quot;small live tests&quot;');
    expect(html).toContain('step 7 · 14s');
  });
});

describe('delegated call expansion', () => {
  function toolEntry(overrides: Partial<ApprovalLogEntry>): ApprovalLogEntry {
    return {
      id: 'call-1',
      type: 'tool',
      tool: 'bash',
      status: 'running',
      title: 'bash',
      time: Date.UTC(2026, 8, 2, 15, 44),
      details: { input: '{"task":"a very long delegated task blob"}' },
      ...overrides,
    };
  }

  function renderTool(entry: ApprovalLogEntry): string {
    return render(<LogEntry
      entry={entry}
      expanded={undefined}
      showActions={false}
      actionsDisabled={false}
      projectId="project"
      sessionId="manager"
      token={undefined}
      onToggle={() => {}}
      onAction={() => {}}
    />);
  }

  it('opens a running ordinary tool so its live output is visible', () => {
    expect(renderTool(toolEntry({}))).toContain('aria-expanded="true"');
  });

  it('keeps a running subagent call closed, since the card above carries the live view', () => {
    expect(renderTool(toolEntry({ tool: 'subagent__research' }))).toContain('aria-expanded="false"');
  });
});
