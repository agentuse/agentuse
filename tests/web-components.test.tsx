import { describe, expect, it } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { LogEntry } from '../src/cli/serve/web/components/log-entry';
import { Topbar } from '../src/cli/serve/web/components/topbar';
import { StoreTable, type StoreTableColumn } from '../src/cli/serve/web/components/store-table';
import { ContinuePanel } from '../src/cli/serve/web/components/continue-panel';
import { DecisionDialog } from '../src/cli/serve/web/components/comment-dialog';
import { escapeHtml, renderLogContentValue, renderMarkdownBlock } from '../src/cli/serve/web/lib/content-html';
import { parseChartSpec } from '../src/cli/serve/web/lib/chart-svg';
import { highlightJsonSource } from '../src/cli/serve/web/lib/json-highlight';
import { isDebugLog, latestReviewerComment, logEntrySignature } from '../src/cli/serve/web/lib/format';
import { hasActionableApproval, headerTokenUsage, tokenUsageMetaItems } from '../src/cli/serve/web/routes/session-detail';
import { FeedResponse, NewSinceLastVisit, SessionRowView } from '../src/cli/serve/web/routes/sessions-list';
import { labelFor, suspendedGateKinds } from '../src/cli/serve/web/hooks/use-live-home';
import type { AgentRow, ApprovalsListPayload, SessionRow } from '../src/cli/serve/web/lib/api';
import type { ApprovalLogEntry } from '../src/cli/serve/types';
import { term, termTitle } from '../src/cli/serve/web/lib/terms';
import { AgentGraphView } from '../src/cli/serve/web/components/agent-graph-view';
import { statusBadge, LearningsHeadline, TidyResultView } from '../src/cli/serve/web/components/learnings-panel';
import { TidyProgressView } from '../src/cli/serve/web/routes/learnings-tidy';
import { learningsTidyHref } from '../src/cli/serve/web/lib/links';
import type { LearningSummary, SessionLearning, TidyResult } from '../src/cli/serve/web/lib/api';

const noop = () => {};

describe('serve.terms display nouns', () => {
  const withTerms = (terms: Record<string, string>, fn: () => void) => {
    (globalThis as Record<string, unknown>).window = { __AGENTUSE_TERMS__: terms };
    try {
      fn();
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  };

  it('falls back to technical nouns without config (and without window)', () => {
    expect(term('project')).toBe('project');
    expect(term('project', 2)).toBe('projects');
    expect(termTitle('folder', 2)).toBe('Folders');
  });

  it('renders configured nouns with naive pluralization', () => {
    withTerms({ project: 'department' }, () => {
      expect(term('project')).toBe('department');
      expect(term('project', 6)).toBe('departments');
      expect(termTitle('project', 2)).toBe('Departments');
      expect(term('folder')).toBe('folder');
    });
  });

  it('honors an explicit singular|plural escape', () => {
    withTerms({ project: 'company|companies' }, () => {
      expect(term('project')).toBe('company');
      expect(term('project', 3)).toBe('companies');
      expect(termTitle('project', 3)).toBe('Companies');
    });
  });

  it('ignores blank configured values', () => {
    withTerms({ project: '   ' }, () => {
      expect(term('project', 2)).toBe('projects');
    });
  });
});

describe('Topbar navigation', () => {
  it('exposes Home as the active primary destination on the home screen', () => {
    const html = renderToString(<Topbar currentPage="home" />);

    expect(html).toContain('<a href="/" aria-current="page" class="nav-item active">home</a>');
    expect(html.indexOf('>home</a>')).toBeLessThan(html.indexOf('>agents</a>'));
  });

  it('keeps Home explicit while another primary destination is active', () => {
    const html = renderToString(<Topbar currentPage="sessions" />);

    expect(html).toContain('<a href="/" class="nav-item">home</a>');
    expect(html).toContain('<a href="/sessions" aria-current="page" class="nav-item active">sessions</a>');
  });
});

describe('Session feed response', () => {
  it('separates agent identity, run metadata, response, and action into feed regions', () => {
    const html = renderToString(
      <SessionRowView
        view="feed"
        multiProject={false}
        statusFilter=""
        triggerFilter=""
        agentFilter=""
        dismissed={false}
        onDiscard={noop}
        filterHref={(key, value) => `/sessions?${key}=${value}`}
        row={{
          sessionId: 'session-1',
          project: 'demo',
          agent: { id: 'agents/weekly-research', name: 'Weekly Research', description: 'Finds important signals' },
          status: 'completed',
          trigger: 'scheduled',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          finalResponse: '## Key signal\n\nThe market changed.',
        }}
      />
    );

    expect(html).toContain('role="article"');
    // j/k move focus card to card, so a feed card must be programmatically
    // focusable without joining the Tab order.
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('session-feed-header');
    expect(html).toContain('session-feed-avatar');
    expect(html).toContain('>WR</div>');
    expect(html).toContain('session-feed-byline');
    expect(html).toContain('session-feed-response');
    expect(html).toContain('session-feed-footer');
    expect(html).not.toContain('class="row-head"');
  });

  it('renders the final agent response as safe Markdown', () => {
    const html = renderToString(
      <FeedResponse
        status="completed"
        href="/sessions/session-1?project=demo"
        value={'**Shipped.**\n\n- First result\n- Second result\n\n<script>alert(1)</script>'}
      />
    );

    expect(html).toContain('Final response');
    expect(html).toContain('<strong>Shipped.</strong>');
    expect(html).toContain('<li>First result</li>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('collapses very long responses behind an accessible show-more control', () => {
    const html = renderToString(
      <FeedResponse
        status="completed"
        href="/sessions/session-1?project=demo"
        value={'A'.repeat(1_801)}
      />
    );

    expect(html).toContain('session-feed-content is-collapsed');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show more');
  });

  it('marks where the last visit ended without any per-session read state', () => {
    const html = renderToString(<NewSinceLastVisit count={3} />);

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="3 new since your last visit"');
    expect(html).toContain('3 new since your last visit');
  });

  it('explains when a running session has not produced an answer yet', () => {
    const html = renderToString(
      <FeedResponse
        status="running"
        href="/sessions/session-1?project=demo"
        value={undefined}
      />
    );

    expect(html).toContain('Latest response');
    expect(html).toContain('Agent is working');
    expect(html).toContain('View session details');
  });
});

function renderEntry(entry: ApprovalLogEntry, overrides: Partial<Parameters<typeof LogEntry>[0]> = {}): string {
  return renderToString(
    <LogEntry
      entry={entry}
      expanded={false}
      showActions={false}
      actionsDisabled={false}
      projectId={undefined}
      sessionId="session-1"
      token={undefined}
      onToggle={noop}
      onAction={noop}
      {...overrides}
    />
  );
}

describe('LogEntry component', () => {
  it('groups the timestamp, status marker, and title into one row header', () => {
    const html = renderEntry({
      id: 'tool-row-header',
      type: 'tool',
      tool: 'tools__filesystem_read',
      title: 'tools__filesystem_read completed',
      status: 'completed',
      time: Date.now(),
    });
    const headerStart = html.indexOf('<div class="log-head">');
    const bodyStart = html.indexOf('<div class="log-main">');
    const header = html.slice(headerStart, bodyStart);

    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(bodyStart).toBeGreaterThan(headerStart);
    expect(header).toContain('class="log-time"');
    expect(header).toContain('class="log-marker"');
    expect(header).toContain('class="log-title"');
    expect(header).toContain('filesystem_read');
  });

  it('renders a context compaction event with its summary, not expandable', () => {
    const html = renderEntry({
      id: 'log-c1',
      type: 'compaction',
      title: 'Context compacted',
      message: '66k → 8.2k tokens (−88%), at approval gate',
      time: Date.now(),
    });
    expect(html).toContain('Context compacted');
    expect(html).toContain('66k → 8.2k tokens');
    expect(html).toContain('data-log-type="compaction"');
    expect(html).toContain('⇲');
    // System event, not an expandable tool row.
    expect(html).not.toContain('expandable');
  });

  it('renders an operational log line with a level class, marker, and accessible name', () => {
    const html = renderEntry({
      id: 'log-op-1',
      type: 'log',
      level: 'warn',
      title: 'MCP server slow to respond',
      time: Date.now(),
    });
    expect(html).toContain('data-log-type="log"');
    expect(html).toContain('log-level-warn');
    expect(html).toContain('MCP server slow to respond');
    expect(html).toContain('▲'); // warn marker glyph
    expect(html).toContain('aria-label="warn log"'); // non-color cue for screen readers
    // A log line is not an expandable tool row.
    expect(html).not.toContain('expandable');
  });

  it('nests tool warnings under the tool row with a collapsed-visible badge', () => {
    const html = renderEntry(
      { id: 'tool-1', type: 'tool', tool: 'tools__bash', callId: 'call-abc', title: 'tools__bash completed', status: 'completed', time: Date.now() },
      {
        warnings: [
          { id: 'warn-1', type: 'log', level: 'warn', toolId: 'call-abc', title: 'tools__bash: window.MAX_ITEMS = 5; failed - // Extract posts from LinkedIn feed', time: Date.now() },
        ],
      }
    );
    // Badge advertises the nested warning even while the row is collapsed.
    expect(html).toContain('log-warn-badge');
    expect(html).toContain('⚠ 1');
    // The warning text is rendered inside the (collapsible) content, not as a sibling row.
    expect(html).toContain('log-warnings');
    expect(html).toContain('window.MAX_ITEMS = 5; failed');
  });

  it('renders no warning badge when a tool row has no warnings', () => {
    const html = renderEntry(
      { id: 'tool-2', type: 'tool', tool: 'tools__bash', callId: 'call-xyz', title: 'tools__bash completed', status: 'completed', time: Date.now() },
    );
    expect(html).not.toContain('log-warn-badge');
    expect(html).not.toContain('log-warnings');
  });

  it('renders a multi-line log with the first line as title and the rest as body', () => {
    const html = renderEntry({
      id: 'log-op-2',
      type: 'log',
      level: 'error',
      title: 'connection refused',
      message: 'at connect (net.js:1)\nat onError (mcp.ts:9)',
      time: Date.now(),
    });
    expect(html).toContain('log-level-error');
    expect(html).toContain('connection refused');
    expect(html).toContain('at onError (mcp.ts:9)');
    expect(html).toContain('✗'); // error marker glyph
  });

  it('renders tool input/output details', () => {
    const html = renderEntry({
      id: 'log-1',
      type: 'tool',
      tool: 'web_search',
      title: 'web_search',
      status: 'completed',
      time: Date.now(),
      details: { input: 'the input', output: 'the output' },
    });
    expect(html).toContain('Input');
    expect(html).toContain('the input');
    expect(html).toContain('Output');
    expect(html).toContain('expandable');
    expect(html).not.toContain(' expanded');
  });

  it('renders the model-step input, output, and cached usage in an expanded tool row', () => {
    const html = renderEntry({
      id: 'log-token-usage',
      type: 'tool',
      tool: 'tools__web_search',
      title: 'tools__web_search completed',
      status: 'completed',
      time: Date.now(),
      details: {
        input: 'the input',
        output: 'the output',
        tokenUsage: {
          input: 1_200,
          output: 90,
          cachedInput: 800,
          sharedCalls: 2,
        },
      },
    }, { expanded: true });

    expect(html).toContain('expanded');
    expect(html).toContain('tool-token-usage');
    expect(html).toContain('Model step token usage');
    expect(html).toContain('>input<');
    expect(html).toContain('>400<');
    expect(html).toContain('>output<');
    expect(html).toContain('>90<');
    expect(html).toContain('>cached<');
    expect(html).toContain('>+800<');
    expect(html).toContain('shared across 2 calls');
  });

  it('renders full tool output artifact links', () => {
    const html = renderEntry({
      id: 'log-1',
      type: 'tool',
      tool: 'tools__bash',
      title: 'tools__bash completed',
      status: 'completed',
      time: Date.now(),
      details: {
        output: 'truncated output',
        toolOutputArtifact: {
          path: 'session-1-agents-review/message-1/artifact/tool-output-tools__bash.txt',
          bytes: 2048,
        },
      },
    }, {
      token: 'tok-1',
    });
    expect(html).toContain('Full output');
    expect(html).toContain('/sessions/session-1/tool-artifacts/session-1-agents-review/message-1/artifact/tool-output-tools__bash.txt?token=tok-1');
    expect(html).toContain('2 KB');
  });

  it('auto-expands running tool entries', () => {
    const html = renderEntry({
      id: 'log-1',
      type: 'tool',
      title: 'web_search',
      status: 'running',
      details: { input: 'x' },
    });
    expect(html).toContain('expanded');
    expect(html).toContain('log-spinner');
  });

  it('renders the approval card with actions for the pending gate', () => {
    const html = renderEntry({
      id: 'log-2',
      type: 'approval',
      title: 'Approval requested',
      status: 'pending',
      details: {
        resumeToken: 'tok-1',
        prompt: 'Ship **it**?',
        draft: '# Title\n\n- a\n- b',
        risk: 'Sends an email',
      },
    }, { showActions: true });
    expect(html).toContain('approval-card');
    expect(html).toContain('approval-question');
    expect(html).toContain('<strong>it</strong>');
    expect(html).toContain('Risk / consequence');
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
    expect(html).toContain('Comment');
  });

  it('renders option-scoped business content with its command de-emphasized in the selectable option', () => {
    const html = renderEntry({
      id: 'log-structured',
      type: 'approval',
      title: 'Approval requested',
      status: 'pending',
      details: {
        resumeToken: 'tok-2',
        prompt: 'Post this comment?',
        reference: {
          label: 'Replying to',
          author: 'Alexandra Griffon',
          url: 'https://linkedin.com/feed/update/x',
          excerpt: 'The economy did not contract, it reorganized.',
        },
        changes: [
          {
            label: 'Post reply A',
            content: 'birdc reply 1 "Context cost is only half the problem."',
            displayContent: 'Context cost is only half the problem.',
            optionId: 'a',
          },
          {
            label: 'Post reply B',
            content: 'birdc reply 1 "The electricity comparison is the right one."',
            displayContent: 'The electricity comparison is the right one.',
            optionId: 'b',
          },
          { content: 'Like the post' },
        ],
        options: [
          { id: 'a', label: 'Candidate A', description: 'Precise correction' },
          { id: 'b', label: 'Candidate B', description: 'Grounded example' },
        ],
        draft: 'Why this post: rationale lives here',
        context: 'background detail',
      },
    }, { showActions: true });

    expect(html).toContain('On approval');
    expect(html).toContain('approval-change');
    expect(html).toContain('approval-option-action');
    expect(html).toContain('approval-command-detail');
    expect(html).toContain('approval-command-content');
    expect(html).toContain('The electricity comparison is the right one.');
    expect(html).toContain('birdc reply 1 &quot;The electricity comparison is the right one.&quot;');
    expect(html).toContain('Action 1');
    expect(html).toContain('Replying to');
    expect(html).toContain('Alexandra Griffon');
    expect(html).toContain('approval-reference-quote');
    // Pick gates keep supporting detail readable above the selectable content.
    expect(html).toContain('approval-primary');
    expect(html).not.toContain('<summary>Draft</summary>');
    // Context also starts collapsed so the change boxes stay the focal point.
    expect(html).not.toContain('approval-context-open');
    // A character count says nothing about whether a reply is any good, and it
    // competed with the content for the reviewer's attention. Copy stays.
    expect(html).not.toContain('chars');
    expect(html).toContain('approval-copy');
  });

  const pickGate = (): ApprovalLogEntry => ({
    id: 'log-pick',
    type: 'approval',
    title: 'Approval requested',
    status: 'pending',
    details: {
      resumeToken: 'tok-pick',
      prompt: 'Which reply?',
      summary: 'All three agree with the author and differ only in the turn they take.',
      options: [
        { id: 'a', label: 'Candidate A', description: 'Diagnostic' },
        { id: 'b', label: 'Candidate B', description: 'Prescriptive' },
      ],
      changes: [
        { content: 'birdc reply 1 "A"', displayContent: 'A text', optionId: 'a' },
        { content: 'birdc reply 1 "B"', displayContent: 'B text', optionId: 'b' },
      ],
    },
  });

  it('withholds approve on a pick gate until the reviewer actually picks', () => {
    // No option carries `recommended` and nothing is selected: the agent handed
    // the call to the reviewer, so approve has nothing to commit to.
    const html = renderEntry(pickGate(), { showActions: true, onSelectChoice: noop });

    expect(html).toContain('log-actions-awaiting-pick');
    expect(html).toContain('Pick an option above to approve');
    expect(html).toContain('<button disabled title="Pick one of the options above first"');
    // Reject and comment are still valid answers to "which of these?".
    expect(html).toContain('<button class="danger">Reject');
    expect(html).toContain('<button>Comment');
    // Nothing is emphasized, so the card never implies a pick that was not made.
    expect(html).toContain('approval-option interactive');
    expect(html).not.toContain('approval-option interactive selected');
    // And the button must not name a candidate it is not committing to.
    expect(html).not.toContain('approve-choice-label');
  });

  it('enables approve and names the pick once a candidate is selected', () => {
    const html = renderEntry(pickGate(), { showActions: true, selectedChoice: 'b', onSelectChoice: noop });

    expect(html).not.toContain('log-actions-awaiting-pick');
    expect(html).not.toContain('Pick one of the options above first');
    expect(html).toContain('<button class="primary">Approve<span class="approve-choice-label">');
    expect(html).toContain('Candidate B');
    expect(html).toContain('approval-option interactive selected');
  });

  it('collapses the summary on a pick gate but leaves it open on a plain gate', () => {
    // The per-option descriptions already carry what separates the alternatives,
    // so the summary starts collapsed there.
    const pick = renderEntry(pickGate(), { showActions: true });
    expect(pick).toContain('<summary>Why this request</summary>');
    expect(pick).toContain('approval-summary-collapsed');

    // On a plain yes/no gate nothing else explains the ask, so it stays open.
    const plain = renderEntry({
      id: 'log-plain',
      type: 'approval',
      title: 'Approval requested',
      status: 'pending',
      details: {
        resumeToken: 'tok-plain',
        prompt: 'Send this?',
        summary: 'Third follow-up, shortened after the reviewer trimmed the last one.',
        changes: [{ content: 'birdc reply 1 "ok"', displayContent: 'ok' }],
      },
    }, { showActions: true });
    expect(plain).not.toContain('approval-summary-collapsed');
    expect(plain).toContain('approval-section-title">Why this request');
  });

  it('renders inline artifact previews for image, html, and pdf artifacts', () => {
    const html = renderEntry({
      id: 'log-artifacts',
      type: 'approval',
      title: 'Approval requested',
      status: 'pending',
      details: {
        resumeToken: 'tok-3',
        prompt: 'Approve?',
        artifactPaths: ['shots/screen.png', 'reports/report.html', 'notes/notes.txt'],
      },
    }, { showActions: true });

    expect(html).toContain('artifact-preview-img');
    expect(html).toContain('artifact-preview-frame');
    expect(html).toContain('sandbox');
    // Non-previewable files keep only the open tile.
    expect(html).toContain('notes.txt');
  });

  it('renders resolved approval details after the resume token is removed', () => {
    const html = renderEntry({
      id: 'log-approved',
      type: 'tool',
      tool: 'await_human',
      title: 'Approved',
      status: 'completed',
      details: {
        prompt: 'Approve posting this?',
        draft: 'The approved draft',
        risk: 'External action',
        decisionStatus: 'approved',
      },
    });

    expect(html).toContain('approval-card');
    expect(html).toContain('Approve posting this?');
    expect(html).toContain('The approved draft');
    expect(html).toContain('External action');
    expect(html).toContain('Decision');
    expect(html).toContain('approved');
    expect(html).not.toContain('expandable');
  });

  it('escapes hostile log content', () => {
    const html = renderEntry({
      id: 'log-3',
      type: 'text',
      title: '<script>alert(1)</script>',
      status: 'completed',
      message: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
  });

  it('wraps assistant content in block containers', () => {
    const html = renderEntry({
      id: 'log-4',
      type: 'text',
      title: 'Assistant response',
      status: 'completed',
      message: '# Summary\n\nDone.',
    });
    expect(html).toContain('<div class="log-main">');
    expect(html).toContain('<div class="log-content">');
    expect(html).toContain('<div class="content-render">');
    expect(html).toContain('<div class="content-markdown">');
  });

  const bashCall = (status: string, details: NonNullable<ApprovalLogEntry['details']>): ApprovalLogEntry => ({
    id: 'tool-live',
    type: 'tool',
    tool: 'tools__bash',
    title: `tools__bash ${status}`,
    status,
    details,
  });

  it('opens a running tool row by default and closes it once it completes', () => {
    const running = renderEntry(bashCall('running', { input: '{ "command": "pnpm run deploy" }' }), { expanded: undefined });
    const completed = renderEntry(bashCall('completed', { input: '{ "command": "pnpm run deploy" }', output: 'done' }), { expanded: undefined });

    expect(running).toContain('aria-expanded="true"');
    // Untouched rows tidy themselves up rather than leaving a finished
    // command's output wedged open in the stream.
    expect(completed).toContain('aria-expanded="false"');
  });

  it('lets the reviewer override the default in both directions', () => {
    const collapsedWhileRunning = renderEntry(bashCall('running', { input: '{}' }), { expanded: false });
    const expandedAfterFinish = renderEntry(bashCall('completed', { input: '{}', output: 'done' }), { expanded: true });

    expect(collapsedWhileRunning).toContain('aria-expanded="false"');
    expect(expandedAfterFinish).toContain('aria-expanded="true"');
  });

  it('renders a live output tail for a running tool call', () => {
    const html = renderEntry(
      bashCall('running', { input: '{}', liveOutput: '[12/60] compiling module-12.ts\n' }),
      { expanded: undefined }
    );

    expect(html).toContain('log-detail-live');
    expect(html).toContain('class="live-tag"');
    expect(html).toContain('<pre class="live-output"');
    expect(html).toContain('[12/60] compiling module-12.ts');
  });
});

describe('StoreTable component', () => {
  interface Row { name: string; updated: number; }
  const columns: Array<StoreTableColumn<Row>> = [
    { key: 'name', label: 'Name', sortValue: (r) => r.name, render: (r) => r.name },
    { key: 'updated', label: 'Updated', type: 'number', sortValue: (r) => r.updated, render: (r) => String(r.updated) },
  ];
  const rows: Row[] = [
    { name: 'alpha', updated: 1 },
    { name: 'beta', updated: 3 },
    { name: 'gamma', updated: 2 },
  ];

  it('sorts by the default key descending and sets aria-sort', () => {
    const html = renderToString(
      <StoreTable columns={columns} rows={rows} defaultSortKey="updated" defaultSortDirection="desc" rowKey={(r) => r.name} />
    );
    expect(html).toContain('aria-sort="descending"');
    const order = ['beta', 'gamma', 'alpha'];
    let cursor = -1;
    for (const name of order) {
      const index = html.indexOf(`>${name}</td>`);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });
});

describe('ContinuePanel component', () => {
  it('is hidden when not actionable', () => {
    const html = renderToString(<ContinuePanel hidden disabled onSubmit={noop} />);
    expect(html).toContain('hidden');
  });
  it('shows the resume affordances when actionable', () => {
    const html = renderToString(<ContinuePanel hidden={false} disabled={false} onSubmit={noop} />);
    expect(html).not.toContain('hidden');
    expect(html).toContain('resume session');
    expect(html).toContain('Resume session');
  });
});

describe('DecisionDialog component', () => {
  it('renders comment mode as a required feedback action', () => {
    const html = renderToString(<DecisionDialog open mode="comment" onSubmit={noop} onClose={noop} />);
    expect(html).toContain('leave a comment');
    expect(html).toContain('explain your decision');
    expect(html).toContain('Send comment');
    expect(html).not.toContain('Remember this comment as a future instruction');
  });

  it('renders the manual learning affordance when allowed', () => {
    const html = renderToString(<DecisionDialog open mode="comment" allowRemember onSubmit={noop} onClose={noop} />);
    expect(html).toContain('Remember this comment as a future instruction');
  });

  it('renders reject mode with optional reason copy', () => {
    const html = renderToString(<DecisionDialog open mode="reject" onSubmit={noop} onClose={noop} />);
    expect(html).toContain('reject this request?');
    expect(html).toContain('configured rejected-state updates');
    expect(html).toContain('optional: which part is wrong is enough');
    expect(html).toContain('>Reject</button>');
    expect(html).not.toContain('Remember this comment as a future instruction');
  });
});

describe('SessionDetail header', () => {
  it('does not keep approval controls actionable once a decision is resuming', () => {
    const header = {
      sessionId: 'session-1',
      sessionStatus: 'suspended',
      agent: { id: 'agent-1', name: 'Agent' },
      currentResumeToken: 'tok-1',
    };

    expect(hasActionableApproval('waiting', header)).toBe(true);
    expect(hasActionableApproval('resuming', header)).toBe(false);
    expect(hasActionableApproval('continuing', header)).toBe(false);
    expect(hasActionableApproval('completed', { ...header, sessionStatus: 'completed' })).toBe(false);
  });

  it('shows token usage before a session completes', () => {
    const tokenUsage = { input: 1200, cachedInput: 900, output: 80 };
    expect(headerTokenUsage({
      sessionStatus: 'suspended',
      tokenUsage,
    })).toBe(tokenUsage);
  });

  it('leads with % context left and a blended spend, cached shown as a bonus', () => {
    const items = tokenUsageMetaItems({
      input: 3_115_688,
      cachedInput: 2_629_120,
      output: 5_996,
      context: {
        activeTokens: 75_992,
        contextLimit: 922_000,
        usagePercentage: 8.241,
        compacted: false,
        compactions: 0,
        updatedAt: 1,
      },
    });

    expect(items).toMatchObject([
      { label: 'context used', value: '91.8% left', title: '75,992 / 922,000' },
      { label: 'input', value: '486,568' },
      { label: 'output', value: '5,996' },
      { label: 'cached', value: '+2,629,120' },
    ]);
  });

  it('omits the cached bonus when nothing was cached', () => {
    const items = tokenUsageMetaItems({
      input: 143_366,
      cachedInput: 0,
      output: 211,
    });

    expect(items).toMatchObject([
      { label: 'input', value: '143,366' },
      { label: 'output', value: '211' },
    ]);
  });

  it('does not present absent provider usage as zero tokens', () => {
    const items = tokenUsageMetaItems({
      input: 0,
      cachedInput: 0,
      output: 0,
      context: {
        activeTokens: 3_596,
        contextLimit: 922_000,
        usagePercentage: 0.3900216919739696,
        compacted: false,
        compactions: 0,
        updatedAt: 1,
      },
    });

    expect(items).toMatchObject([
      { label: 'context used', value: '99.6% left', title: '3,596 / 922,000' },
      { label: 'provider usage', value: 'not reported yet' },
    ]);
  });
});

describe('content-html', () => {
  it('escapes html in all paths', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    expect(renderLogContentValue('<script>x</script>')).not.toContain('<script>');
    expect(renderMarkdownBlock('# Hi <script>x</script>')).not.toContain('<script>x');
  });

  it('renders markdown structure', () => {
    const html = renderMarkdownBlock('# Title\n\n- one\n- two\n\n```js\ncode()\n```');
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('data-language="js"');
    expect(html).toContain('code()');
  });

  it('renders nested lists with real nesting', () => {
    const html = renderMarkdownBlock([
      '- Scope:',
      '  - Only handled ticket `#301088`',
      '  - Did not fetch mailbox',
      '- What changed:',
      '  - Reply states:',
      '    - no completed cancellation found',
      '    - refund actions were completed',
      '- Next:',
    ].join('\n'));
    expect(html).toContain('<li>Scope:<ul><li>Only handled ticket <code>#301088</code></li><li>Did not fetch mailbox</li></ul></li>');
    expect(html).toContain('<li>Reply states:<ul><li>no completed cancellation found</li><li>refund actions were completed</li></ul></li>');
    expect(html).toContain('<li>Next:</li></ul>');
    // Top level + Scope + What changed + Reply states; deep dedent adds no stray list.
    expect(html.match(/<ul>/g)?.length).toBe(4);
  });

  it('renders ordered lists nested under unordered items', () => {
    const html = renderMarkdownBlock([
      '- Steps:',
      '  1. first',
      '  2. second',
      '- Done',
    ].join('\n'));
    expect(html).toContain('<li>Steps:<ol><li>first</li><li>second</li></ol></li>');
    expect(html).toContain('<li>Done</li></ul>');
  });

  it('renders common assistant markdown beyond flat lists', () => {
    const html = renderMarkdownBlock([
      'Result',
      '------',
      '',
      '| Area | Status |',
      '| --- | --- |',
      '| UI | **fixed** |',
      '',
      '---',
      '',
      'Tail',
    ].join('\n'));
    expect(html).toContain('<h3>Result</h3>');
    expect(html).toContain('<div class="content-table-scroll" tabindex="0" role="group" aria-label="Table"><table>');
    expect(html).toContain('</table></div>');
    expect(html).toContain('<th>Area</th>');
    expect(html).toContain('<td><strong>fixed</strong></td>');
    expect(html).toContain('<hr>');
  });

  it('renders single-asterisk emphasis without touching inline code', () => {
    const html = renderMarkdownBlock([
      ':money_with_wings: *LifeHack Paid New Customers, last 7 days*: 1 new paid customer',
      '',
      '*Window:* 2026-06-10T16:08:27Z to 2026-06-17T16:08:27Z',
      '*Confidence:* high 1, medium 0, low 0',
      '',
      '- **Stripe unavailable:** `STRIPE_SECRET_KEY` not found in any skill `.env` file',
    ].join('\n'));
    expect(html).toContain('<em>LifeHack Paid New Customers, last 7 days</em>');
    expect(html).toContain('<em>Window:</em>');
    expect(html).toContain('<em>Confidence:</em>');
    expect(html).toContain('<strong>Stripe unavailable:</strong>');
    expect(html).toContain('<code>STRIPE_SECRET_KEY</code>');
    expect(html).toContain('<code>.env</code>');
  });

  it('renders agentuse:chart fences as inline SVG charts', () => {
    const block = [
      'Here is the funnel:',
      '',
      '```agentuse:chart',
      JSON.stringify({
        type: 'bar',
        title: 'Signups by day',
        categories: ['Mon', 'Tue'],
        series: [{ name: 'Trials', values: [12, 18] }, { name: 'Paid', values: [3, 5] }],
        unit: '',
      }),
      '```',
    ].join('\n');
    const html = renderMarkdownBlock(block);
    expect(html).toContain('<figure class="au-chart" data-chart-type="bar">');
    expect(html).toContain('Signups by day');
    expect(html).toContain('au-chart-legend');
    expect(html).toContain('--series-color: var(--chart-2)');
    expect(html).toContain('<title>Tue · Paid: 5</title>');
    expect(html).toContain('au-chart-data');
    expect(html).not.toContain('content-code');
  });

  it('renders line charts with per-point markers and end labels', () => {
    const html = renderMarkdownBlock([
      '```agentuse:chart',
      JSON.stringify({
        type: 'line',
        title: 'Latency',
        unit: 'ms',
        categories: ['a', 'b', 'c'],
        series: [{ name: 'p50', values: [10, 12, 11] }, { name: 'p95', values: [40, 55, 43] }],
      }),
      '```',
    ].join('\n'));
    expect(html).toContain('data-chart-type="line"');
    expect(html).toContain('au-chart-line');
    expect(html).toContain('<title>b · p95: 55ms</title>');
    expect(html).toContain('au-chart-series-label');
  });

  it('renders LLM near-miss payloads: data alias for values, missing title', () => {
    // Verbatim shape from session 01KXF536PEBAP40M9Z1E67NBV7, where sonnet
    // guessed the chart.js convention and the chart silently degraded.
    const html = renderMarkdownBlock([
      '```agentuse:chart',
      '{"type":"bar","categories":["Subscribed","Onboarded","Northstar","Active"],"series":[{"name":"Users","data":[2,2,1,1]}]}',
      '```',
    ].join('\n'));
    expect(html).toContain('<figure class="au-chart" data-chart-type="bar">');
    expect(html).toContain('<title>Northstar · Users: 1</title>');
    expect(html).not.toContain('au-chart-title');
    // No title, so the legend must carry the series identity even for one series.
    expect(html).toContain('au-chart-legend');
  });

  it('falls back to a code block for invalid chart payloads', () => {
    const invalid = [
      '```agentuse:chart',
      '{"type": "pie", "title": "Nope", "categories": ["a"], "series": [{"name": "x", "values": [1]}]}',
      '```',
    ].join('\n');
    const html = renderMarkdownBlock(invalid);
    expect(html).not.toContain('au-chart');
    expect(html).toContain('content-code');
    expect(html).toContain('data-language="agentuse:chart"');

    const malformed = renderMarkdownBlock('```agentuse:chart\nnot json\n```');
    expect(malformed).toContain('content-code');
    expect(malformed).toContain('not json');
  });

  it('escapes chart labels and rejects oversized specs', () => {
    const html = renderMarkdownBlock([
      '```agentuse:chart',
      JSON.stringify({
        type: 'bar',
        title: '<img src=x onerror=alert(1)>',
        categories: ['<b>day</b>'],
        series: [{ name: '<script>', values: [1] }],
      }),
      '```',
    ].join('\n'));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');

    expect(parseChartSpec(JSON.stringify({
      type: 'bar',
      title: 'too many series',
      categories: ['a'],
      series: Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [1] })),
    }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({
      type: 'bar',
      title: 'length mismatch',
      categories: ['a', 'b'],
      series: [{ name: 's', values: [1] }],
    }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({
      type: 'bar',
      title: 'non-finite',
      categories: ['a'],
      series: [{ name: 's', values: ['1'] }],
    }))).toBeNull();
  });

  it('renders smart JSON blocks for readable strings', () => {
    const html = renderLogContentValue(JSON.stringify({ note: 'line one\nline two', count: 2 }));
    expect(html).toContain('json-object-block');
    expect(html).toContain('json-field-key');
    expect(html).toContain('line one');
  });

  it('syntax-highlights compact JSON blocks', () => {
    const html = renderLogContentValue(JSON.stringify({ name: 'x', count: 2, done: true, gone: null }));
    expect(html).toContain('<span class="json-key">&quot;name&quot;</span>');
    expect(html).toContain('<span class="json-string">&quot;x&quot;</span>');
    expect(html).toContain('<span class="json-number">2</span>');
    expect(html).toContain('<span class="json-literal">true</span>');
    expect(html).toContain('<span class="json-literal">null</span>');
  });

  it('syntax-highlights fenced json code blocks only when they parse', () => {
    const valid = renderMarkdownBlock('```json\n{"a": 1}\n```');
    expect(valid).toContain('<span class="json-key">&quot;a&quot;</span>');
    expect(valid).toContain('<span class="json-number">1</span>');
    const invalid = renderMarkdownBlock('```json\n{a: 1,} // nope\n```');
    expect(invalid).not.toContain('json-key');
    const otherLang = renderMarkdownBlock('```js\nconst a = {"b": 1}\n```');
    expect(otherLang).not.toContain('json-key');
  });
});

describe('json-highlight', () => {
  it('classifies keys, strings, numbers, and literals separately', () => {
    const html = highlightJsonSource('{\n  "key": "true",\n  "n": -1.5e3,\n  "ok": false\n}');
    expect(html).toContain('<span class="json-key">&quot;key&quot;</span>:');
    expect(html).toContain('<span class="json-string">&quot;true&quot;</span>');
    expect(html).toContain('<span class="json-number">-1.5e3</span>');
    expect(html).toContain('<span class="json-literal">false</span>');
  });

  it('escapes html inside tokens and keeps escaped quotes in one string', () => {
    const html = highlightJsonSource(JSON.stringify({ '<b>': 'say \\"<i>hi</i>\\"' }, null, 2));
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html.match(/json-string/g)?.length).toBe(1);
  });
});

describe('format helpers', () => {
  it('latestReviewerComment finds the most recent decision comment', () => {
    const logs: ApprovalLogEntry[] = [
      { id: '1', type: 'approval', title: 'gate 1', details: { decisionComment: 'first', decisionReviewer: 'a' } },
      { id: '2', type: 'tool', title: 'tool' },
      { id: '3', type: 'approval', title: 'gate 2', details: { decisionComment: 'second', decisionReviewer: 'b' } },
    ];
    expect(latestReviewerComment(logs)).toEqual({ comment: 'second', reviewer: 'b' });
    expect(latestReviewerComment([])).toBeUndefined();
  });

  it('logEntrySignature changes when content changes', () => {
    const entry: ApprovalLogEntry = { id: '1', type: 'tool', title: 't', status: 'pending' };
    const same = logEntrySignature({ ...entry });
    expect(logEntrySignature(entry)).toBe(same);
    expect(logEntrySignature({ ...entry, status: 'completed' })).not.toBe(same);
    expect(logEntrySignature({ ...entry, details: { output: 'x' } })).not.toBe(same);
  });

  it('logEntrySignature distinguishes log entries by level', () => {
    const entry: ApprovalLogEntry = { id: '1', type: 'log', level: 'info', title: 'x' };
    expect(logEntrySignature(entry)).not.toBe(logEntrySignature({ ...entry, level: 'warn' }));
  });

  it('isDebugLog matches only debug-level log entries', () => {
    expect(isDebugLog({ id: '1', type: 'log', level: 'debug', title: 'x' })).toBe(true);
    expect(isDebugLog({ id: '2', type: 'log', level: 'info', title: 'x' })).toBe(false);
    expect(isDebugLog({ id: '3', type: 'tool', title: 'x' })).toBe(false);
  });
});

describe('Home activity feed labels', () => {
  const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
    sessionId: 'root-1',
    project: 'demo',
    agent: { id: 'agents/manager', name: 'Manager' },
    status: 'suspended',
    trigger: 'manual',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
  const approvalRow = (sessionId: string, errorCode?: string) =>
    ({ sessionId, project: 'demo', ...(errorCode && { errorCode }) }) as ApprovalsListPayload['buckets']['pending'][number];
  const payload = (buckets: { pending?: string[]; expired?: string[]; orphaned?: string[] }): ApprovalsListPayload => ({
    success: true,
    multiProject: false,
    approvals: [],
    buckets: {
      pending: (buckets.pending ?? []).map((id) => approvalRow(id)),
      completed: [],
      expired: [
        ...(buckets.expired ?? []).map((id) => approvalRow(id)),
        // A stranded cascade ships in the same wire bucket as an expired gate.
        ...(buckets.orphaned ?? []).map((id) => approvalRow(id, 'CASCADE_ORPHANED')),
      ],
    },
    window: { days: 30 },
    errors: [],
  });

  it('labels a suspended session awaiting approval only while its gate is pending', () => {
    const gates = suspendedGateKinds(payload({ pending: ['root-1'] }));
    expect(labelFor(row(), false, gates)).toBe('awaiting approval');
  });

  it('labels a suspended root with a decided cascade gate as resuming, not awaiting approval', () => {
    // A manager parked on subagent_wait after its leaf gate was approved has no
    // pending approval: the leaf is running the work forward.
    const gates = suspendedGateKinds(payload({ pending: [] }));
    expect(labelFor(row(), false, gates)).toBe('resuming');
  });

  it('labels an expired gate distinctly', () => {
    const gates = suspendedGateKinds(payload({ expired: ['root-1'] }));
    expect(labelFor(row(), false, gates)).toBe('approval expired');
  });

  it('labels a manager stranded on an ended sub-agent as dead, not expired or resuming', () => {
    // The run can never be carried forward: the child it is parked on has ended.
    // "resuming" (the pre-fix label) read as progress and hid it indefinitely.
    const gates = suspendedGateKinds(payload({ orphaned: ['root-1'] }));
    expect(labelFor(row(), false, gates)).toBe('subagent ended');
  });

  it('keeps the awaiting-approval default until the approvals snapshot loads', () => {
    expect(labelFor(row(), false, suspendedGateKinds(null))).toBe('awaiting approval');
  });

  it('leaves non-suspended labels untouched', () => {
    const gates = suspendedGateKinds(payload({}));
    expect(labelFor(row({ status: 'running' }), true, gates)).toBe('started');
    expect(labelFor(row({ status: 'completed' }), false, gates)).toBe('completed');
  });
});

describe('AgentGraphView filtering', () => {
  const agent = (partial: Partial<AgentRow> & { path: string }): AgentRow => ({
    projectId: 'demo',
    runPath: partial.path,
    name: partial.path.split('/').pop()!.replace(/\.agentuse$/, ''),
    model: 'anthropic:claude-sonnet-4-0',
    ...partial,
  });
  const agents = [
    agent({ path: 'agents/news/manager.agentuse', subagents: ['agents/news/writer.agentuse'] }),
    agent({ path: 'agents/news/writer.agentuse' }),
    agent({ path: 'agents/ops/deploy.agentuse', subagents: ['agents/ops/verify.agentuse'] }),
    agent({ path: 'agents/ops/verify.agentuse' }),
    agent({ path: 'agents/solo.agentuse' }),
  ];

  it('renders every cluster and standalone card with no filter', () => {
    const html = renderToString(<AgentGraphView agents={agents} query="" />);
    expect(html).toContain('>manager<');
    expect(html).toContain('>deploy<');
    expect(html).toContain('>solo<');
  });

  it('hides clusters with no matching agent and keeps context inside matching ones', () => {
    const html = renderToString(<AgentGraphView agents={agents} query="writer" />);
    // The matching tile survives whole: its non-matching nodes stay (dimmed) so
    // the edges still read.
    expect(html).toContain('>manager<');
    expect(html).toContain('>writer<');
    expect(html).toContain('agent-graph-node entry dim');
    // The unrelated DAG and the unrelated standalone card are gone entirely.
    expect(html).not.toContain('>deploy<');
    expect(html).not.toContain('>verify<');
    expect(html).not.toContain('>solo<');
  });

  it('does not let a borrowed shared agent keep unrelated clusters on screen', () => {
    // `judge` is copied into both fleets; its description names news, which must
    // not drag the ops DAG along.
    const shared = [
      agent({ path: 'agents/news/manager.agentuse', subagents: ['agents/shared/judge.agentuse'] }),
      agent({ path: 'agents/ops/deploy.agentuse', subagents: ['agents/shared/judge.agentuse'] }),
      agent({ path: 'agents/shared/judge.agentuse', description: 'verifies news drafts' }),
    ];
    const html = renderToString(<AgentGraphView agents={shared} query="news" />);
    expect(html).toContain('>manager<');
    expect(html).not.toContain('>deploy<');
  });

  it('falls back to shared copies when nothing else matches, so the hit stays visible', () => {
    const shared = [
      agent({ path: 'agents/news/manager.agentuse', subagents: ['agents/shared/judge.agentuse'] }),
      agent({ path: 'agents/ops/deploy.agentuse', subagents: ['agents/shared/judge.agentuse'] }),
      agent({ path: 'agents/shared/judge.agentuse' }),
    ];
    const html = renderToString(<AgentGraphView agents={shared} query="judge" />);
    expect(html).toContain('>judge<');
  });

  it('keeps a standalone agent that matches on a field only the list views searched', () => {
    const rows = [agent({ path: 'agents/solo.agentuse', description: 'weekly newsletter digest' })];
    const html = renderToString(<AgentGraphView agents={rows} query="newsletter" />);
    expect(html).toContain('>solo<');
    expect(html).not.toContain('agent-graph-node static dim');
  });
});

describe('learnings panel status', () => {
  const rule = (over: Partial<SessionLearning>): SessionLearning => ({
    id: 'a', category: 'tip', title: 'T', instruction: 'Do the thing.',
    confidence: 1, source: 'manual', extractedAt: '2026-07-01', ...over,
  });

  it('tells a reviewer when a rule never reaches the agent', () => {
    expect(statusBadge(rule({ injected: false }))).toEqual({ label: 'never reaches the agent', kind: 'dormant' });
    expect(statusBadge(rule({ injected: true }))).toEqual({ label: 'applied', kind: 'applied' });
    expect(statusBadge(rule({ state: 'graduated', injected: false }))).toEqual({ label: 'in agent file', kind: 'graduated' });
    expect(statusBadge(rule({ state: 'retired', injected: false }))).toEqual({ label: 'retired', kind: 'retired' });
  });

  it('says nothing rather than guessing when the server sent no status', () => {
    // An older daemon omits `injected`; claiming "applied" there would be a lie.
    expect(statusBadge(rule({}))).toBeNull();
  });
});

describe('LearningsHeadline', () => {
  const summary = (over: Partial<LearningSummary> = {}): LearningSummary => ({
    cap: 10, active: 36, injected: 10, dormant: 26, graduated: 0, retired: 0, ...over,
  });
  const target = { project: 'demo', runPath: 'agents/writer.agentuse' };

  it('offers the fix in the same breath as the problem', () => {
    // The whole point of the change: the session panel used to state that 26
    // corrections were being ignored and then leave the user to go find the
    // button on another page.
    const html = renderToString(
      <LearningsHeadline summary={summary()} tidyTarget={target} runningTidy={null} />,
    );
    expect(html).toContain("26 of this agent's corrections never reach it");
    expect(html).toContain('Tidy up');
    expect(html).toContain('agents%2Fwriter.agentuse');
  });

  it('points at the pass already running instead of offering a second one', () => {
    const html = renderToString(
      <LearningsHeadline summary={summary()} tidyTarget={target} runningTidy={{ jobId: 'job-7' }} />,
    );
    expect(html).toContain('Tidying up…');
    expect(html).toContain('job-7');
    expect(html).not.toContain('>Tidy up<');
  });

  it('states the problem without a button when the server named no target', () => {
    // A session whose agent file is outside the served scope has no page to run
    // a tidy-up on; the count is still true and still worth saying.
    const html = renderToString(
      <LearningsHeadline summary={summary()} tidyTarget={null} runningTidy={null} />,
    );
    expect(html).toContain('never reach it');
    expect(html).not.toContain('Tidy up');
  });

  it('drops the warning entirely once every correction lands', () => {
    const html = renderToString(
      <LearningsHeadline
        summary={summary({ active: 8, injected: 8, dormant: 0, graduated: 2 })}
        tidyTarget={target}
        runningTidy={null}
      />,
    );
    expect(html).not.toContain('never reach');
    expect(html).not.toContain('Tidy up');
    expect(html).toContain('8 of 8 apply per run');
    expect(html).toContain('2 permanent in the agent file');
  });
});

describe('TidyResultView', () => {
  const result = (over: Partial<TidyResult> = {}): TidyResult => ({
    ran: true, activeBefore: 58, activeAfter: 10, cap: 10,
    changes: [{ kind: 'merge', titles: ['A', 'B'], why: 'same thing' }],
    merged: 1, rewritten: 0, retired: 12, graduated: ['Cite sources before publishing'],
    diffs: { learnings: '@@ -1 +1 @@\n-old\n+new', agentFile: '@@ -2 +2 @@\n+rule' },
    undoId: '2026-08-04', ...over,
  });

  it('names the rules that became permanent and shows both diffs with an undo', () => {
    const html = renderToString(<TidyResultView result={result()} onUndo={noop} undoing={false} />);
    expect(html).toContain('1 merged, 12 retired, 1 now permanent');
    expect(html).toContain('58 ');
    expect(html).toContain('Now permanent in the agent file');
    expect(html).toContain('Cite sources before publishing');
    expect(html).toContain('corrections file');
    expect(html).toContain('agent file');
    expect(html).toContain('Undo');
  });

  it('accounts for the corrections it left in force, one line each', () => {
    // "Still 40 over the cap, tidy up again" was the whole explanation a user
    // got after waiting a minute, and it read as a failure rather than as a
    // file whose remaining rules have earned their place.
    const html = renderToString(<TidyResultView onUndo={noop} undoing={false} result={result({
      activeAfter: 50,
      remaining: {
        active: 50,
        cap: 10,
        moreToDo: false,
        reasons: [
          { count: 38, because: 'say different things, so there is nothing left to merge them into' },
          { count: 12, because: 'you wrote by hand, and those are never retired for you' },
        ],
        graduationWait: 'None of these can move into the agent file yet. That takes 3 runs approved without a comment, and the closest of them has 0.',
      },
    })} />);
    expect(html).toContain('Still 40 over the cap');
    expect(html).toContain('as far as tidying up can take it');
    expect(html).toContain('38 say different things');
    expect(html).toContain('12 you wrote by hand');
    expect(html).toContain('the closest of them has 0');
  });

  it('says to press again only when pressing again would actually help', () => {
    const html = renderToString(<TidyResultView onUndo={noop} undoing={false} result={result({
      activeAfter: 50,
      remaining: { active: 50, cap: 10, moreToDo: true, reasons: [] },
    })} />);
    expect(html).toContain('tidy up again to keep going');
  });

  it('falls back to the old line for a result saved before the breakdown existed', () => {
    // The last tidy-up is replayed from a file on disk, which may predate this.
    const html = renderToString(<TidyResultView result={result({ activeAfter: 50 })} onUndo={noop} undoing={false} />);
    expect(html).toContain('Still 40 over the cap');
  });

  it('explains a skipped graduation instead of silently omitting it', () => {
    const html = renderToString(
      <TidyResultView result={result({ graduated: [], graduationSkipped: 'the agent file is not writable' })} onUndo={noop} undoing={false} />,
    );
    expect(html).toContain('not made permanent');
    expect(html).toContain('not writable');
  });

  it('drops the undo button once the change has been rolled back', () => {
    // Both files are already back to how they were; a second Undo would have
    // nothing to restore and the button would just fail.
    const html = renderToString(<TidyResultView result={result()} onUndo={noop} undoing={false} undone />);
    expect(html).toContain('Now permanent in the agent file');
    expect(html).not.toContain('>Undo<');
  });
});

describe('TidyProgressView', () => {
  it('counts the rules as they are written rather than showing a bare spinner', () => {
    // A pass takes minutes. "Please wait" for that long reads as a hang, and
    // writing is the long phase that can honestly count.
    const html = renderToString(<TidyProgressView phase="writing" step={3} total={11} elapsedMs={95_000} />);
    expect(html).toContain('Rewriting rule 4 of 11');
    expect(html).toContain('1m 35s');
    expect(html).toContain('aria-valuenow');
  });

  it('names the deciding phase, which has no inner milestones to count', () => {
    const html = renderToString(<TidyProgressView phase="deciding" step={0} total={1} elapsedMs={2_000} />);
    expect(html).toContain('Reading every correction');
    expect(html).not.toContain('of 0');
    expect(html).toContain('2s');
  });

  it('names the pass, so a second one does not read as the first one stalling', () => {
    // Every pass starts the bar over at the same label. Without the number that
    // looks like a hang rather than like progress.
    const html = renderToString(
      <TidyProgressView phase="deciding" step={0} total={2} round={3} maxRounds={5} elapsedMs={9_000} />,
    );
    expect(html).toContain('Pass 3 of up to 5');
  });

  it('says which files it is writing at the end', () => {
    const html = renderToString(<TidyProgressView phase="applying" step={11} total={11} elapsedMs={1_000} />);
    expect(html).toContain('corrections file and the agent file');
  });
});

describe('learningsTidyHref', () => {
  it('carries the agent by query, so a path with slashes stays unambiguous', () => {
    const href = learningsTidyHref('proj', 'agents/x/writer.agentuse', { start: true });
    expect(href).toBe('/learnings/tidy?project=proj&path=agents%2Fx%2Fwriter.agentuse&start=1');
  });

  it('addresses one finished run when given its job', () => {
    expect(learningsTidyHref('p', 'a.agentuse', { job: 'J1' })).toContain('job=J1');
  });
});
