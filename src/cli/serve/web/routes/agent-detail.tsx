import type { ComponentChildren, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { AgentDetailMeta, SessionRow } from '../lib/api';
import { fetchAgentDetail, fetchSessions } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useRunAgent } from '../hooks/use-run-agent';
import { Topbar } from '../components/topbar';
import { SendToCodingAgentDialog } from '../components/send-to-coding-agent-dialog';
import { LogContent } from '../components/content';
import { formatApprovalTime } from '../lib/format';

/**
 * Split an `.agentuse` file into its YAML frontmatter and Markdown body.
 * Frontmatter is the block between a leading `---` line and the next `---`
 * line; everything after is the body. Returns `frontmatter: null` when the
 * file has no leading delimiter, so the whole source renders as body.
 */
function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const m = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: null, body: source };
  return { frontmatter: m[1], body: source.slice(m[0].length) };
}

/** Highlight a YAML scalar value: quoted strings, numbers, booleans, null. */
function yamlValue(raw: string): VNode {
  const v = raw.trim();
  let cls = 'yv-str';
  if (/^(true|false|null|~)$/i.test(v)) cls = 'yv-kw';
  else if (/^-?\d+(\.\d+)?$/.test(v)) cls = 'yv-num';
  else if (/^["'].*["']$/.test(v)) cls = 'yv-quote';
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  return <>{lead}<span class={cls}>{v}</span></>;
}

/**
 * Lightweight YAML highlighter for the frontmatter block — keys, list markers,
 * comments, and scalar values get distinct colors. Zero-dep and structure-
 * preserving (it never reflows the source), matching the hand-rolled markdown
 * renderer rather than pulling a parser into the browser bundle.
 */
function FrontmatterView(props: { yaml: string }) {
  const lines = props.yaml.split('\n');
  return (
    <pre class="source-pre source-frontmatter"><code>{lines.map((line, i) => {
      const nl = i < lines.length - 1 ? '\n' : '';
      const comment = line.match(/^(\s*)(#.*)$/);
      if (comment) return <span key={i}>{comment[1]}<span class="yc">{comment[2]}</span>{nl}</span>;
      const kv = line.match(/^(\s*)([\w.$-]+)(:)(\s*)(.*)$/);
      if (kv) {
        return <span key={i}>{kv[1]}<span class="yk">{kv[2]}</span>{kv[3]}{kv[4]}{kv[5] ? yamlValue(kv[5]) : ''}{nl}</span>;
      }
      const item = line.match(/^(\s*)(-)(\s+)(.*)$/);
      if (item) {
        const inner = item[4].match(/^([\w.$-]+)(:)(\s*)(.*)$/);
        return (
          <span key={i}>{item[1]}<span class="yd">{item[2]}</span>{item[3]}
            {inner ? <><span class="yk">{inner[1]}</span>{inner[2]}{inner[3]}{inner[4] ? yamlValue(inner[4]) : ''}</> : yamlValue(item[4])}{nl}</span>
        );
      }
      return <span key={i}>{line}{nl}</span>;
    })}</code></pre>
  );
}

/** project-relative path → the `?agent=` session-filter id (drops the extension). */
function agentIdFromPath(path: string): string {
  return path.replace(/\.agentuse$/, '');
}

/** Build the deep link a list row points at: /agents/<project>/<runPath>. */
export function agentDetailHref(projectId: string, runPath: string): string {
  const segs = runPath.split('/').map(encodeURIComponent).join('/');
  return `/agents/${encodeURIComponent(projectId)}/${segs}`;
}

function Chip(props: { children: ComponentChildren; tone?: 'cyan' | 'amber' | 'muted'; title?: string }) {
  return <span class={`cap-chip${props.tone ? ` ${props.tone}` : ''}`} {...(props.title ? { title: props.title } : {})}>{props.children}</span>;
}

/** One labeled capability row; renders nothing when it has no chips. */
function CapRow(props: { label: string; chips: VNode[] }) {
  if (props.chips.length === 0) return null;
  return (
    <div class="cap-row">
      <span class="cap-label">{props.label}</span>
      <span class="cap-vals">{props.chips}</span>
    </div>
  );
}

function Capabilities(props: { meta: AgentDetailMeta; model: string; schedule: string | undefined; scheduleHuman: string | undefined }) {
  const { meta } = props;
  const skillChips: VNode[] = [];
  if (meta.skills.explicit.length > 0) {
    for (const s of meta.skills.explicit) skillChips.push(<Chip key={s}>{s}</Chip>);
  }
  if (meta.skills.auto) skillChips.push(<Chip tone="cyan">{meta.skills.trusted ? 'auto · trusted' : 'auto-discover'}</Chip>);
  if (skillChips.length === 0) skillChips.push(<Chip tone="muted">none</Chip>);

  const toolChips: VNode[] = [];
  if (meta.filesystem && meta.filesystem.length > 0) toolChips.push(<Chip key="fs">fs: {meta.filesystem.join(' · ')}</Chip>);
  if (typeof meta.bashCommands === 'number') toolChips.push(<Chip key="bash">bash: {meta.bashCommands} cmd{meta.bashCommands === 1 ? '' : 's'}</Chip>);
  if (meta.awaitHuman) toolChips.push(<Chip key="await" tone="amber">await_human</Chip>);

  const runtimeChips: VNode[] = [<Chip key="model" tone="cyan">{props.model}</Chip>];
  if (props.schedule) runtimeChips.push(<Chip key="sched" title={props.schedule}>{props.scheduleHuman ?? props.schedule}</Chip>);
  if (typeof meta.timeout === 'number') runtimeChips.push(<Chip key="to">timeout {meta.timeout}s</Chip>);
  if (typeof meta.maxSteps === 'number') runtimeChips.push(<Chip key="ms">{meta.maxSteps} steps</Chip>);
  if (meta.version) runtimeChips.push(<Chip key="v">v{meta.version}</Chip>);

  const mcpChips = meta.mcpServers.map((m) => <Chip key={m}>{m}</Chip>);
  const subChips = meta.subagents.map((s) => <Chip key={s}>{s}</Chip>);
  const chanChips = meta.channels.map((c) => <Chip key={c} tone="cyan">{c}</Chip>);
  if (meta.approval) chanChips.push(<Chip key="approval" tone="amber">approval gate</Chip>);

  return (
    <div class="cap-grid">
      <CapRow label="Runtime" chips={runtimeChips} />
      <CapRow label="Skills" chips={skillChips} />
      <CapRow label="Tools" chips={toolChips} />
      <CapRow label="MCP" chips={mcpChips} />
      <CapRow label="Subagents" chips={subChips} />
      <CapRow label="Surfaces" chips={chanChips} />
    </div>
  );
}

function RunRow(props: { row: SessionRow }) {
  const { row } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  return (
    <a class="run-row" href={href}>
      <span class={`chip status ${row.status}`}>{row.status}</span>
      <span class="chip trigger">{row.trigger}</span>
      <span class="run-row-time">{formatApprovalTime(row.createdAt)}</span>
      <span class="run-row-id"><code>{row.sessionId.slice(0, 12)}</code></span>
    </a>
  );
}

function RecentRuns(props: { agentId: string; project: string }) {
  const { data, error, loading } = useFetch(
    `agent-runs:${props.project}:${props.agentId}`,
    () => fetchSessions({ agent: props.agentId, window: '30d' }),
    { refreshMs: 15_000 }
  );
  const rows = (data?.sessions ?? []).filter((r) => r.project === props.project).slice(0, 8);
  const seeAll = `/sessions?agent=${encodeURIComponent(props.agentId)}`;

  return (
    <section class="group">
      <h2 class="group-title">
        <span>Recent runs</span>
        {data && <span class="count">last 30 days</span>}
        <span class="rule" />
        <a class="see-all" href={seeAll}>view all →</a>
      </h2>
      <div class="panel">
        {loading && <div class="empty">Loading runs…</div>}
        {error && <div class="empty err">Failed to load runs: {error.message}</div>}
        {data && rows.length === 0 && <div class="empty">No runs in the last 30 days.</div>}
        {rows.length > 0 && <div class="run-list">{rows.map((r) => <RunRow key={r.sessionId} row={r} />)}</div>}
      </div>
    </section>
  );
}

/**
 * Builds a self-contained prompt that hands this agent off to a coding agent
 * (Claude Code, etc.). The full source is embedded between heredoc-style markers
 * so the prompt works even where the coding agent can't read the file directly;
 * `detail` is the operator's optional "what to implement" note.
 */
function buildCodingAgentPrompt(opts: { project: string; path: string; source: string; detail: string }): string {
  const task = opts.detail.trim() || 'Review this agent and help me improve it.';
  return [
    'You are working on an AgentUse agent: a `.agentuse` file (Markdown with YAML',
    "frontmatter that defines the model, tools, skills, schedule, and the agent's",
    'instructions).',
    '',
    `Project: ${opts.project}`,
    `File:    ${opts.path}`,
    '',
    'Load the `agentuse` skill if you have it (file format + CLI); otherwise see',
    'https://docs.agentuse.io.',
    '',
    `Task: ${task}`,
    '',
    `Current source of ${opts.path} (between the markers):`,
    '',
    '<<<<<<< AGENTUSE',
    opts.source.replace(/\s+$/, ''),
    '======= AGENTUSE',
  ].join('\n');
}

function SourcePanel(props: { source: string; runPath: string; project: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [rendered, setRendered] = useState(true);
  const copy = () => {
    void navigator.clipboard?.writeText(props.source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const { frontmatter, body } = splitFrontmatter(props.source);
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Source</span>
        <span class="count">{props.runPath}</span>
        <span class="rule" />
        <button type="button" class="source-view-btn" onClick={() => setRendered((v) => !v)}>{rendered ? 'raw' : 'rendered'}</button>
        <button type="button" class="send-agent-btn" onClick={() => setSendOpen(true)}>Send to Coding Agent…</button>
        <button type="button" class="copy-btn" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
      </h2>
      <div class="panel source-panel">
        {rendered ? (
          <div class="source-rendered">
            {frontmatter !== null && <FrontmatterView yaml={frontmatter} />}
            <div class="source-body"><LogContent value={body} forceMarkdown /></div>
          </div>
        ) : (
          <pre class="source-pre"><code>{props.source}</code></pre>
        )}
      </div>
      <SendToCodingAgentDialog
        open={sendOpen}
        buildPrompt={(detail) => buildCodingAgentPrompt({ project: props.project, path: props.path, source: props.source, detail })}
        detailLabel="Give the agent more detail on what to implement"
        placeholder={props.path}
        onClose={() => setSendOpen(false)}
      />
    </section>
  );
}

export default function AgentDetail() {
  const { params } = useRoute();
  const project = decodeURIComponent(params.project ?? '');
  const runPath = (params.agent ?? '').split('/').map(decodeURIComponent).join('/');

  const { data, error, loading } = useFetch(
    `agent-detail:${project}:${runPath}`,
    () => fetchAgentDetail(project, runPath)
  );

  useTitle(data ? `AgentUse / ${data.name}` : 'AgentUse / Agent');
  const { run, busy, error: runError } = useRunAgent(runPath, project);

  return (
    <div class="page-agent-detail">
      <Topbar currentPage="agents" />
      <main>
        <a class="back" href="/agents">← agents</a>

        {loading && <div class="panel"><div class="empty">Loading agent…</div></div>}
        {error && (
          <div class="panel"><div class="empty err">Failed to load agent: {error.message}</div></div>
        )}

        {data && (
          <>
            <header class="hero">
              <div class="hero-text">
                <div class="eyebrow">{data.projectId}</div>
                <h1>{data.name}</h1>
                <p class="lede">{data.description || <span class="muted">No description.</span>}</p>
                <div class="hero-path"><code>{data.path}</code></div>
              </div>
              <div class="hero-actions">
                <button type="button" class="run-cta" disabled={busy} onClick={() => void run()}>
                  {busy ? 'Starting…' : '▶ Run agent'}
                </button>
                {runError && <span class="run-err">{runError}</span>}
              </div>
            </header>

            <Capabilities meta={data.meta} model={data.model} schedule={data.schedule} scheduleHuman={data.scheduleHuman} />

            <SourcePanel source={data.source} runPath={data.runPath} project={data.projectId} path={data.path} />

            <RecentRuns agentId={agentIdFromPath(data.path)} project={data.projectId} />
          </>
        )}
      </main>
    </div>
  );
}
