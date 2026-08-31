import type { ComponentChildren, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { AgentDetailMeta, SessionRow } from '../lib/api';
import { fetchAgentDetail, fetchSessions, setAgentSchedulePaused } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useRunAgent } from '../hooks/use-run-agent';
import { useSmartBack } from '../hooks/use-smart-back';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { SchedulePill } from '../components/schedule-pill';
import { AgentLearningsPanel, StrandedLearningsBanner } from '../components/learnings-panel';
import { SendToCodingAgentDialog } from '../components/send-to-coding-agent-dialog';
import { RunInstructionDialog } from '../components/run-instruction-dialog';
import { LogContent } from '../components/content';
import { formatApprovalTime, formatRelativeTime, displayStatusLabel, errorText } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { agentDetailViewState, type AgentDetailTab } from '../lib/links';

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

/** "a, b and c" for short capability lists. */
function joinNames(items: string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Capability meta as plain sentences (#156): what a non-technical operator
 * reads first. Deliberately exhaustive over the access-granting fields so the
 * closing "Nothing else." is true; the raw chip grid stays one expand away.
 * Translate, don't hide.
 */
function capabilitySentences(meta: AgentDetailMeta, scheduleHuman: string | undefined, scheduleEnabled: boolean | undefined): string[] {
  const sentences: string[] = [];
  if (meta.filesystem && meta.filesystem.length > 0) {
    sentences.push(`Can ${joinNames(meta.filesystem)} files in its allowed folders.`);
  }
  if (typeof meta.bashCommands === 'number') {
    sentences.push(`Can run ${meta.bashCommands} approved command pattern${meta.bashCommands === 1 ? '' : 's'}.`);
  }
  if (meta.gated && meta.gated.length > 0) {
    sentences.push(`${meta.gated.length} command pattern${meta.gated.length === 1 ? '' : 's'} ${meta.gated.length === 1 ? 'is' : 'are'} gated: they run only after you approve the exact action.`);
  }
  if (meta.mcpServers.length > 0) sentences.push(`Connects to ${joinNames(meta.mcpServers)}.`);
  if (meta.subagents.length > 0) sentences.push(`Delegates to ${joinNames(meta.subagents)}.`);
  if (meta.channels.length > 0) sentences.push(`Reports to ${joinNames(meta.channels)}.`);
  if (meta.approval) sentences.push('Risky actions wait for human approval.');
  else if (meta.awaitHuman) sentences.push('Can pause to ask a human.');
  if (scheduleHuman) {
    const cadence = `${scheduleHuman.charAt(0).toLowerCase()}${scheduleHuman.slice(1)}`;
    sentences.push(scheduleEnabled === false ? `Its schedule is paused: ${cadence}.` : `Runs on a schedule: ${cadence}.`);
  }
  if (sentences.length === 0) return ['No tools beyond the model.'];
  sentences.push('Nothing else.');
  return sentences;
}

function Capabilities(props: { meta: AgentDetailMeta; model: string; schedule: string | undefined; scheduleHuman: string | undefined; scheduleEnabled: boolean | undefined; metadata: Record<string, unknown> | undefined }) {
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
  if (meta.gated && meta.gated.length > 0) toolChips.push(<Chip key="gated" tone="amber" title={meta.gated.join(' · ')}>gated: {meta.gated.length}</Chip>);
  if (meta.awaitHuman) toolChips.push(<Chip key="await" tone="amber">await_human</Chip>);

  const runtimeChips: VNode[] = [<Chip key="model" tone="cyan">{props.model}</Chip>];
  if (props.schedule) runtimeChips.push(
    <SchedulePill key="sched" class="cap-chip" schedule={props.schedule} human={props.scheduleHuman} />
  );
  if (typeof meta.timeout === 'number') runtimeChips.push(<Chip key="to">timeout {meta.timeout}s</Chip>);
  if (typeof meta.maxSteps === 'number') runtimeChips.push(<Chip key="ms">{meta.maxSteps} steps</Chip>);
  if (meta.version) runtimeChips.push(<Chip key="v">v{meta.version}</Chip>);

  const mcpChips = meta.mcpServers.map((m) => <Chip key={m}>{m}</Chip>);
  const subChips = meta.subagents.map((s) => <Chip key={s}>{s}</Chip>);
  const chanChips = meta.channels.map((c) => <Chip key={c} tone="cyan">{c}</Chip>);
  if (meta.approval) chanChips.push(<Chip key="approval" tone="amber">approval gate</Chip>);

  // Free-form metadata, one chip per key. Values are formatted, never
  // interpreted: the framework has no opinion on what these keys mean.
  const metaChips: VNode[] = [];
  for (const [k, v] of Object.entries(props.metadata ?? {})) {
    const val = v === true ? 'true'
      : v === false ? 'false'
      : v == null ? '—'
      : typeof v === 'object' ? JSON.stringify(v)
      : String(v);
    metaChips.push(<Chip key={k} title={`${k}: ${val}`}>{k}: {val}</Chip>);
  }

  return (
    <div class="cap-panel">
      <p class="cap-summary">{capabilitySentences(meta, props.scheduleHuman ?? props.schedule, props.scheduleEnabled).join(' ')}</p>
      <details class="cap-raw">
        <summary>Full capability list</summary>
        <div class="cap-grid">
          <CapRow label="Runtime" chips={runtimeChips} />
          <CapRow label="Skills" chips={skillChips} />
          <CapRow label="Tools" chips={toolChips} />
          <CapRow label="MCP" chips={mcpChips} />
          <CapRow label="Subagents" chips={subChips} />
          <CapRow label="Surfaces" chips={chanChips} />
          <CapRow label="Metadata" chips={metaChips} />
        </div>
      </details>
    </div>
  );
}

/** Compact a final response into the outcome-first sentence used while skimming jobs. */
export function recentJobSummary(value: string, max = 280): string {
  const compact = value
    .replace(/```[\s\S]*?```/g, ' Code output available in the full response. ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_~`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max).trimEnd()}…`;
}

function recentJobFallback(row: SessionRow): string {
  if (row.errorMessage) return errorText(row.errorMessage);
  if (row.subagentActive) return 'Working in a delegated agent. Its response will appear here when it returns.';
  if (row.status === 'running' || row.status === 'resuming' || row.status === 'continuing') {
    return 'This job is running. Its response will appear here when available.';
  }
  if (row.status === 'suspended') return 'Waiting for approval or input before this job can continue.';
  return 'This job ended without a final response.';
}

export function RecentJobRow(props: { row: SessionRow }) {
  const { row } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  const status = displayStatusLabel(row.status, row.errorCode);
  const summary = row.finalResponse?.trim() ? recentJobSummary(row.finalResponse) : recentJobFallback(row);
  const live = row.status === 'running' || row.status === 'resuming' || row.status === 'continuing' || row.subagentActive === true;
  return (
    <article class={`job-row${live ? ' live' : ''}`}>
      <div class="job-row-head">
        <span class={`chip status ${live ? 'running' : status}`}>{row.subagentActive ? 'running · subagent' : status}</span>
        <span class="chip trigger">{row.trigger}</span>
        <span class="job-row-time" title={formatApprovalTime(row.updatedAt || row.createdAt)}>{formatRelativeTime(row.updatedAt || row.createdAt)}</span>
      </div>
      <p class="job-row-summary">{summary}</p>
      {row.finalResponse?.trim() && (
        <details class="job-response">
          <summary>Full response</summary>
          <div class="job-response-content"><LogContent value={row.finalResponse} forceMarkdown /></div>
        </details>
      )}
      <footer class="job-row-foot">
        <code>{row.sessionId.slice(0, 12)}</code>
        <a href={href}>Open job <span aria-hidden="true">→</span></a>
      </footer>
    </article>
  );
}

function RecentJobs(props: { agentId: string; project: string }) {
  const { data, error, loading } = useFetch(
    `agent-jobs:${props.project}:${props.agentId}`,
    () => fetchSessions({ agent: props.agentId, window: '30d', detail: 'feed' }),
    { refreshMs: 15_000 }
  );
  const rows = (data?.sessions ?? []).filter((r) => r.project === props.project).slice(0, 8);
  const seeAll = `/sessions?agent=${encodeURIComponent(props.agentId)}`;

  return (
    <section class="group">
      <div class="group-title">
        <span class="count">last 30 days</span>
        <span class="rule" />
        <a class="see-all" href={seeAll}>view all →</a>
      </div>
      <div class="panel">
        {loading && !data && <Loading label="Loading jobs…" />}
        {error && <div class="empty err">Failed to load jobs: {error.message}</div>}
        {data && rows.length === 0 && <div class="empty">No jobs in the last 30 days.</div>}
        {rows.length > 0 && <div class="job-list">{rows.map((r) => <RecentJobRow key={r.sessionId} row={r} />)}</div>}
      </div>
    </section>
  );
}

/** The agent's full learning store (every session), editable in place. */
function LearningsGroup(props: {
  project: string;
  runPath: string;
  hoistStranded: (strandedAt: string | null) => void;
}) {
  return (
    <section class="group">
      <div class="group-title">
        <span class="count">all sessions</span>
        <span class="rule" />
      </div>
      <AgentLearningsPanel
        project={props.project}
        runPath={props.runPath}
        hoistStranded={props.hoistStranded}
      />
    </section>
  );
}

/**
 * Builds a self-contained prompt that hands this agent off to a coding agent
 * (Claude Code, etc.). The full source is embedded between heredoc-style markers
 * so the prompt works even where the coding agent can't read the file directly;
 * `detail` is the operator's optional "what to implement" note.
 */
export function buildCodingAgentPrompt(opts: { project: string; path: string; source: string; detail: string }): string {
  const task = opts.detail.trim() || 'Review this agent and help me improve it.';
  return [
    'You are working on an AgentUse agent: a `.agentuse` file (Markdown with YAML',
    "frontmatter that defines the model, tools, skills, schedule, and the agent's",
    'instructions).',
    '',
    `Project: ${opts.project}`,
    `File:    ${opts.path}`,
    '',
    'Before reviewing or editing:',
    '1. Load the `/agentuse` skill if available.',
    '2. Run `agentuse skills get core --full`.',
    '3. Run `agentuse skills get creator --full`.',
    '4. Follow the creator guidance; keep the agent body compressed, not crammed.',
    '',
    `After editing, run \`agentuse doctor ${opts.path}\`. If AgentUse is unavailable,`,
    'use https://docs.agentuse.io.',
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
      <div class="group-title">
        <span class="count">{props.runPath}</span>
        <span class="rule" />
        <button type="button" class="source-view-btn" onClick={() => setRendered((v) => !v)}>{rendered ? 'raw' : 'rendered'}</button>
        <button type="button" class="send-agent-btn" onClick={() => setSendOpen(true)}>Send to Coding Agent…</button>
        <button type="button" class="copy-btn" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
      </div>
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

const AGENT_TABS: { id: AgentDetailTab; label: string }[] = [
  { id: 'jobs', label: 'Recent jobs' },
  { id: 'learnings', label: 'Learnings' },
  { id: 'source', label: 'Source' },
];

export default function AgentDetail() {
  const { params } = useRoute();
  const project = decodeURIComponent(params.project ?? '');
  const runPath = (params.agent ?? '').split('/').map(decodeURIComponent).join('/');
  const entryState = agentDetailViewState(typeof window === 'undefined' ? '' : window.location.search);
  const [tab, setTab] = useState<AgentDetailTab>(entryState.tab);
  const [tutorialStep, setTutorialStep] = useState(entryState.tutorialStep);
  const [runOpen, setRunOpen] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const tutorialActionRef = useRef<HTMLButtonElement>(null);
  // Reported up out of the Learnings tab. The tab is mounted from the start, so
  // this arrives on load without anyone opening it — which is the point: an
  // agent whose learnings stopped being read must say so on the page you land
  // on, not on the one you would only visit if you already suspected it.
  const [strandedAt, setStrandedAt] = useState<string | null>(null);

  const { data, error, loading, refetch } = useFetch(
    `agent-detail:${project}:${runPath}`,
    () => fetchAgentDetail(project, runPath)
  );

  useTitle(pageTitle(data ? data.name : 'Agent'));
  const { run, busy, error: runError } = useRunAgent(runPath, project);
  const goBack = useSmartBack('/agents');

  useEffect(() => {
    if (data && data.source === undefined && tab === 'source') setTab('jobs');
  }, [data, tab]);

  const updateTutorialStep = (next: 'run' | 'schedule' | null) => {
    setTutorialStep(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'run') url.searchParams.set('onboarding', 'first-agent');
    else if (next === 'schedule') url.searchParams.set('onboarding', 'first-agent-schedule');
    else url.searchParams.delete('onboarding');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const advanceTutorial = () => updateTutorialStep(data?.schedule ? 'schedule' : null);
  const finishTutorial = () => {
    updateTutorialStep(null);
    requestAnimationFrame(() => runButtonRef.current?.focus());
  };

  const toggleSchedule = async () => {
    if (!data?.schedule || scheduleBusy) return;
    setScheduleBusy(true);
    setScheduleError(null);
    try {
      await setAgentSchedulePaused(project, runPath, data.scheduleEnabled !== false);
      refetch();
    } catch (error) {
      setScheduleError((error as Error).message);
    } finally {
      setScheduleBusy(false);
    }
  };

  useEffect(() => {
    if (!tutorialStep) return;
    const initial = tutorialStep === 'run' ? runButtonRef.current : tutorialActionRef.current;
    initial?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;
      const first = tutorialStep === 'run' ? runButtonRef.current : tutorialActionRef.current;
      const last = tutorialActionRef.current;
      if (!first || !last) return;
      if (first === last) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tutorialStep, data]);

  useEffect(() => {
    if (data && tutorialStep === 'schedule' && !data.schedule) finishTutorial();
  }, [data, tutorialStep]);

  return (
    <div class="page-agent-detail">
      <Topbar currentPage="agents" />
      <main>
        <a class="back" href="/agents" onClick={goBack}>← Back</a>

        {loading && !data && <div class="panel"><Loading label="Loading agent…" /></div>}
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
                {tutorialStep && <div class="first-agent-spotlight-backdrop" aria-hidden="true" />}
                <div class="run-cta-row">
                  <div class={`run-spotlight-anchor${tutorialStep === 'run' ? ' is-active' : ''}`}>
                    <button
                      ref={runButtonRef}
                      type="button"
                      class={`run-cta${busy ? ' btn-busy' : ''}`}
                      disabled={busy}
                      aria-busy={busy}
                      aria-disabled={tutorialStep === 'run'}
                      {...(tutorialStep === 'run' ? { 'aria-describedby': 'first-agent-run-tutorial-copy' } : {})}
                      onClick={() => { if (!tutorialStep) void run(); }}
                    >
                      {busy ? <><span class="btn-spinner" aria-hidden="true" />Starting…</> : '▶ Run agent'}
                    </button>
                    {tutorialStep === 'run' && (
                      <div class="first-agent-spotlight-card" role="dialog" aria-modal="true" aria-label="Run your first agent">
                        <small>1 of 2</small>
                        <strong>Your agent is ready</strong>
                        <span id="first-agent-run-tutorial-copy">Run it once to make sure it works.</span>
                        <button ref={tutorialActionRef} type="button" onClick={advanceTutorial}>Next</button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    class="run-cta-alt"
                    disabled={busy}
                    title="Start a run with a one-off instruction appended to the agent's prompt"
                    onClick={() => setRunOpen(true)}
                  >
                    Run with instruction…
                  </button>
                </div>
                {data.schedule && (
                  <div class={`schedule-spotlight-anchor${tutorialStep === 'schedule' ? ' is-active' : ''}`}>
                    <div class="agent-schedule-control" {...(tutorialStep === 'schedule' ? { 'aria-describedby': 'first-agent-schedule-tutorial-copy' } : {})}>
                      <span class="agent-schedule-copy">
                        <strong>Schedule</strong>
                        <span>{data.scheduleHuman ?? data.schedule}</span>
                      </span>
                      <button
                        type="button"
                        class={`schedule-switch${data.scheduleEnabled === false ? '' : ' is-on'}`}
                        role="switch"
                        aria-checked={data.scheduleEnabled !== false}
                        disabled={scheduleBusy || tutorialStep === 'schedule'}
                        onClick={() => void toggleSchedule()}
                      >
                        <span aria-hidden="true" />
                        {scheduleBusy ? 'Saving…' : data.scheduleEnabled === false ? 'Paused' : 'On'}
                      </button>
                    </div>
                    {tutorialStep === 'schedule' && (
                      <div class="first-agent-spotlight-card schedule-spotlight-card" role="dialog" aria-modal="true" aria-label="Enable your agent schedule when ready">
                        <small>2 of 2</small>
                        <strong>Make it autonomous when you’re ready</strong>
                        <span id="first-agent-schedule-tutorial-copy">After a few good manual runs, turn on the schedule. Until then, it stays paused.</span>
                        <button ref={tutorialActionRef} type="button" onClick={finishTutorial}>Finish</button>
                      </div>
                    )}
                  </div>
                )}
                {runError && !runOpen && <span class="run-err">{runError}</span>}
                {scheduleError && <span class="run-err">{scheduleError}</span>}
              </div>
            </header>

            <Capabilities meta={data.meta} model={data.model} schedule={data.schedule} scheduleHuman={data.scheduleHuman} scheduleEnabled={data.scheduleEnabled} metadata={data.metadata} />

            <StrandedLearningsBanner strandedAt={strandedAt} />

            <div class="tabs" role="tablist" aria-label="Agent views">
              {AGENT_TABS.filter((t) => t.id !== 'source' || data.source !== undefined).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-controls={`panel-${t.id}`}
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div id="panel-jobs" class="tab-panel" role="tabpanel" aria-labelledby="tab-jobs" hidden={tab !== 'jobs'}>
              <RecentJobs agentId={agentIdFromPath(data.path)} project={data.projectId} />
            </div>
            <div id="panel-learnings" class="tab-panel" role="tabpanel" aria-labelledby="tab-learnings" hidden={tab !== 'learnings'}>
              <LearningsGroup project={data.projectId} runPath={data.runPath} hoistStranded={setStrandedAt} />
            </div>
            {data.source !== undefined && (
              <div id="panel-source" class="tab-panel" role="tabpanel" aria-labelledby="tab-source" hidden={tab !== 'source'}>
                <SourcePanel source={data.source} runPath={data.runPath} project={data.projectId} path={data.path} />
              </div>
            )}

            <RunInstructionDialog
              open={runOpen}
              agentName={data.name}
              busy={busy}
              error={runError}
              onSubmit={(instruction) => { void run(instruction); }}
              onClose={() => { if (!busy) setRunOpen(false); }}
            />
          </>
        )}
      </main>
    </div>
  );
}
