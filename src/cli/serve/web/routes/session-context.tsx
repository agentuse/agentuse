import { useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { fetchSessionContext } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useSmartBack } from '../hooks/use-smart-back';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { LogContent } from '../components/content';
import { toolChipLabel } from '../components/log-entry';
import { isMarkdownPath, parseReadOutput } from '../lib/read-output';
import { pageTitle } from '../lib/brand';
import type {
  ContextFileRead,
  ContextStackLayer,
  ContextToolResultStat,
  ContextToolRow,
} from '../../types';

/** Friendly name for the tool that pulled a file in. */
const READ_TOOL_LABEL: Record<string, string> = {
  tools__filesystem_read: 'read',
  tools__skill_read: 'skill file',
  tools__skill_load: 'skill loaded on demand',
};

/** Rows and segments that are not one of the opening prompt's layers. */
type RunKind = 'file' | 'results' | 'output';
type RowKind = ContextStackLayer['kind'] | RunKind;

/** Everything that accumulated while the run was going, rather than before it. */
const RUN_KINDS = new Set<RunKind>(['file', 'results', 'output']);

/** Short, human labels for each kind. */
const KIND_LABEL: Record<RowKind, string> = {
  system: 'system',
  tools: 'tools',
  instructions: 'agent',
  approval: 'approval',
  skills: 'skill',
  learnings: 'learned',
  prompt: 'prompt',
  file: 'file',
  results: 'results',
  output: 'output',
};

/**
 * Send order for the opening layers, then what the run added as it went. The
 * mix bar and the stack share it, so a segment can be traced down to its rows.
 */
const STACK_ORDER: RowKind[] = [
  'system', 'tools', 'instructions', 'approval', 'skills', 'learnings', 'prompt',
  'file', 'results', 'output',
];

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString();
}

/**
 * Keep the informative tail of an absolute path. Truncating in JS rather than
 * with CSS: a `direction: rtl` ellipsis reorders the leading slash to the end
 * ("Users/…/x.agentuse/"), which reads as a different path. Full path stays on
 * the title attribute.
 */
function shortenPath(path: string, segments = 3): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join('/')}`;
}

/**
 * One row of the stack. Everything that occupies the context window is a row
 * here — system prompts, the tool catalog, the agent's own instructions, and
 * files read mid-run — so the weights are directly comparable against a shared
 * scale rather than split across sections with their own baselines.
 */
function StackRow(props: {
  kind: RowKind;
  index: number;
  share: number;
  label: string;
  labelIsPath?: boolean;
  title?: string;
  source?: string;
  /** Free-form second line: a plain string for layers, a node for file rows. */
  note?: preact.ComponentChildren;
  chars: number;
  estTokens: number;
  /** Rendered when the row is expanded. Absent means the row does not open. */
  body?: () => preact.ComponentChildren;
}) {
  const { kind, index, share, label, labelIsPath, title, source, note, chars, estTokens, body } = props;
  const [open, setOpen] = useState(false);

  const inner = (
    <>
      <span class="ctx-order">{index + 1}</span>
      <span class="ctx-kind">{KIND_LABEL[kind]}</span>
      <span class="ctx-layer-main">
        {labelIsPath
          ? <code class="ctx-layer-label ctx-path" {...(title ? { title } : {})}>{label}</code>
          : <span class="ctx-layer-label">{label}</span>}
        {source && <code class="ctx-source" title={source}>{shortenPath(source)}</code>}
        {note && <span class="ctx-note">{note}</span>}
      </span>
      <span class="ctx-weight">
        <span class="ctx-track">
          <span class="ctx-bar" style={{ width: `${Math.max(share * 100, 1)}%` }}></span>
        </span>
        <span class="ctx-tokens" title={`${chars.toLocaleString()} characters`}>
          ~{formatTokens(estTokens)}
        </span>
      </span>
      {/* Always rendered, so the token column lands in the same place whether
          or not a row opens; only the expandable ones draw the chevron. */}
      <span class="ctx-chevron" aria-hidden="true">
        {body && (
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6.5 8 10.5l4-4" />
          </svg>
        )}
      </span>
    </>
  );

  return (
    <li class={`ctx-layer ctx-kind-${kind}`}>
      {/* A row with nothing to expand is a plain div, not a disabled button:
          the page's shell dims disabled buttons to 45%, which would make half
          this list read as unavailable rather than simply detail-free. */}
      {body ? (
        <button type="button" class="ctx-layer-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {inner}
        </button>
      ) : (
        <div class="ctx-layer-head ctx-layer-head-static">{inner}</div>
      )}
      {open && body && <div class="ctx-body">{body()}</div>}
    </li>
  );
}

/**
 * Every layer whose text is markdown in the source it came from. The agent
 * body, SKILL.md files, the approval contract and captured corrections are all
 * authored as markdown, so they read as documents rather than as a wall of
 * escaped source. A run prompt is free-form, so it is left to auto-detection.
 */
const MARKDOWN_KINDS = new Set<ContextStackLayer['kind']>([
  'instructions', 'approval', 'skills', 'learnings',
]);

/**
 * A scroll-capped pane rendered by the shared log renderer: markdown for
 * documents, the smart block for JSON, a code block for anything else.
 */
function DocPane(props: { value: string; forceMarkdown?: boolean }) {
  return (
    <div class="ctx-doc">
      <LogContent value={props.value} {...(props.forceMarkdown ? { forceMarkdown: true } : {})} />
    </div>
  );
}

/**
 * What the model received for this file, per read. Multiple reads are labelled
 * because they are usually different slices of the same file (an offset/limit
 * range), not repeats of identical text.
 */
function FileContent(props: { file: ContextFileRead }) {
  const { file } = props;
  const entries = file.content ?? [];
  const shown = entries.length;
  const markdown = isMarkdownPath(file.path);

  return (
    <>
      {entries.map((entry, i) => {
        const parsed = parseReadOutput(entry.text);
        return (
          <div key={i}>
            {(shown > 1 || file.reads > shown) && (
              <div class="ctx-subhead">
                read {i + 1} of {file.reads} · {entry.chars.toLocaleString()} characters
              </div>
            )}
            {parsed.header && <div class="ctx-subhead ctx-subhead-note">{parsed.header}</div>}
            <DocPane value={parsed.body} {...(markdown ? { forceMarkdown: true } : {})} />
            {entry.truncated && (
              <div class="ctx-subhead ctx-subhead-note">
                Preview cut at {entry.text.length.toLocaleString()} of {entry.chars.toLocaleString()} characters.
                The full text is in the run's session log.
              </div>
            )}
          </div>
        );
      })}
      {file.reads > shown && (
        <div class="ctx-subhead ctx-subhead-note">
          Showing {shown} of {file.reads} reads.
        </div>
      )}
    </>
  );
}

/**
 * Which tools filled the window with their results. Sizes only - the results
 * themselves are in the session log, and re-serving them here would be a lot
 * of bytes for something already one click away.
 */
function ToolResultBreakdown(props: { results: ContextToolResultStat[] }) {
  const { results } = props;
  const peak = Math.max(1, ...results.map((r) => r.estTokens));

  return (
    <ul class="ctx-results">
      {results.map((r) => (
        <li class="ctx-result" key={r.tool}>
          <code class="ctx-result-name" title={r.tool}>{toolChipLabel(r.tool)}</code>
          <span class="ctx-result-calls">
            {r.calls.toLocaleString()} call{r.calls === 1 ? '' : 's'}
            {r.failed > 0 && (
              <span class="ctx-result-failed" title={`${r.failed} call${r.failed === 1 ? '' : 's'} errored, returning no result`}>
                {r.failed} failed
              </span>
            )}
            {r.pending > 0 && (
              <span class="ctx-result-pending" title="Still running, or parked on an approval gate, so it has no result yet">
                {r.pending} in flight
              </span>
            )}
          </span>
          {r.countedAsFiles ? (
            // A read tool: its bytes are the file rows above, so it shows its
            // activity here but contributes nothing to this row's total.
            <span class="ctx-result-elsewhere">counted as files above</span>
          ) : (
            <span class="ctx-weight">
              <span class="ctx-track">
                <span class="ctx-bar" style={{ width: `${Math.max((r.estTokens / peak) * 100, 2)}%` }}></span>
              </span>
              <span class="ctx-tokens" title={`${r.chars.toLocaleString()} characters`}>
                ~{formatTokens(r.estTokens)}
              </span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The note line under a file row: which tool read it, how often, truncation. */
function FileNote(props: { file: ContextFileRead }) {
  const { file } = props;
  return (
    <span class="ctx-file-meta">
      {READ_TOOL_LABEL[file.tool] ?? file.tool}
      {file.reads > 1 && (
        <span class="ctx-repeat" title={`Read ${file.reads} times; each read costs its tokens again`}>
          ×{file.reads}
        </span>
      )}
      {file.truncatedFrom !== undefined && (
        <span class="muted" title={`Tool truncated the output; the file itself is ${file.truncatedFrom.toLocaleString()} characters`}>
          truncated from ~{formatTokens(Math.ceil(file.truncatedFrom / 4))}
        </span>
      )}
    </span>
  );
}

function ToolRow(props: { tool: ContextToolRow; share: number }) {
  const { tool, share } = props;
  const [open, setOpen] = useState(false);

  return (
    <li class="ctx-tool">
      <button type="button" class="ctx-tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <code class="ctx-tool-name">{tool.name}</code>
        <span class="ctx-tool-desc">{tool.description ?? <span class="muted">no description</span>}</span>
        <span class="ctx-weight">
          <span class="ctx-track">
            <span class="ctx-bar" style={{ width: `${Math.max(share * 100, 1)}%` }}></span>
          </span>
          <span class="ctx-tokens" title={`${tool.chars.toLocaleString()} characters`}>
            ~{formatTokens(tool.estTokens)}
          </span>
        </span>
      </button>
      {open && (
        <div class="ctx-tool-body">
          {/* Auto-detected, not forced: a tool description is prose for some
              tools and an XML catalog for others (the `skill` tool embeds one). */}
          {tool.description && <DocPane value={tool.description} />}
          {tool.schema && (
            <>
              <div class="ctx-subhead">input schema</div>
              {/* Stays a code block: a JSON Schema is read as code, not as data. */}
              <pre class="ctx-text"><code>{tool.schema}</code></pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function SessionContext() {
  const { params } = useRoute();
  const location = useLocation();
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  const token = location.query.token || undefined;
  const projectId = location.query.project || undefined;

  useTitle(pageTitle('Session', 'Diagnostic'));

  const backParams = new URLSearchParams();
  if (token) backParams.set('token', token);
  if (projectId) backParams.set('project', projectId);
  const query = backParams.toString();
  const backHref = `/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
  const goBack = useSmartBack(backHref);

  const { data, error, loading } = useFetch(
    `session-context:${sessionId}:${projectId ?? ''}`,
    () => fetchSessionContext(sessionId, token, projectId)
  );

  const context = data?.context;

  // One scale across the whole stack: the opening layers and the mid-run file
  // reads compete for the same window, so their bars have to be comparable.
  const peak = useMemo(
    () => Math.max(
      1,
      ...(context?.layers ?? []).map((l) => l.estTokens),
      ...(context?.fileReads ?? []).map((f) => f.estTokens),
      context?.traffic.toolResultEstTokens ?? 0,
      context?.traffic.outputEstTokens ?? 0,
    ),
    [context]
  );
  const toolPeak = useMemo(
    () => Math.max(1, ...(context?.tools ?? []).map((t) => t.estTokens)),
    [context]
  );

  /**
   * The whole window as one bar, rows of the same kind summed. Reading order
   * matches the stack below, so a fat segment can be traced straight to the
   * rows that caused it.
   */
  const mix = useMemo(() => {
    if (!context) return [];
    const totals = new Map<string, number>();
    for (const layer of context.layers) {
      totals.set(layer.kind, (totals.get(layer.kind) ?? 0) + layer.estTokens);
    }
    const fileTokens = context.fileReads.reduce((sum, f) => sum + f.estTokens, 0);
    if (fileTokens > 0) totals.set('file', fileTokens);
    // What the run itself added. On a tool-heavy run these dominate: the
    // opening prompt is assembled once, but every result and every reply stays
    // in the window for each step after it.
    if (context.traffic.toolResultEstTokens > 0) {
      totals.set('results', context.traffic.toolResultEstTokens);
    }
    if (context.traffic.outputEstTokens > 0) {
      totals.set('output', context.traffic.outputEstTokens);
    }

    const total = [...totals.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    const present = STACK_ORDER.filter((kind) => totals.has(kind));

    // Two groups rather than one long bar. They answer different questions -
    // "is my prompt bloated" and "is my agent doing too much" - and are fixed
    // by different things, so each gets its own bar, its own subtotal, and
    // percentages of itself. Eight segments in one row was a lot to scan.
    return [
      { id: 'opening' as const, label: 'the prompt it opened with', run: false },
      { id: 'run' as const, label: 'what the run added', run: true },
    ]
      .map((group) => {
        const kinds = present.filter((k) => RUN_KINDS.has(k as RunKind) === group.run);
        const tokens = kinds.reduce((sum, k) => sum + totals.get(k)!, 0);
        return {
          ...group,
          tokens,
          shareOfTotal: (tokens / total) * 100,
          segments: kinds.map((kind) => ({
            kind,
            tokens: totals.get(kind)!,
            // Of its own group: "tools are 79% of your prompt" is a more
            // useful sentence than "79% of everything".
            pct: (totals.get(kind)! / tokens) * 100,
          })),
        };
      })
      .filter((group) => group.tokens > 0);
  }, [context]);

  const mixTotal = useMemo(() => mix.reduce((sum, g) => sum + g.tokens, 0), [mix]);
  const fileReadTokens = useMemo(
    () => (context?.fileReads ?? []).reduce((sum, f) => sum + f.estTokens, 0),
    [context]
  );

  const measured = context?.measured;
  const usage = measured?.context;

  return (
    // Reuses the session page's shell class so the header, meta grid and
    // section titles match the page this one is reached from.
    <div class="page-approval-detail page-session-context">
      <Topbar currentPage="sessions" right={<span class="session-pill">diagnostic</span>} />
      <main>
        <a class="back-link" href={backHref} onClick={goBack}>Back to session</a>
        {error && <div class="errors" role="alert">Failed to load diagnostics: {error.message}</div>}
        {loading && !context && <Loading label="Loading diagnostics…" />}
        {context && (
          <>
            <header>
              <div class="eyebrow">{context.agent.name}</div>
              <h1>Diagnostic</h1>
              <p class="lede">
                What this run put in the model's context window, and what it did with it.
                Reconstructed from what the run recorded, so it reflects the prompt as the model
                received it, not the agent file as it reads today.
              </p>
              <div class="meta">
                <div class="cell"><span class="label">session</span><code>{context.sessionId}</code></div>
                <div class="cell"><span class="label">agent</span><span class="value">{context.agent.name}</span></div>
                {context.model && (
                  <div class="cell"><span class="label">model</span><span class="value">{context.model}</span></div>
                )}
                {/* No "opening size" cell: the bar below states it, and the two
                    sat a hundred pixels apart saying the same number. */}
                {context.fileReads.length > 0 && (
                  <div class="cell">
                    <span class="label">files read</span>
                    <span class="value" title="Files pulled in by read tools while the run was going">
                      {context.fileReads.length} · ~{formatTokens(fileReadTokens)} tokens
                    </span>
                  </div>
                )}
                {measured && measured.input > 0 && (
                  <div class="cell">
                    <span class="label">measured input</span>
                    <span class="value" title="Reported by the provider across the whole run, including every later step">
                      {measured.input.toLocaleString()}
                      {measured.cacheRead > 0 && ` (+${measured.cacheRead.toLocaleString()} cached)`}
                    </span>
                  </div>
                )}
                {usage?.contextLimit !== undefined && (
                  <div class="cell">
                    <span class="label">window used</span>
                    <span class="value">
                      {usage.usagePercentage.toFixed(1)}% of {formatTokens(usage.contextLimit)}
                    </span>
                  </div>
                )}
              </div>
              {/* Inside the header, directly under the meta table: the same slot
                  and rhythm the session page gives its tool-call roll-up, so the
                  two bands read as one block. */}
              {mix.length > 0 && (
                <section class="ctx-mix" aria-label="Context window by input type">
                  <div class="ctx-mix-head">
                    <span class="ctx-mix-title">what fills the window</span>
                    <span class="ctx-mix-total">~{formatTokens(mixTotal)} tokens</span>
                  </div>
                  {mix.map((group) => (
                    <div class="ctx-mix-group" key={group.id}>
                      <div class="ctx-mix-group-head">
                        <span class="ctx-mix-group-label">{group.label}</span>
                        <span class="ctx-mix-group-total">
                          ~{formatTokens(group.tokens)}
                          <span class="ctx-mix-pct"> {group.shareOfTotal.toFixed(0)}%</span>
                        </span>
                      </div>
                      {/* Each group's bar is full width, so a segment's length
                          reads as its share of that group, not of the run. */}
                      <div class="ctx-mix-bar">
                        {group.segments.map((seg) => (
                          <span
                            key={seg.kind}
                            class="ctx-mix-seg"
                            data-kind={seg.kind}
                            style={{ width: `${seg.pct}%` }}
                            title={`${KIND_LABEL[seg.kind]}: ~${formatTokens(seg.tokens)} tokens, ${seg.pct.toFixed(1)}% of ${group.label}`}
                          ></span>
                        ))}
                      </div>
                      <ul class="ctx-mix-legend">
                        {group.segments.map((seg) => (
                          <li key={seg.kind}>
                            <span class="ctx-mix-dot" data-kind={seg.kind}></span>
                            <span class="ctx-mix-name">{KIND_LABEL[seg.kind]}</span>
                            <span class="ctx-mix-value">~{formatTokens(seg.tokens)}</span>
                            <span class="ctx-mix-pct">{seg.pct.toFixed(0)}%</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              )}
            </header>

            {context.compacted && (
              <div class="panel ctx-banner">
                This run compacted its context {usage?.compactions ?? 1} time
                {(usage?.compactions ?? 1) === 1 ? '' : 's'}. The stack below is what the run
                <em> opened</em> with; after a compaction the live window holds a summary instead of
                the earlier turns.
              </div>
            )}

            <div class="section-title">
              <span>stack</span>
              <span class="rule"></span>
            </div>
            <ul class="ctx-layers">
              {context.layers.map((layer, i) => (
                <StackRow
                  key={layer.id}
                  kind={layer.kind}
                  index={i}
                  share={layer.estTokens / peak}
                  label={layer.label}
                  {...(layer.source ? { source: layer.source } : {})}
                  {...(layer.note ? { note: layer.note } : {})}
                  chars={layer.chars}
                  estTokens={layer.estTokens}
                  {...(layer.kind === 'tools'
                    // The tool catalog opens into its own itemised list rather
                    // than a blob of text: per-tool weight is what makes a
                    // 20k-token catalog actionable.
                    ? {
                        body: () => (
                          <ul class="ctx-tools">
                            {context.tools.map((tool) => (
                              <ToolRow key={tool.name} tool={tool} share={tool.estTokens / toolPeak} />
                            ))}
                          </ul>
                        ),
                      }
                    : layer.text !== undefined
                      ? {
                          body: () => (
                            <DocPane
                              value={layer.text!}
                              {...(MARKDOWN_KINDS.has(layer.kind) ? { forceMarkdown: true } : {})}
                            />
                          ),
                        }
                      : {})}
                />
              ))}
              {context.fileReads.map((file, i) => (
                <StackRow
                  key={`file:${file.path}`}
                  kind="file"
                  index={context.layers.length + i}
                  share={file.estTokens / peak}
                  label={shortenPath(file.path, 4)}
                  labelIsPath
                  title={file.path}
                  note={<FileNote file={file} />}
                  chars={file.chars}
                  estTokens={file.estTokens}
                  {...(file.content?.length ? { body: () => <FileContent file={file} /> } : {})}
                />
              ))}
              {context.traffic.toolResultEstTokens > 0 && (
                <StackRow
                  kind="results"
                  index={context.layers.length + context.fileReads.length}
                  share={context.traffic.toolResultEstTokens / peak}
                  label="Tool results"
                  note={`Every tool this run called — ${context.traffic.toolResults.length} of them — with what its results added to the window.`}
                  chars={context.traffic.toolResultChars}
                  estTokens={context.traffic.toolResultEstTokens}
                  body={() => <ToolResultBreakdown results={context.traffic.toolResults} />}
                />
              )}
              {context.traffic.outputEstTokens > 0 && (
                <StackRow
                  kind="output"
                  index={context.layers.length + context.fileReads.length
                    + (context.traffic.toolResultEstTokens > 0 ? 1 : 0)}
                  share={context.traffic.outputEstTokens / peak}
                  label="Model output"
                  note="The agent's own replies, reasoning and tool arguments. Billed as output, but it stays in the window as input for every step after it."
                  chars={context.traffic.outputChars}
                  estTokens={context.traffic.outputEstTokens}
                />
              )}
            </ul>
            {context.layers.length === 0 && (
              <p class="empty">
                This session recorded no prompt content. Runs that failed before their first model
                call (bad auth, an MCP server that would not start) never get this far.
              </p>
            )}

            <p class="ctx-footnote">
              Rows 1&ndash;{context.layers.length} opened the run; the rest accumulated as it went.
              Token counts are estimates at 4 characters per token, so they read as proportions
              rather than as the live window, which is larger.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
