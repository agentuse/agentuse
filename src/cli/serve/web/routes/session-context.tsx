import { useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { fetchSessionContext } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useSmartBack } from '../hooks/use-smart-back';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { pageTitle } from '../lib/brand';
import type { ContextStackLayer, ContextToolRow } from '../../types';

/** Short, human labels for each layer kind. Doubles as the filter chip set. */
const KIND_LABEL: Record<ContextStackLayer['kind'], string> = {
  system: 'system',
  tools: 'tools',
  instructions: 'agent',
  approval: 'approval',
  skills: 'skill',
  learnings: 'learned',
  prompt: 'prompt',
};

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

function LayerRow(props: { layer: ContextStackLayer; share: number; index: number }) {
  const { layer, share, index } = props;
  const [open, setOpen] = useState(false);

  return (
    <li class={`ctx-layer ctx-kind-${layer.kind}`}>
      <button
        type="button"
        class="ctx-layer-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // A tools layer has no text of its own; its weight is itemised in the
        // table below, so there is nothing to expand.
        disabled={layer.text === undefined}
      >
        <span class="ctx-order">{index + 1}</span>
        <span class="ctx-kind">{KIND_LABEL[layer.kind]}</span>
        <span class="ctx-layer-main">
          <span class="ctx-layer-label">{layer.label}</span>
          {layer.source && <code class="ctx-source" title={layer.source}>{shortenPath(layer.source)}</code>}
          {layer.note && <span class="ctx-note">{layer.note}</span>}
        </span>
        <span class="ctx-weight">
          <span class="ctx-track">
            <span class="ctx-bar" style={{ width: `${Math.max(share * 100, 1)}%` }}></span>
          </span>
          <span class="ctx-tokens" title={`${layer.chars.toLocaleString()} characters`}>
            ~{formatTokens(layer.estTokens)}
          </span>
        </span>
      </button>
      {open && layer.text !== undefined && (
        <pre class="ctx-text"><code>{layer.text}</code></pre>
      )}
    </li>
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
          {tool.description && <pre class="ctx-text"><code>{tool.description}</code></pre>}
          {tool.schema && (
            <>
              <div class="ctx-subhead">input schema</div>
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

  useTitle(pageTitle('Session', 'Context'));

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
  const [showTools, setShowTools] = useState(false);

  const peak = useMemo(
    () => Math.max(1, ...(context?.layers ?? []).map((l) => l.estTokens)),
    [context]
  );
  const toolPeak = useMemo(
    () => Math.max(1, ...(context?.tools ?? []).map((t) => t.estTokens)),
    [context]
  );

  const measured = context?.measured;
  const usage = measured?.context;

  return (
    // Reuses the session page's shell class so the header, meta grid and
    // section titles match the page this one is reached from.
    <div class="page-approval-detail page-session-context">
      <Topbar currentPage="sessions" right={<span class="session-pill">context</span>} />
      <main>
        <a class="back-link" href={backHref} onClick={goBack}>Back to session</a>
        {error && <div class="errors">Failed to load the context stack: {error.message}</div>}
        {loading && !context && <Loading label="Loading context stack…" />}
        {context && (
          <>
            <header>
              <div class="eyebrow">diagnostics</div>
              <h1>Context stack</h1>
              <p class="lede">
                Everything loaded into the model's context window at the start of this run, in the
                order it was sent. Reconstructed from what the run recorded, so it reflects the
                prompt as the model received it, not the agent file as it reads today.
              </p>
              <div class="meta">
                <div class="cell"><span class="label">session</span><code>{context.sessionId}</code></div>
                <div class="cell"><span class="label">agent</span><span class="value">{context.agent.name}</span></div>
                {context.model && (
                  <div class="cell"><span class="label">model</span><span class="value">{context.model}</span></div>
                )}
                <div class="cell">
                  <span class="label">est. opening size</span>
                  <span class="value" title={`${context.totals.chars.toLocaleString()} characters at ~4 chars/token`}>
                    ~{formatTokens(context.totals.estTokens)} tokens
                  </span>
                </div>
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
                <LayerRow key={layer.id} layer={layer} index={i} share={layer.estTokens / peak} />
              ))}
            </ul>
            {context.layers.length === 0 && (
              <p class="empty">
                This session recorded no prompt content. Runs that failed before their first model
                call (bad auth, an MCP server that would not start) never get this far.
              </p>
            )}

            {context.tools.length > 0 && (
              <>
                <div class="section-title">
                  <span>tool definitions</span>
                  <span class="rule"></span>
                </div>
                <p class="ctx-hint">
                  Sent on every request, so this cost repeats each step. Skills that load on demand
                  are listed inside the <code>skill</code> tool's description rather than as their
                  own layer.
                </p>
                <button type="button" class="session-action-button" onClick={() => setShowTools((v) => !v)}>
                  {showTools ? 'Hide' : 'Show'} {context.tools.length} tool
                  {context.tools.length === 1 ? '' : 's'}
                </button>
                {showTools && (
                  <ul class="ctx-tools">
                    {context.tools.map((tool) => (
                      <ToolRow key={tool.name} tool={tool} share={tool.estTokens / toolPeak} />
                    ))}
                  </ul>
                )}
              </>
            )}

            <p class="ctx-footnote">
              Token counts marked ~ are estimates at 4 characters per token, the same heuristic the
              runtime uses to decide when to compact. Treat them as proportions, not billing.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
