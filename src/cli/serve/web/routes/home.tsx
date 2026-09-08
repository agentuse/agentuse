import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useCountUp } from '../hooks/use-count-up';
import type { ApprovalRow, ProjectInfo, SerializedSchedule, SessionRow, StoreRowsPayload } from '../lib/api';
import { fetchInfo, fetchAgents, fetchSchedules, fetchStoreRows, postSessionStop } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useHomeSections } from '../hooks/use-home-sections';
import { useMetricPrefs, type MetricDisplay } from '../hooks/use-metric-prefs';
import { useLiveHome, sessionRowKey, ORPHANED_LABEL, type ActivityEvent } from '../hooks/use-live-home';
import { isAttentionSessionDismissed, useGlobalApprovals } from '../hooks/use-global-approvals';
import { useSessionTail } from '../hooks/use-session-tail';
import { useTitle } from '../hooks/use-title';
import { UpdateBanner } from '../components/update-banner';
import { Loading } from '../components/loading';
import { pendingNewestFirst, PendingApprovalRow } from '../components/pending-approval-card';
import { displayAgentName, errorText, formatApprovalTime, formatRelativeTime, displayStatusLabel, humanizeMetric, runTone, type RunTone } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';
import { normalizeMetricValues } from '../../../../shared/metric-values';
import { isIncompleteOutcome } from '../../../../session/status';
import { consumeUpdatePreview, previewUpdate } from '../lib/update-preview';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Shared 1s clock for the header clock, elapsed timers and the countdown. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const LIVE_STATUSES = new Set(['running', 'resuming', 'continuing']);

function OnboardingRedirect() {
  useEffect(() => { window.location.replace('/onboarding'); }, []);
  return <Loading label="Opening onboarding…" />;
}

function isLiveRow(row: SessionRow): boolean {
  // A suspended parent parked on a running delegated child is live work ("running
  // · subagent"), so it counts as running even though its raw status is suspended.
  return LIVE_STATUSES.has(row.status) || row.subagentActive === true;
}

function FeedRow(props: { event: ActivityEvent }) {
  const { event } = props;
  return (
    <a class={`feed-row${event.fresh ? ' is-new' : ''}`} href={event.href}>
      <span class={`feed-dot ${event.tone}`} aria-hidden="true"></span>
      <span class="feed-agent">{event.agentName}</span>
      <span class={`feed-label ${event.tone}`}>{event.label}</span>
      <span class="feed-project">{event.project}</span>
      <span class="feed-time" title={formatApprovalTime(event.at)}>{formatRelativeTime(event.at)}</span>
    </a>
  );
}

function RunningRow(props: { row: SessionRow; now: number; ticker: boolean }) {
  const { row, now } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  // Live one-line tail of what the agent is doing right now. Capped upstream
  // (`ticker`) so a busy daemon doesn't exhaust the browser's per-host
  // connection budget; capless rows keep the static description.
  const tail = useSessionTail(row.sessionId, row.project, props.ticker);
  return (
    <a class="now-row" href={href}>
      <span class="now-dot" aria-hidden="true"></span>
      <div class="now-body">
        <div class="now-head">
          <span class="now-agent">{displayAgentName(row.agent.name, row.agent.filePath, row.agent.id)}</span>
          <span class="now-meta">{row.project} · {row.trigger}</span>
          {row.subagentActive && <span class="now-subagent" title="Work is running in a delegated subagent">subagent</span>}
        </div>
        {/* Purely visual preview of the session page it links to; hidden from AT
            so the transient fragments never pollute the link's accessible name. */}
        {tail
          ? <div class={tail.tool ? 'now-ticker tool' : 'now-ticker'} aria-hidden="true">
              <span class="now-ticker-line" key={`${tail.tool ?? ''}:${tail.text}`}>{tail.text}</span>
            </div>
          : <div class="now-desc">{row.agent.description || displayStatusLabel(row.status, row.errorCode)}</div>}
      </div>
      <span class="now-elapsed">{formatElapsed(now - row.createdAt)}</span>
    </a>
  );
}

/** Owns the 1s elapsed-time clock so the tick re-renders these rows only, not
 *  the whole dashboard. */
function WorkingNow(props: { running: SessionRow[] }) {
  const now = useNow(true);
  return (
    <section class="group">
      <h2 class="group-title"><span>Working now</span><span class="count">{props.running.length}</span><span class="rule"></span></h2>
      <div class="now-grid">
        {props.running.map((row, i) => <RunningRow key={`${row.project}:${row.sessionId}`} row={row} now={now} ticker={i < 3} />)}
      </div>
    </section>
  );
}

function FailedRow(props: { row: SessionRow; onDismiss: (row: SessionRow) => void; label?: string }) {
  const { row } = props;
  const at = row.updatedAt || row.createdAt;
  const agentName = displayAgentName(row.agent.name, row.agent.filePath, row.agent.id);
  // A declared-incomplete run reads in amber and says WHY it stopped: its code
  // word is already the label, so repeating it as `incomplete · INCOMPLETE`
  // spends the row's one line of detail on nothing.
  const incomplete = isIncompleteOutcome(row.status, row.errorCode);
  const detail = incomplete
    ? errorText(row.errorMessage)
    : (row.errorCode && row.errorCode !== 'USER_STOPPED' ? row.errorCode : '');
  return (
    <a class="attn-run" href={`/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`}>
      <span class={`feed-dot ${incomplete ? 'incomplete' : 'failed'}`} aria-hidden="true"></span>
      <span class="attn-agent">{agentName}</span>
      <span class={`attn-fail${incomplete ? ' warn' : ''}`}>
        {props.label ?? displayStatusLabel(row.status, row.errorCode)}
        {!props.label && detail && ` · ${detail}`}
      </span>
      <span class="feed-time" title={formatApprovalTime(at)}>{formatRelativeTime(at)} · review or dismiss →</span>
      <button
        type="button"
        class="attn-dismiss"
        title="Dismiss: mark this run reviewed and clear it from the list (its status is kept)"
        aria-label={`Dismiss ${agentName}`}
        onClick={(event) => {
          // The button lives inside the row link; keep the click from navigating.
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss(row);
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" /><path d="M6 6 18 18" />
        </svg>
      </button>
    </a>
  );
}

/**
 * Clears the whole needs-a-look group in one go. Dismissing stops a run and
 * stamps it reviewed, which the per-row ✕ does one at a time — fine for two
 * rows, a chore for fifteen.
 *
 * It asks first, in place rather than in a dialog: the count is the whole
 * warning, and a mis-click costs a stopped run. While it works the button
 * counts up, so a slow sweep of a long list never looks stuck.
 */
function DismissAll(props: {
  rows: SessionRow[];
  onDismissAll: (rows: SessionRow[], onProgress: (done: number) => void) => Promise<number>;
}) {
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const total = props.rows.length;
  const busy = done !== null;

  // A row dismissed elsewhere (its own ✕, another tab) shrinks the group under
  // a primed confirm, so the count on the button stops matching what it clears.
  useEffect(() => { if (!busy) setArmed(false); }, [total]);

  if (busy) return <span class="attn-more attn-dismiss-all is-busy">dismissing {done} of {total}…</span>;

  if (!armed) {
    return (
      <>
        {failedCount > 0 && <span class="attn-dismiss-failed">{failedCount} could not be dismissed</span>}
        <button type="button" class="attn-more attn-dismiss-all" onClick={() => { setArmed(true); setFailedCount(0); }}>
          dismiss all {total}
        </button>
      </>
    );
  }

  return (
    <span class="attn-dismiss-confirm">
      <button
        type="button"
        class="attn-more attn-dismiss-all is-armed"
        onClick={() => {
          setArmed(false);
          setDone(0);
          void props.onDismissAll(props.rows, (n) => setDone(n))
            .then((count) => setFailedCount(count))
            .finally(() => setDone(null));
        }}
      >dismiss {total}?</button>
      <button type="button" class="attn-more" onClick={() => setArmed(false)}>cancel</button>
    </span>
  );
}

/** How many needs-a-look rows show before the tail folds away. Pending gates are
 *  never folded: a waiting human is the whole point of the section. */
const ATTENTION_ROWS = 3;

/** How many dismissals are in flight at once during a bulk sweep. */
const DISMISS_ALL_CONCURRENCY = 4;

/** Pending gates shown before the tail folds. Twenty-plus open gates is a
 *  real state; the reviewer needs the latest few on screen, not all of them. */
const PENDING_ROWS = 8;

/** Recent-activity rows shown on Home; the full stream lives on /sessions. */
const FEED_LIMIT = 6;

/** What's blocked on a human: pending gates first, then recent failed runs, then
 *  runs stranded on a sub-agent that already ended. A stranded run is raw-status
 *  `suspended`, so it lands in neither of the first two groups — it used to fall
 *  through every home surface and sit invisible for days.
 *  Renders even when empty — "nothing waiting on you" is the answer the
 *  section exists to give. */
function AttentionSection(props: {
  pending: ApprovalRow[];
  failed: SessionRow[];
  stranded: SessionRow[];
  onDismissFailed: (row: SessionRow) => void;
  onDismissAll: (rows: SessionRow[], onProgress: (done: number) => void) => Promise<number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const { pending, failed, stranded } = props;
  const total = pending.length + failed.length + stranded.length;
  const now = useNow(pending.length > 0);
  const ordered = pendingNewestFirst(pending);
  const shownPending = pendingOpen ? ordered : ordered.slice(0, PENDING_ROWS);
  const foldedPending = ordered.length - shownPending.length;
  // Each group keeps its own head, so one long list never buries the other.
  const shownFailed = expanded ? failed : failed.slice(0, ATTENTION_ROWS);
  const shownStranded = expanded ? stranded : stranded.slice(0, ATTENTION_ROWS);
  const folded = (failed.length - shownFailed.length) + (stranded.length - shownStranded.length);
  // Everything the ✕ can clear, folded tail included. Bulk dismissal works on
  // the whole group, not the three rows that happen to be on screen: unfolding
  // fifteen rows to click fifteen ✕s is the chore it exists to remove.
  const reviewable = [...failed, ...stranded];
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Waiting on you</span>
        {total > 0 && <span class="count">{total}</span>}
        <span class="rule"></span>
      </h2>
      {total === 0
        ? <div class="attn-empty">Nothing waiting on you.</div>
        : (
          <div class="attn-list">
            {pending.length > 0 && (
              <div class="surface appr-surface pending-rows">
                {shownPending.map((row) => <PendingApprovalRow key={`${row.project}:${row.sessionId}`} row={row} now={now} />)}
                {(foldedPending > 0 || pendingOpen) && (
                  <button type="button" class="attn-more pending-more" onClick={() => setPendingOpen((on) => !on)}>
                    {pendingOpen ? 'show fewer' : `show all ${ordered.length} waiting →`}
                  </button>
                )}
              </div>
            )}
            {(shownFailed.length > 0 || shownStranded.length > 0) && (
              <div class="surface">
                {shownFailed.map((row) => <FailedRow key={`${row.project}:${row.sessionId}`} row={row} onDismiss={props.onDismissFailed} />)}
                {shownStranded.map((row) => (
                  <FailedRow
                    key={`${row.project}:${row.sessionId}`}
                    row={row}
                    label={ORPHANED_LABEL}
                    onDismiss={props.onDismissFailed}
                  />
                ))}
              </div>
            )}
            {(folded > 0 || expanded || reviewable.length > 1) && (
              <div class="attn-actions">
                {(folded > 0 || expanded) && (
                  <button type="button" class="attn-more" onClick={() => setExpanded((on) => !on)}>
                    {expanded ? 'show less' : `show all ${reviewable.length} needing a look →`}
                  </button>
                )}
                {reviewable.length > 1 && <DismissAll rows={reviewable} onDismissAll={props.onDismissAll} />}
              </div>
            )}
          </div>
        )}
    </section>
  );
}

/** One agent's runs in the window, split by outcome. */
interface AgentRuns {
  key: string;
  agentId: string;
  name: string;
  project: string;
  /** Two projects hold an agent by this name, so the row has to say which. */
  ambiguous: boolean;
  total: number;
  counts: Record<RunTone, number>;
}

/** Bar segments, left to right. Failures sit last so position — not hue alone —
 *  separates them from the waiting segment, the pair that reads closest in
 *  light mode. Running is wedged between the two for the same reason. */
const RUN_TONES: Array<{ tone: RunTone; label: string }> = [
  { tone: 'ok', label: 'completed' },
  { tone: 'waiting', label: 'waiting' },
  { tone: 'running', label: 'running' },
  { tone: 'failed', label: 'failed' },
];

/** Sessions folded into one row per agent, busiest first. Agents are kept
 *  per-project: two projects can hold different agents under the same name, and
 *  those are the only rows that pay for a project label. */
function tallyRunsByAgent(sessions: SessionRow[]): AgentRuns[] {
  const byAgent = new Map<string, AgentRuns>();
  for (const s of sessions) {
    const agentId = s.agent.id || s.agent.name;
    const key = `${s.project}\0${agentId}`;
    let bar = byAgent.get(key);
    if (!bar) {
      bar = {
        key,
        agentId,
        name: displayAgentName(s.agent.name, s.agent.filePath, s.agent.id),
        project: s.project,
        ambiguous: false,
        total: 0,
        counts: { ok: 0, waiting: 0, running: 0, failed: 0 },
      };
      byAgent.set(key, bar);
    }
    bar.counts[runTone(s.status)]++;
    bar.total++;
  }
  const bars = [...byAgent.values()];
  const nameCounts = new Map<string, number>();
  for (const bar of bars) nameCounts.set(bar.name, (nameCounts.get(bar.name) ?? 0) + 1);
  for (const bar of bars) bar.ambiguous = (nameCounts.get(bar.name) ?? 0) > 1;
  return bars.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Most agents fit on screen; past this the tail is summarized, never dropped
 *  silently. */
const TOP_AGENTS = 8;

function RunBarRow(props: { bar: AgentRuns; max: number }) {
  const { bar, max } = props;
  const parts = RUN_TONES.filter((t) => bar.counts[t.tone] > 0);
  const breakdown = parts.map((t) => `${bar.counts[t.tone]} ${t.label}`).join(', ');
  return (
    <a
      class="runbar-row"
      href={`/sessions?agent=${encodeURIComponent(bar.agentId)}&window=24h`}
      aria-label={`${bar.name}${bar.ambiguous ? ` in ${bar.project}` : ''}: ${plural(bar.total, 'run')} · ${breakdown}`}
    >
      <span class="runbar-name" title={`${bar.name} · ${bar.project}`}>
        {bar.name}
        {bar.ambiguous && <span class="runbar-project">{bar.project}</span>}
      </span>
      <span class="runbar-track" aria-hidden="true">
        <span class="runbar-fill" style={{ width: `${(bar.total / max) * 100}%` }}>
          {parts.map((t) => (
            <span
              key={t.tone}
              class={`runbar-seg ${t.tone}`}
              style={{ flexGrow: bar.counts[t.tone] }}
              title={`${bar.counts[t.tone]} ${t.label}`}
            ></span>
          ))}
        </span>
      </span>
      <span class="runbar-count" aria-hidden="true">{bar.total}</span>
    </a>
  );
}

/** Which agents actually ran, and how those runs turned out: one stacked bar per
 *  agent, longest first. The qualitative half of outcome-first Home (the Results
 *  tiles above it are the quantitative half). */
function RunsByAgent(props: { sessions: SessionRow[]; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const all = useMemo(() => tallyRunsByAgent(props.sessions), [props.sessions]);
  const bars = expanded ? all : all.slice(0, TOP_AGENTS);
  // Off the full list, so bar lengths don't rescale when the tail unfolds.
  const max = Math.max(1, ...all.map((b) => b.total));
  const totals = RUN_TONES.map((t) => ({ ...t, n: all.reduce((sum, bar) => sum + bar.counts[t.tone], 0) }))
    .filter((t) => t.n > 0);
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Runs by agent · 24h</span><span class="rule"></span>
        <a class="group-link" href="/sessions">all sessions →</a>
      </h2>
      {bars.length === 0
        ? (props.loading
          ? <Loading label="Loading runs…" />
          : <div class="metric-empty">No runs in the last 24 hours.</div>)
        : (
          <div class="runbar">
            <div class="runbar-rows surface">
              {bars.map((bar) => <RunBarRow key={bar.key} bar={bar} max={max} />)}
            </div>
            <div class="runbar-legend">
              {totals.map((t) => (
                <span class="runbar-key" key={t.tone}>
                  <span class={`runbar-swatch ${t.tone}`} aria-hidden="true"></span>
                  {t.label} <span class="runbar-key-n">{t.n}</span>
                </span>
              ))}
            </div>
            {all.length > TOP_AGENTS && (
              <button type="button" class="runbar-more" onClick={() => setExpanded((on) => !on)}>
                {expanded ? 'show less' : 'show all →'}
              </button>
            )}
          </div>
        )}
    </section>
  );
}

/** "today 2:30 PM", "tomorrow 7:30 AM", then "Monday 9:00 AM". */
function formatUpcoming(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayStart = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayDiff = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (dayDiff <= 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'long' })} ${time}`;
}

const COMING_UP_LIMIT = 5;

/** The next few scheduled runs in plain terms; hidden when nothing is scheduled. */
function ComingUp(props: { schedules: SerializedSchedule[] }) {
  const now = Date.now();
  const upcoming = props.schedules
    .filter((s) => s.enabled && s.nextRun)
    .map((s) => ({ s, at: Date.parse(s.nextRun!) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at)
    .slice(0, COMING_UP_LIMIT);
  if (upcoming.length === 0) return null;
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Coming up</span><span class="rule"></span>
        <a class="group-link" href="/schedules">all schedules →</a>
      </h2>
      <div class="panel">
        {upcoming.map(({ s, at }) => (
          <a class="up-row" key={s.id} href="/schedules">
            <span class="up-when" title={formatApprovalTime(at)}>{formatUpcoming(at, now)}</span>
            <span class="up-agent">{displayAgentName(s.agentName, s.agentPath, s.agentPath)}</span>
            <span class="up-cadence">{s.human}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function ProjectCard(props: { project: ProjectInfo; running: number; failed: number; isDefault: boolean }) {
  const { project, running, failed } = props;
  return (
    <a class={`project-card${running > 0 ? ' is-live' : ''}`} href={`/agents/${encodeURIComponent(project.id)}`} title={`${project.id} · ${project.path}`}>
      <div class="project-card-head">
        <span class={`project-card-dot${running > 0 ? ' on' : ''}`} aria-hidden="true"></span>
        <span class="project-card-name">{project.about?.name ?? project.id}</span>
        {props.isDefault && <span class="proj-default">default</span>}
        <span class="project-card-arrow" aria-hidden="true">→</span>
      </div>
      {project.about?.description && <div class="project-card-desc">{project.about.description}</div>}
      <div class="project-card-stats">
        <span><strong>{project.agentCount}</strong> agent{project.agentCount === 1 ? '' : 's'}</span>
        <span><strong>{project.scheduleCount}</strong> schedule{project.scheduleCount === 1 ? '' : 's'}</span>
        {running > 0 && <span class="project-card-running"><strong>{running}</strong> running</span>}
        {failed > 0 && <span class="project-card-failed"><strong>{failed}</strong> broken</span>}
      </div>
    </a>
  );
}

/** One raw metric record's contribution, kept for the tile charts. */
interface MetricEvent {
  at: number;
  value: number | null;
  count: number | null;
}

/** One record_metric name rolled up across projects for the results window. */
interface MetricAgg {
  metric: string;
  count: number;
  hasCount: boolean;
  value: number;
  hasValue: boolean;
  unit: string | null;
  mixedUnits: boolean;
  latestAt: number;
  note?: string | undefined;
  events: MetricEvent[];
}

/** Selectable Results rollup windows; 30 is also the section-visibility probe. */
const METRIC_WINDOW_DAYS = [1, 7, 14, 30] as const;
const METRICS_WINDOW_KEY = 'agentuse-home-results-window';

function readMetricsWindow(): number {
  try {
    const stored = Number(localStorage.getItem(METRICS_WINDOW_KEY));
    return (METRIC_WINDOW_DAYS as readonly number[]).includes(stored) ? stored : 7;
  } catch {
    return 7;
  }
}

/**
 * Fold reserved-store metric records (tools__record_metric) from every project
 * into one rollup per metric name. Sums are plain code over runtime-stamped
 * records - no model output is ever in the math path of a displayed number.
 */
function aggregateMetrics(payload: StoreRowsPayload | null | undefined, windowDays: number): MetricAgg[] {
  if (!payload) return [];
  const cutoff = Date.now() - windowDays * 24 * 3_600_000;
  const byMetric = new Map<string, MetricAgg>();
  for (const row of payload.rows) {
    for (const item of row.items) {
      if (item.type !== 'metric') continue;
      const metric = item.data.metric;
      if (typeof metric !== 'string') continue;
      const at = Date.parse(item.updatedAt);
      if (!Number.isFinite(at) || at < cutoff) continue;

      let agg = byMetric.get(metric);
      if (!agg) {
        agg = { metric, count: 0, hasCount: false, value: 0, hasValue: false, unit: null, mixedUnits: false, latestAt: 0, events: [] };
        byMetric.set(metric, agg);
      }
      const { note } = item.data;
      const { count, value, unit } = normalizeMetricValues(item.data);
      agg.events.push({
        at,
        value,
        count,
      });
      if (count !== null) {
        agg.count += count;
        agg.hasCount = true;
      }
      if (value !== null) {
        agg.value += value;
        agg.hasValue = true;
        // A metric name owns one unit; on a mismatch show the count only
        // rather than summing dollars into minutes.
        if (unit !== null) {
          if (agg.unit === null) agg.unit = unit;
          else if (agg.unit !== unit) agg.mixedUnits = true;
        }
      }
      if (at > agg.latestAt) {
        agg.latestAt = at;
        agg.note = typeof note === 'string' ? note : undefined;
      }
    }
  }
  return [...byMetric.values()].sort((a, b) => b.latestAt - a.latestAt);
}

/** Apply the viewer's manual tile order; unlisted metrics keep freshest-first. */
function orderMetrics(aggs: MetricAgg[], order: string[]): MetricAgg[] {
  if (order.length === 0) return aggs;
  const rank = new Map(order.map((metric, i) => [metric, i]));
  return [...aggs].sort((a, b) => {
    const ra = rank.get(a.metric);
    const rb = rank.get(b.metric);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return b.latestAt - a.latestAt;
  });
}

/** Metric events folded into per-day buckets (per-hour on the 1-day window),
 *  oldest first. Same plain-code-only rule as the sums above. */
function bucketMetricSeries(events: MetricEvent[], windowDays: number, useValue: boolean, now: number): number[] {
  const bucketCount = windowDays === 1 ? 24 : windowDays;
  const bucketMs = windowDays === 1 ? 3_600_000 : 86_400_000;
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const event of events) {
    const idx = bucketCount - 1 - Math.floor((now - event.at) / bucketMs);
    if (idx < 0 || idx >= bucketCount) continue;
    buckets[idx] += useValue ? (event.value ?? 0) : (event.count ?? 1);
  }
  return buckets;
}

const SPARK_W = 120;
const SPARK_H = 30;

/** Inline tile chart: bars = per-bucket totals, line = cumulative running
 *  total across the window. Decorative next to the number, so aria-hidden. */
function MetricSpark(props: { series: number[]; kind: 'bars' | 'line' }) {
  const { series, kind } = props;
  if (kind === 'bars') {
    const max = Math.max(1, ...series);
    const slot = SPARK_W / series.length;
    const barW = Math.max(1, slot - 1.5);
    return (
      <svg class="metric-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        {series.map((v, i) => {
          const h = v === 0 ? 1 : Math.max(2, (v / max) * (SPARK_H - 2));
          return <rect key={i} class={v === 0 ? 'none' : 'bar'} x={i * slot} y={SPARK_H - h} width={barW} height={h} rx="1" />;
        })}
      </svg>
    );
  }
  let total = 0;
  const cumulative = series.map((v) => (total += v));
  const max = Math.max(1, total);
  const step = SPARK_W / Math.max(1, series.length - 1);
  const points = cumulative.map((v, i) => `${(i * step).toFixed(1)},${(SPARK_H - 1.5 - (v / max) * (SPARK_H - 3)).toFixed(1)}`);
  return (
    <svg class="metric-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon class="area" points={`0,${SPARK_H} ${points.join(' ')} ${SPARK_W},${SPARK_H}`} />
      <polyline class="line" points={points.join(' ')} />
    </svg>
  );
}

const METRIC_DISPLAYS: Array<{ id: MetricDisplay; label: string; glyph: string }> = [
  { id: 'number', label: 'Number only', glyph: '#' },
  { id: 'bars', label: 'Bar chart', glyph: '▮▮' },
  { id: 'line', label: 'Trend line', glyph: '⟋' },
];

interface MetricTileEdit {
  hidden: boolean;
  canLeft: boolean;
  canRight: boolean;
  onMove: (dir: -1 | 1) => void;
  onToggleHidden: () => void;
  onDisplay: (display: MetricDisplay) => void;
}

function MetricTile(props: { agg: MetricAgg; windowDays: number; display: MetricDisplay; edit?: MetricTileEdit | undefined }) {
  const { agg, display, edit } = props;
  const showValue = agg.hasValue && !agg.mixedUnits;
  const big = useCountUp(Math.round(showValue ? agg.value : agg.count));
  const bigLabel = showValue
    ? (agg.unit === 'usd' ? `$${big.toLocaleString()}` : `${big.toLocaleString()}${agg.unit ? ` ${agg.unit}` : ''}`)
    : big.toLocaleString();
  const sub = [
    showValue && agg.hasCount ? plural(agg.count, 'item') : null,
    agg.mixedUnits ? 'mixed units - showing count' : null,
    agg.note ?? null,
  ].filter(Boolean).join(' · ');
  const name = humanizeMetric(agg.metric);
  const body = (
    <>
      <div class="metric-num">{bigLabel}</div>
      <div class="metric-name">{name}</div>
      {display !== 'number' && (
        <MetricSpark series={bucketMetricSeries(agg.events, props.windowDays, showValue, Date.now())} kind={display} />
      )}
      {sub && <div class="metric-sub">{sub}</div>}
    </>
  );
  if (!edit) {
    return <a class="metric-tile" href="/stores/metrics" title={agg.metric}>{body}</a>;
  }
  // Edit mode swaps the link for a still tile with its own controls; hidden
  // tiles stay on the board (dimmed) so they can be turned back on.
  return (
    <div class={`metric-tile is-editing${edit.hidden ? ' is-hidden' : ''}`} title={agg.metric}>
      {body}
      <div class="metric-tools">
        <button type="button" aria-label={`Move ${name} earlier`} title="Move earlier" disabled={!edit.canLeft} onClick={() => edit.onMove(-1)}>←</button>
        <button type="button" aria-label={`Move ${name} later`} title="Move later" disabled={!edit.canRight} onClick={() => edit.onMove(1)}>→</button>
        <span class="metric-tools-gap"></span>
        {METRIC_DISPLAYS.map((option) => (
          <button
            type="button"
            key={option.id}
            class={display === option.id ? 'on' : ''}
            aria-label={`${option.label} for ${name}`}
            aria-pressed={display === option.id}
            title={option.label}
            onClick={() => edit.onDisplay(option.id)}
          >{option.glyph}</button>
        ))}
        <span class="metric-tools-gap"></span>
        <button
          type="button"
          class={edit.hidden ? '' : 'on'}
          aria-label={edit.hidden ? `Show ${name}` : `Hide ${name}`}
          aria-pressed={!edit.hidden}
          title={edit.hidden ? 'Show this metric' : 'Hide this metric'}
          onClick={edit.onToggleHidden}
        >{edit.hidden ? 'hidden' : 'shown'}</button>
      </div>
    </div>
  );
}

/** "Wednesday, August 19 · 4:55 PM" — the header's clock line. */
function formatClock(now: number): string {
  const d = new Date(now);
  const day = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** The header clock line ticks once a second; isolating it keeps that tick
 *  from re-rendering the whole page. */
function HomeClock() {
  const now = useNow(true);
  return <div class="home-date">{formatClock(now)}</div>;
}

/** "· next run <agent> in 12:34" for the header stat line. Owns its own 1s
 *  clock and the post-fire refetch loop. */
function NextRunStat(props: { nextSchedule: { at: number; agentPath: string }; refetch: () => void }) {
  const now = useNow(true);
  const countdownMs = props.nextSchedule.at - now;
  // When the countdown fires, the schedule's nextRun is stale until the
  // scheduler actually triggers (jitter can hold it past zero); keep
  // refetching every few seconds until nextRun rolls forward so the hero
  // never hangs on a fired schedule.
  const countdownFired = countdownMs <= 0;
  const { refetch } = props;
  useEffect(() => {
    if (!countdownFired) return;
    const timer = setInterval(() => refetch(), 4000);
    return () => clearInterval(timer);
  }, [countdownFired, refetch]);
  return (
    <>
      {' '}· next run <span class="home-stat-agent">{props.nextSchedule.agentPath.replace(/\.agentuse$/, '')}</span>
      {countdownFired
        ? <> <span class="home-countdown">is starting…</span></>
        : <> in <span class="home-countdown">{formatCountdown(countdownMs)}</span></>}
    </>
  );
}

export default function Home() {
  useTitle(pageTitle());
  const [previewRequested] = useState(() => consumeUpdatePreview());
  const { data, error, loading } = useFetch('home', () => fetchInfo(), { refreshMs: 30_000 });
  const liveHome = useLiveHome();
  const attentionState = useGlobalApprovals();
  // The operator's first question is whether anything needs action. Fleet-wide
  // agent parsing and metric-store scans can be materially slower on large
  // installations, so do not let those secondary requests contend with the
  // sessions and approvals snapshots during the critical first paint.
  const primaryReady = data !== null && !liveHome.loading && !attentionState.loading;

  // Agent parse failures are counted on their project card, using the same
  // payload as /agents rather than hiding one aggregate warning in the footer.
  const agents = useFetch('home-agents', () => fetchAgents(), { refreshMs: 30_000, enabled: primaryReady });
  const failedAgentsByProject = new Map<string, number>();
  for (const failure of agents.data?.errors ?? []) {
    failedAgentsByProject.set(failure.projectId, (failedAgentsByProject.get(failure.projectId) ?? 0) + 1);
  }

  // Soonest upcoming scheduled run powers the hero countdown; refresh often
  // enough that a fired schedule rolls over to the next one without a reload.
  const schedules = useFetch('home-schedules', () => fetchSchedules(), { refreshMs: 60_000, enabled: primaryReady });
  const nextSchedule = useMemo(() => {
    let best: { at: number; agentPath: string } | null = null;
    for (const s of schedules.data?.schedules ?? []) {
      if (!s.enabled || !s.nextRun) continue;
      const at = Date.parse(s.nextRun);
      if (!Number.isFinite(at)) continue;
      if (!best || at < best.at) best = { at, agentPath: s.agentPath };
    }
    return best;
  }, [schedules.data]);

  // Agent-recorded business metrics (reserved "metrics" store). Missing store
  // is normal and returns empty rows, so the section simply doesn't render.
  // Visibility probes the widest window so picking a quiet 1-day view leaves
  // the section (and its window toggle) on screen instead of stranding you.
  const metricRows = useFetch('home-metrics', () => fetchStoreRows('metrics'), { refreshMs: 60_000, enabled: primaryReady });
  const [metricsWindow, setMetricsWindowState] = useState(() => readMetricsWindow());
  const setMetricsWindow = (days: number) => {
    try {
      if (days === 7) localStorage.removeItem(METRICS_WINDOW_KEY);
      else localStorage.setItem(METRICS_WINDOW_KEY, String(days));
    } catch {
      // Private/restricted contexts may deny localStorage; the tab still switches.
    }
    setMetricsWindowState(days);
  };
  const metricAggs = useMemo(() => aggregateMetrics(metricRows.data, metricsWindow), [metricRows.data, metricsWindow]);
  const hasAnyMetrics = useMemo(
    () => (metricsWindow === 30 ? metricAggs : aggregateMetrics(metricRows.data, 30)).length > 0,
    [metricRows.data, metricsWindow, metricAggs]
  );

  // Per-viewer tile customization: manual order, hidden metrics, and per-metric
  // display. Edit mode keeps hidden tiles on the board so they can come back.
  const metricPrefs = useMetricPrefs();
  const [editMetrics, setEditMetrics] = useState(false);
  const orderedAggs = useMemo(() => orderMetrics(metricAggs, metricPrefs.prefs.order), [metricAggs, metricPrefs.prefs.order]);
  const shownAggs = editMetrics
    ? orderedAggs
    : orderedAggs.filter((agg) => !metricPrefs.prefs.hidden.includes(agg.metric));
  const moveMetric = (metric: string, dir: -1 | 1) => {
    // Persist the full on-screen order so one nudge pins every tile's slot.
    const names = orderedAggs.map((agg) => agg.metric);
    const from = names.indexOf(metric);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= names.length) return;
    const swapped = names[to]!;
    names[to] = metric;
    names[from] = swapped;
    metricPrefs.setOrder(names);
  };

  const sections = useHomeSections();
  // The guided demo is product education, not fleet activity, so exclude it
  // from operational counts, attention queues, charts, and the activity feed.
  const operationalSessions = useMemo(
    () => liveHome.sessions.filter((session) => session.trigger !== 'onboarding'),
    [liveHome.sessions]
  );
  const running = useMemo(() => operationalSessions.filter(isLiveRow), [operationalSessions]);
  // subagentActive rows are live work (counted in `running`), not blocked on a
  // human, so they must not also show up as waiting.
  const waiting = useMemo(
    () => operationalSessions.filter((s) => s.status === 'suspended' && !s.subagentActive),
    [operationalSessions]
  );
  // Recent failures surface in "Needs your attention" alongside pending gates.
  // Not every failed-tone run is waiting on a human: runs the reviewer stopped
  // themselves (USER_STOPPED) or already reviewed and discarded (dismissedAt,
  // via the session page's Discard button or the row's hover ✕) are
  // acknowledged, so they stay out. The shared app-root dismissal mask hides a
  // just-dismissed row instantly even when Discard happened on another route.
  const dismissRow = useCallback((row: SessionRow): Promise<boolean> => {
    const identity = { project: row.project, sessionId: row.sessionId };
    attentionState.dismissAttentionSession(identity);
    return postSessionStop(row.sessionId, undefined, { project: row.project, reason: 'Discarded from home' })
      .then(() => true)
      .catch(() => {
        // Dismissal did not land; put the row back so it isn't silently lost.
        attentionState.restoreAttentionSession(identity);
        return false;
      });
  }, [attentionState.dismissAttentionSession, attentionState.restoreAttentionSession]);
  const dismissFailed = useCallback((row: SessionRow) => { void dismissRow(row); }, [dismissRow]);
  // Bulk dismissal is the same per-row call, a few at a time: each one stops a
  // session on the daemon, so firing fifty at once would queue behind itself
  // anyway and lose the running count. Returns how many failed, since a partial
  // sweep leaves rows on screen and the reviewer deserves to know why.
  const dismissAll = useCallback(async (rows: SessionRow[], onProgress: (done: number) => void): Promise<number> => {
    let next = 0;
    let done = 0;
    let failures = 0;
    const worker = async (): Promise<void> => {
      while (next < rows.length) {
        const row = rows[next++]!;
        if (!await dismissRow(row)) failures += 1;
        onProgress(++done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DISMISS_ALL_CONCURRENCY, rows.length) }, worker));
    return failures;
  }, [dismissRow]);
  const dismissedAttention = attentionState.dismissedAttentionSessions;
  // Not truncated here: the section itself folds the tail behind "show all", so
  // the header count is the real number of runs waiting on a review.
  const failedRecent = useMemo(() => operationalSessions
    .filter((s) => runTone(s.status) === 'failed' && s.errorCode !== 'USER_STOPPED' && s.dismissedAt === undefined
      && !isAttentionSessionDismissed(dismissedAttention, s))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)), [operationalSessions, dismissedAttention]);
  // Runs parked on a delegated sub-agent that has since ended. They read as
  // `suspended`, so neither the failed filter above nor the pending-gate list
  // catches them, yet nothing will ever move them: the only way out is a human
  // stopping the run. Dismissing one stops it, which is exactly the fix.
  const orphanedGates = liveHome.suspendedGates.orphaned;
  const strandedRecent = useMemo(() => operationalSessions
    .filter((s) => orphanedGates.has(sessionRowKey(s)) && s.dismissedAt === undefined
      && !isAttentionSessionDismissed(dismissedAttention, s))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)), [operationalSessions, orphanedGates, dismissedAttention]);
  const pendingApprovals = liveHome.pendingApprovals;
  // Suspended rows with no live or expired gate are mid-flight (a delegated
  // leaf running under a decided cascade approval, or a resume in progress),
  // so don't advertise them as blocked on a human.
  const allWaitingResuming = liveHome.suspendedGates.loaded && waiting.every((s) =>
    !liveHome.suspendedGates.pending.has(sessionRowKey(s)) && !liveHome.suspendedGates.expired.has(sessionRowKey(s)));

  const projects = data?.projects ?? [];
  const noProjects = Boolean(data) && projects.length === 0;
  const noAgents = Boolean(data) && projects.length > 0 && projects.every((project) => project.agentCount === 0);
  const runningByProject = new Map<string, number>();
  for (const row of running) runningByProject.set(row.project, (runningByProject.get(row.project) ?? 0) + 1);

  // One ambient state drives the background tint: running beats waiting beats idle.
  const ambient = running.length > 0 ? 'running' : (pendingApprovals > 0 || waiting.length > 0) ? 'waiting' : 'idle';

  // Header sentence + stat line. "Waiting on you" counts what the section of
  // the same name lists: pending gates, recent failures, stranded runs.
  const waitingOnYou = liveHome.pendingRows.length + failedRecent.length + strandedRecent.length;
  const runs24h = operationalSessions.length;
  // Crashes only, matching the /sessions?status=error filter this stat links to.
  // A run the agent declared incomplete is listed under its own filter there.
  const failed24h = operationalSessions.filter((s) =>
    runTone(s.status) === 'failed' && !isIncompleteOutcome(s.status, s.errorCode)).length;
  const ended24h = operationalSessions.filter((s) => { const t = runTone(s.status); return t === 'ok' || t === 'failed'; }).length;
  const successPct = ended24h > 0 ? Math.round(((ended24h - failed24h) / ended24h) * 100) : null;

  if (noProjects || noAgents) {
    return <OnboardingRedirect />;
  }

  return (
    <div class="page-home" data-ambient={ambient}>
      <div class="home-ambient" aria-hidden="true"></div>
      <main class="home-boot">
        {(previewRequested && data)
          ? <UpdateBanner update={previewUpdate(data.version)} persistDismissal={false} />
          : data?.update && <UpdateBanner update={data.update} />}
        <header class="home-head" aria-live="polite">
          <HomeClock />
          <h1 class="home-sentence">
            <span class={`hero-dot${running.length > 0 ? ' on' : ''}`} aria-hidden="true"></span>
            {running.length === 0
              ? 'No agents are working right now.'
              : `${plural(running.length, 'agent')} ${running.length === 1 ? 'is' : 'are'} working.`}
            {' '}
            {waitingOnYou > 0
              ? <span class="home-waiting">{waitingOnYou === 1 ? '1 thing is' : `${waitingOnYou} things are`} waiting on you.</span>
              : waiting.length > 0
                ? <span class="home-quiet">{plural(waiting.length, 'session')} {allWaitingResuming ? 'resuming' : 'suspended'}.</span>
                : <span class="home-quiet">Nothing is waiting on you.</span>}
          </h1>
          <div class="home-stat">
            {runs24h > 0
              ? <>
                  {runs24h} runs in the last 24 hours
                  {successPct !== null && <> · {successPct}% succeeded</>}
                  {failed24h > 0 && <> · <a class="home-stat-failed" href="/sessions?status=error">{failed24h} failed</a></>}
                </>
              : 'No runs in the last 24 hours'}
            {nextSchedule && <NextRunStat nextSchedule={nextSchedule} refetch={schedules.refetch} />}
          </div>
          {error && <div class="errors" role="alert">Failed to load: {error.message}</div>}
          {liveHome.error && <div class="errors" role="alert">Failed to load sessions: {liveHome.error.message}</div>}
        </header>

        {sections.isVisible('running') && running.length > 0 && <WorkingNow running={running} />}

        {sections.isVisible('attention') && (
          <AttentionSection pending={liveHome.pendingRows} failed={failedRecent} stranded={strandedRecent} onDismissFailed={dismissFailed} onDismissAll={dismissAll} />
        )}

        {sections.isVisible('results') && hasAnyMetrics && (
          <section class="group">
            <h2 class="group-title">
              <span>Results</span>
              <div class="metric-window" role="group" aria-label="Results window">
                {METRIC_WINDOW_DAYS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    class={days === metricsWindow ? 'on' : ''}
                    aria-pressed={days === metricsWindow}
                    onClick={() => setMetricsWindow(days)}
                  >
                    {days}d
                  </button>
                ))}
              </div>
              <span class="rule"></span>
              <button
                type="button"
                class={`metric-edit-btn${editMetrics ? ' on' : ''}`}
                aria-pressed={editMetrics}
                onClick={() => setEditMetrics((on) => !on)}
              >
                {editMetrics ? 'done' : 'customize'}
              </button>
            </h2>
            {shownAggs.length > 0
              ? (
                <div class="metric-grid">
                  {shownAggs.map((agg, i) => (
                    <MetricTile
                      key={agg.metric}
                      agg={agg}
                      windowDays={metricsWindow}
                      display={metricPrefs.prefs.display[agg.metric] ?? 'number'}
                      edit={editMetrics
                        ? {
                          hidden: metricPrefs.prefs.hidden.includes(agg.metric),
                          canLeft: i > 0,
                          canRight: i < shownAggs.length - 1,
                          onMove: (dir) => moveMetric(agg.metric, dir),
                          onToggleHidden: () => metricPrefs.toggleHidden(agg.metric),
                          onDisplay: (display) => metricPrefs.setDisplay(agg.metric, display),
                        }
                        : undefined}
                    />
                  ))}
                </div>
              )
              : (
                <div class="metric-empty">
                  {metricAggs.length > 0
                    ? <>All metrics are hidden. <button type="button" class="metric-empty-link" onClick={() => setEditMetrics(true)}>Customize</button> to bring them back.</>
                    : <>No results in the last {metricsWindow === 1 ? 'day' : `${metricsWindow} days`}.</>}
                </div>
              )}
          </section>
        )}

        {sections.isVisible('latest') && (
          <RunsByAgent sessions={operationalSessions} loading={liveHome.loading} />
        )}

        {(sections.isVisible('coming-up') || sections.isVisible('feed')) && (
          <div class="home-cols">
            {sections.isVisible('coming-up') && (
              <ComingUp schedules={schedules.data?.schedules ?? []} />
            )}
            {sections.isVisible('feed') && (
              <section class="group">
                <h2 class="group-title">
                  <span>Recent activity</span><span class="rule"></span>
                  <a class="group-link" href="/sessions">everything →</a>
                </h2>
                <div class="panel feed">
                  {liveHome.feed.length === 0
                    ? (liveHome.loading
                      ? <Loading label="Loading activity…" />
                      : <div class="empty">No runs in the last 24 hours.</div>)
                    : liveHome.feed.slice(0, FEED_LIMIT).map((event) => <FeedRow key={event.key} event={event} />)}
                </div>
              </section>
            )}
          </div>
        )}

        {sections.isVisible('projects') && (
          <section class="group home-projects">
            <h2 class="group-title">
              <span>{term('project', projects.length)}</span>
              {projects.length > 0 && <span class="count">{projects.length}</span>}
              <span class="rule"></span>
            </h2>
            {projects.length === 0
              ? (loading ? <Loading label={`Loading ${term('project', 2)}…`} /> : null)
              : (
                <div class="project-grid">
                  {projects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      running={runningByProject.get(project.id) ?? 0}
                      failed={failedAgentsByProject.get(project.id) ?? 0}
                      isDefault={project.id === data?.default}
                    />
                  ))}
                </div>
              )}
          </section>
        )}

        {data && (
          <footer class="home-version-foot">
            <span>AgentUse</span>
            <span>
              {data.dev && <span class="home-dev-tag" title="Unreleased development build">dev</span>}
              v{data.version}
            </span>
          </footer>
        )}
      </main>
    </div>
  );
}
