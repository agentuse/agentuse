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
import { FeedResponse, SessionRowView } from '../src/cli/serve/web/routes/sessions-list';
import { labelFor, suspendedGateKinds } from '../src/cli/serve/web/hooks/use-live-home';
import type { ApprovalsListPayload, SessionRow } from '../src/cli/serve/web/lib/api';
import type { ApprovalLogEntry } from '../src/cli/serve/types';

const noop = () => {};

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

  it('renders structured reference and changes with the draft demoted', () => {
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
          { label: 'Comment to post', content: 'The electricity comparison is the right one.' },
          { content: 'Like the post' },
        ],
        draft: 'Why this post: rationale lives here',
        context: 'background detail',
      },
    }, { showActions: true });

    expect(html).toContain('On approval');
    expect(html).toContain('approval-change');
    expect(html).toContain('Comment to post');
    expect(html).toContain('The electricity comparison is the right one.');
    expect(html).toContain('Action 2');
    expect(html).toContain('Replying to');
    expect(html).toContain('Alexandra Griffon');
    expect(html).toContain('approval-reference-quote');
    // Draft demotes to a collapsed details block when changes carry the payload.
    expect(html).toContain('<summary>Draft</summary>');
    // Context also starts collapsed so the change boxes stay the focal point.
    expect(html).not.toContain('approval-context-open');
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
    expect(html).toContain('optional: tell the agent why this should be rejected');
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
  const approvalRow = (sessionId: string) => ({ sessionId, project: 'demo' }) as ApprovalsListPayload['buckets']['pending'][number];
  const payload = (buckets: { pending?: string[]; expired?: string[] }): ApprovalsListPayload => ({
    success: true,
    multiProject: false,
    approvals: [],
    buckets: {
      pending: (buckets.pending ?? []).map(approvalRow),
      completed: [],
      expired: (buckets.expired ?? []).map(approvalRow),
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

  it('keeps the awaiting-approval default until the approvals snapshot loads', () => {
    expect(labelFor(row(), false, suspendedGateKinds(null))).toBe('awaiting approval');
  });

  it('leaves non-suspended labels untouched', () => {
    const gates = suspendedGateKinds(payload({}));
    expect(labelFor(row({ status: 'running' }), true, gates)).toBe('started');
    expect(labelFor(row({ status: 'completed' }), false, gates)).toBe('completed');
  });
});
