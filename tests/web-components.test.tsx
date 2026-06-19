import { describe, expect, it } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { LogEntry } from '../src/cli/serve/web/components/log-entry';
import { StoreTable, type StoreTableColumn } from '../src/cli/serve/web/components/store-table';
import { ContinuePanel } from '../src/cli/serve/web/components/continue-panel';
import { DecisionDialog } from '../src/cli/serve/web/components/comment-dialog';
import { escapeHtml, renderLogContentValue, renderMarkdownBlock } from '../src/cli/serve/web/lib/content-html';
import { isDebugLog, latestReviewerComment, logEntrySignature } from '../src/cli/serve/web/lib/format';
import { hasActionableApproval, headerTokenUsage, tokenUsageMetaItems } from '../src/cli/serve/web/routes/session-detail';
import type { ApprovalLogEntry } from '../src/cli/serve/types';

const noop = () => {};

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
      const index = html.indexOf(`<td>${name}</td>`);
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
  });

  it('renders reject mode with optional reason copy', () => {
    const html = renderToString(<DecisionDialog open mode="reject" onSubmit={noop} onClose={noop} />);
    expect(html).toContain('reject this request?');
    expect(html).toContain('configured rejected-state updates');
    expect(html).toContain('optional: tell the agent why this should be rejected');
    expect(html).toContain('>Reject</button>');
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

    expect(items).toEqual([
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

    expect(items).toEqual([
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

    expect(items).toEqual([
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
    expect(html).toContain('<table>');
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

  it('renders smart JSON blocks for readable strings', () => {
    const html = renderLogContentValue(JSON.stringify({ note: 'line one\nline two', count: 2 }));
    expect(html).toContain('json-object-block');
    expect(html).toContain('json-field-key');
    expect(html).toContain('line one');
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
