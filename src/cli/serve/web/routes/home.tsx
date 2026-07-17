import { useCallback, useEffect, useState } from 'preact/hooks';
import { useCountUp } from '../hooks/use-count-up';
import type { ApprovalRow, SerializedSchedule, SessionRow, StoreRowsPayload } from '../lib/api';
import { fetchInfo, fetchAgents, fetchSchedules, fetchStoreRows, postSessionStop } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useHomeSections } from '../hooks/use-home-sections';
import { useMetricPrefs, type MetricDisplay } from '../hooks/use-metric-prefs';
import { useLiveHome, sessionRowKey, type ActivityEvent } from '../hooks/use-live-home';
import { useSessionTail } from '../hooks/use-session-tail';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { formatApprovalTime, formatRelativeTime, displayStatusLabel, humanizeMetric, runTone } from '../lib/format';
import { brandName, pageTitle } from '../lib/brand';
import { term, termTitle } from '../lib/terms';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const CARDS: Array<{ href: string; title: string; desc: string }> = [
  { href: '/agents', title: 'Agents', desc: 'Browse the agents loaded by this daemon.' },
  { href: '/sessions', title: 'Sessions', desc: 'Run logs and approvals for every run.' },
  { href: '/schedules', title: 'Schedules', desc: 'Upcoming and recent scheduled runs.' },
  { href: '/stores', title: 'Stores', desc: 'Key-value data written by agents.' },
  { href: '/approvals', title: 'Approvals', desc: 'Tool calls awaiting a decision.' },
];

/** Shared 1s clock for the elapsed timers and the next-run countdown. */
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

function RunningCard(props: { row: SessionRow; now: number; ticker: boolean }) {
  const { row, now } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  // Live one-line tail of what the agent is doing right now. Capped upstream
  // (`ticker`) so a busy daemon doesn't exhaust the browser's per-host
  // connection budget; capless cards keep the static description.
  const tail = useSessionTail(row.sessionId, row.project, props.ticker);
  return (
    <a class="now-card" href={href}>
      <div class="now-card-head">
        <span class="now-dot" aria-hidden="true"></span>
        <span class="now-agent">{row.agent.name || row.agent.id}</span>
        {row.subagentActive && <span class="now-subagent" title="Work is running in a delegated subagent">subagent</span>}
        <span class="now-elapsed">{formatElapsed(now - row.createdAt)}</span>
      </div>
      {/* Purely visual preview of the session page it links to; hidden from AT
          so the transient fragments never pollute the link's accessible name. */}
      {tail
        ? <div class={tail.tool ? 'now-ticker tool' : 'now-ticker'} aria-hidden="true">
            <span class="now-ticker-line" key={`${tail.tool ?? ''}:${tail.text}`}>{tail.text}</span>
          </div>
        : <div class="now-desc">{row.agent.description || displayStatusLabel(row.status, row.errorCode)}</div>}
      <div class="now-meta">{row.project} · {row.trigger}</div>
    </a>
  );
}

/** Time a gate has been waiting on a human, as a compact "waiting 26m". */
function formatWaiting(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'waiting now';
  if (min < 60) return `waiting ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `waiting ${hr}h`;
  return `waiting ${Math.floor(hr / 24)}d`;
}

function ApprovalCard(props: { row: ApprovalRow }) {
  const { row } = props;
  const since = row.suspendedAt ?? row.createdAt;
  return (
    <a class="attn-card" href={`/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`}>
      <div class="attn-head">
        <span class="attn-kind">approval</span>
        <span class="attn-agent">{row.agentName || row.agentId}</span>
        {since !== undefined && <span class="attn-wait" title={formatApprovalTime(since)}>{formatWaiting(Date.now() - since)}</span>}
      </div>
      {(row.summary || row.prompt) && <div class="attn-summary">{row.summary || row.prompt}</div>}
      <div class="attn-meta">
        {row.project}
        {row.risk && <> · <span class="attn-risk">{row.risk}</span></>}
        <span class="attn-go"> · approve or reject →</span>
      </div>
    </a>
  );
}

function FailedRow(props: { row: SessionRow; onDismiss: (row: SessionRow) => void }) {
  const { row } = props;
  const at = row.updatedAt || row.createdAt;
  return (
    <a class="attn-run" href={`/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`}>
      <span class="feed-dot failed" aria-hidden="true"></span>
      <span class="attn-agent">{row.agent.name || row.agent.id}</span>
      <span class="attn-fail">{displayStatusLabel(row.status, row.errorCode)} · needs a look</span>
      <span class="feed-time" title={formatApprovalTime(at)}>{formatRelativeTime(at)}</span>
      <button
        type="button"
        class="attn-dismiss"
        title="Dismiss: mark this run reviewed and clear it from the list (its status is kept)"
        aria-label={`Dismiss ${row.agent.name || row.agent.id}`}
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

/** What's blocked on a human: pending gates first, then recent failed runs.
 *  Renders even when empty — "nothing waiting on you" is the answer the
 *  section exists to give. */
function AttentionSection(props: { pending: ApprovalRow[]; failed: SessionRow[]; onDismissFailed: (row: SessionRow) => void }) {
  const { pending, failed } = props;
  const total = pending.length + failed.length;
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Needs your attention</span>
        {total > 0 && <span class="count">{total}</span>}
        <span class="rule"></span>
      </h2>
      {total === 0
        ? <div class="attn-empty">Nothing waiting on you.</div>
        : (
          <div class="attn-list">
            {pending.map((row) => <ApprovalCard key={`${row.project}:${row.sessionId}`} row={row} />)}
            {failed.map((row) => <FailedRow key={`${row.project}:${row.sessionId}`} row={row} onDismiss={props.onDismissFailed} />)}
          </div>
        )}
    </section>
  );
}

/** First meaningful line of a final response, stripped of markdown dressing. */
function responseOneLiner(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s#>*-]+/, '').replace(/\*\*/g, '').trim();
    if (line && !line.startsWith('|') && !/^[-=:|\s]+$/.test(line)) return line;
  }
  return '';
}

const LATEST_PER_PROJECT = 3;

/** Completed runs' final responses as one-liners, grouped by project with the
 *  freshest project first. The qualitative half of outcome-first Home (the
 *  Results tiles above it are the quantitative half). */
function LatestResults(props: { sessions: SessionRow[]; showProject: boolean; loading: boolean }) {
  const done = props.sessions
    .filter((s) => s.status === 'completed' && s.finalResponse && responseOneLiner(s.finalResponse))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  const byProject = new Map<string, SessionRow[]>();
  for (const s of done) {
    const rows = byProject.get(s.project) ?? [];
    if (rows.length < LATEST_PER_PROJECT) byProject.set(s.project, [...rows, s]);
  }
  const groups = [...byProject.entries()];
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Latest results</span><span class="rule"></span>
        <a class="group-link" href="/sessions">view all →</a>
      </h2>
      {groups.length === 0
        ? (props.loading
          ? <Loading label="Loading results…" />
          : <div class="metric-empty">No completed runs in the last 24 hours.</div>)
        : (
          <div class="latest-groups">
            {groups.map(([project, rows]) => (
              <div class="latest-group" key={project}>
                {props.showProject && <div class="latest-project">{project}</div>}
                <div class="panel">
                  {rows.map((row) => {
                    const at = row.updatedAt || row.createdAt;
                    return (
                      <a
                        class="latest-row"
                        key={`${row.project}:${row.sessionId}`}
                        href={`/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`}
                      >
                        <span class="latest-agent">{row.agent.name || row.agent.id}</span>
                        <span class="latest-text">{responseOneLiner(row.finalResponse!)}</span>
                        <span class="feed-time" title={formatApprovalTime(at)}>{formatRelativeTime(at)}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
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
            <span class="up-agent">{s.agentName || s.agentPath.replace(/\.agentuse$/, '')}</span>
            <span class="up-cadence">{s.human}</span>
          </a>
        ))}
      </div>
    </section>
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
      const { count, value, unit, note } = item.data;
      agg.events.push({
        at,
        value: typeof value === 'number' && Number.isFinite(value) ? value : null,
        count: typeof count === 'number' && Number.isFinite(count) ? count : null,
      });
      if (typeof count === 'number' && Number.isFinite(count)) {
        agg.count += count;
        agg.hasCount = true;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        agg.value += value;
        agg.hasValue = true;
        // A metric name owns one unit; on a mismatch show the count only
        // rather than summing dollars into minutes.
        if (typeof unit === 'string') {
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

interface SparkBucket { ok: number; failed: number; live: number }

/** Sessions folded into 24 hours-ago buckets, oldest first. */
function bucketize(sessions: SessionRow[], now: number): SparkBucket[] {
  const buckets: SparkBucket[] = Array.from({ length: 24 }, () => ({ ok: 0, failed: 0, live: 0 }));
  for (const s of sessions) {
    const hoursAgo = Math.floor((now - s.createdAt) / 3_600_000);
    if (hoursAgo < 0 || hoursAgo > 23) continue;
    const b = buckets[23 - hoursAgo]!;
    const tone = runTone(s.status);
    if (tone === 'ok') b.ok++;
    else if (tone === 'failed') b.failed++;
    else b.live++;
  }
  return buckets;
}

const SPARK_MAX_PX = 30;

/**
 * Runs-per-hour sparkline with outcome coloring. Failures always sit as the
 * topmost segment above a gap (position, not just hue, separates them) and the
 * stat line spells the counts out, so the red/green split never carries the
 * message alone. Per-bar totals stay on native tooltips.
 */
function ActivitySpark(props: { sessions: SessionRow[] }) {
  // Fresh on every render (the live stream re-renders Home continuously), so
  // the hours-ago buckets roll forward without needing the shared 1s clock —
  // which stops ticking on an idle daemon and would freeze the window.
  const buckets = bucketize(props.sessions, Date.now());
  const okTotal = buckets.reduce((n, b) => n + b.ok, 0);
  const failedTotal = buckets.reduce((n, b) => n + b.failed, 0);
  const total = okTotal + failedTotal + buckets.reduce((n, b) => n + b.live, 0);
  const shownTotal = useCountUp(total);
  if (total === 0) return null;
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.failed + b.live));
  const px = (n: number) => (n === 0 ? 0 : Math.max(2, Math.round((n / max) * SPARK_MAX_PX)));
  const ended = okTotal + failedTotal;
  const pct = ended > 0 ? Math.round((okTotal / ended) * 100) : null;
  return (
    <div class="hero-spark">
      <div
        class="spark-bars"
        role="img"
        aria-label={`Runs per hour over the last 24 hours: ${plural(total, 'run')}, ${failedTotal} failed.`}
      >
        {buckets.map((b, i) => {
          const runs = b.ok + b.failed + b.live;
          const hoursAgo = 23 - i;
          const when = hoursAgo === 0 ? 'past hour' : `${hoursAgo}–${hoursAgo + 1}h ago`;
          return (
            <span class="spark-col" key={i} title={`${when} · ${plural(runs, 'run')}${b.failed > 0 ? ` · ${b.failed} failed` : ''}`}>
              {b.failed > 0 && <span class="spark-seg failed" style={{ height: `${px(b.failed)}px` }}></span>}
              {b.live > 0 && <span class="spark-seg live" style={{ height: `${px(b.live)}px` }}></span>}
              {b.ok > 0 && <span class="spark-seg ok" style={{ height: `${px(b.ok)}px` }}></span>}
              {runs === 0 && <span class="spark-seg none"></span>}
            </span>
          );
        })}
      </div>
      <div class="spark-stat">
        <span class="spark-total">{shownTotal}</span> runs in 24h
        {pct !== null && <span class="spark-rate"> · {pct}% succeeded</span>}
        {failedTotal > 0 && <> · <a class="spark-failed" href="/sessions?status=error">{failedTotal} failed</a></>}
      </div>
    </div>
  );
}

export default function Home() {
  useTitle(pageTitle());
  const { data, error, loading } = useFetch('home', () => fetchInfo(), { refreshMs: 30_000 });
  const liveHome = useLiveHome();

  // The /api rollup counts every discovered .agentuse file, including ones that
  // fail to parse; the Agents page counts only successfully-loaded agents, so
  // the two disagree when a file is broken. Drive Home's agent counts off the
  // same /api/agents payload the Agents page uses so they always match, and
  // surface the parse failures rather than hiding them in the total.
  const agents = useFetch('home-agents', () => fetchAgents(), { refreshMs: 30_000 });
  const agentRows = agents.data?.agents;
  const failedAgents = agents.data?.errors.length ?? 0;
  const loadedByProject = new Map<string, number>();
  for (const a of agentRows ?? []) loadedByProject.set(a.projectId, (loadedByProject.get(a.projectId) ?? 0) + 1);
  const loadedFor = (p: { id: string; agentCount: number }): number =>
    agentRows ? (loadedByProject.get(p.id) ?? 0) : p.agentCount;

  // Soonest upcoming scheduled run powers the hero countdown; refresh often
  // enough that a fired schedule rolls over to the next one without a reload.
  const schedules = useFetch('home-schedules', () => fetchSchedules(), { refreshMs: 60_000 });
  const nextSchedule = (() => {
    let best: { at: number; agentPath: string } | null = null;
    for (const s of schedules.data?.schedules ?? []) {
      if (!s.enabled || !s.nextRun) continue;
      const at = Date.parse(s.nextRun);
      if (!Number.isFinite(at)) continue;
      if (!best || at < best.at) best = { at, agentPath: s.agentPath };
    }
    return best;
  })();

  // Agent-recorded business metrics (reserved "metrics" store). Missing store
  // is normal and returns empty rows, so the section simply doesn't render.
  // Visibility probes the widest window so picking a quiet 1-day view leaves
  // the section (and its window toggle) on screen instead of stranding you.
  const metricRows = useFetch('home-metrics', () => fetchStoreRows('metrics'), { refreshMs: 60_000 });
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
  const metricAggs = aggregateMetrics(metricRows.data, metricsWindow);
  const hasAnyMetrics = metricsWindow === 30
    ? metricAggs.length > 0
    : aggregateMetrics(metricRows.data, 30).length > 0;

  // Per-viewer tile customization: manual order, hidden metrics, and per-metric
  // display. Edit mode keeps hidden tiles on the board so they can come back.
  const metricPrefs = useMetricPrefs();
  const [editMetrics, setEditMetrics] = useState(false);
  const orderedAggs = orderMetrics(metricAggs, metricPrefs.prefs.order);
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
  const running = liveHome.sessions.filter(isLiveRow);
  // subagentActive rows are live work (counted in `running`), not blocked on a
  // human, so they must not also show up as waiting.
  const waiting = liveHome.sessions.filter((s) => s.status === 'suspended' && !s.subagentActive);
  // Recent failures surface in "Needs your attention" alongside pending gates.
  // Not every failed-tone run is waiting on a human: runs the reviewer stopped
  // themselves (USER_STOPPED) or already reviewed and discarded (dismissedAt,
  // via the session page's Discard button or the row's hover ✕) are
  // acknowledged, so they stay out. dismissedLocal hides a just-dismissed row
  // instantly, ahead of the list stream's next snapshot.
  const [dismissedLocal, setDismissedLocal] = useState<ReadonlySet<string>>(() => new Set<string>());
  const dismissFailed = useCallback((row: SessionRow) => {
    const key = sessionRowKey(row);
    setDismissedLocal((current) => new Set(current).add(key));
    postSessionStop(row.sessionId, undefined, { project: row.project, reason: 'Discarded from home' })
      .catch(() => {
        // Dismissal did not land; put the row back so it isn't silently lost.
        setDismissedLocal((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  }, []);
  const failedRecent = liveHome.sessions
    .filter((s) => runTone(s.status) === 'failed' && s.errorCode !== 'USER_STOPPED' && s.dismissedAt === undefined
      && !dismissedLocal.has(sessionRowKey(s)))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, 3);
  const pendingApprovals = liveHome.pendingApprovals;
  // Suspended rows with no live or expired gate are mid-flight (a delegated
  // leaf running under a decided cascade approval, or a resume in progress),
  // so don't advertise them as blocked on a human.
  const allWaitingResuming = liveHome.suspendedGates.loaded && waiting.every((s) =>
    !liveHome.suspendedGates.pending.has(sessionRowKey(s)) && !liveHome.suspendedGates.expired.has(sessionRowKey(s)));
  const now = useNow(running.length > 0 || nextSchedule !== null);

  // When the countdown fires, the schedule's nextRun is stale until the
  // scheduler actually triggers (jitter can hold it past zero); keep
  // refetching every few seconds until nextRun rolls forward so the hero
  // never hangs on a fired schedule.
  const countdownMs = nextSchedule ? nextSchedule.at - now : null;
  const countdownFired = countdownMs !== null && countdownMs <= 0;
  useEffect(() => {
    if (!countdownFired) return;
    const timer = setInterval(() => schedules.refetch(), 4000);
    return () => clearInterval(timer);
  }, [countdownFired, schedules.refetch]);

  const projects = data?.projects ?? [];
  const runningByProject = new Map<string, number>();
  for (const row of running) runningByProject.set(row.project, (runningByProject.get(row.project) ?? 0) + 1);

  const totalAgents = agentRows ? agentRows.length : projects.reduce((sum, p) => sum + p.agentCount, 0);
  const totalSchedules = projects.reduce((sum, p) => sum + p.scheduleCount, 0);

  const heroCount = useCountUp(running.length, { duration: 500 });
  const statAgents = useCountUp(totalAgents);
  const statSessions = useCountUp(liveHome.sessions.length);
  const statSchedules = useCountUp(totalSchedules);

  // One ambient state drives the background tint: running beats waiting beats idle.
  const ambient = running.length > 0 ? 'running' : (pendingApprovals > 0 || waiting.length > 0) ? 'waiting' : 'idle';

  const countFor = (title: string): string | undefined =>
    title === 'Agents' ? `${plural(statAgents, 'agent')}${failedAgents > 0 ? ` · ${failedAgents} broken` : ''}`
      : title === 'Sessions' ? `${statSessions} in 24h`
        : title === 'Schedules' ? plural(statSchedules, 'run')
          : title === 'Approvals' ? (pendingApprovals > 0 ? `${pendingApprovals} pending` : undefined)
            : undefined;

  return (
    <div class="page-home" data-ambient={ambient}>
      <div class="home-ambient" aria-hidden="true"></div>
      <Topbar currentPage="home" />
      <main class="home-boot">
        <header>
          <div class="eyebrow">agent operations</div>
          <h1>{brandName()}</h1>
          {error && <div class="errors" role="alert">Failed to load: {error.message}</div>}
          {liveHome.error && <div class="errors" role="alert">Failed to load sessions: {liveHome.error.message}</div>}
        </header>

        <section class="hero-live" aria-live="polite">
          <div class="hero-count">
            <span class={`hero-dot${running.length > 0 ? ' on' : ''}`} aria-hidden="true"></span>
            <span class="hero-num">{heroCount}</span>
            <span class="hero-label">{running.length === 1 ? 'agent running now' : 'agents running now'}</span>
          </div>
          <div class="hero-sub">
            {pendingApprovals > 0 && (
              <a class="hero-pending" href="/approvals">{plural(pendingApprovals, 'approval')} waiting</a>
            )}
            {waiting.length > 0 && pendingApprovals === 0 && (
              <a class="hero-pending" href="/sessions?status=suspended">
                {plural(waiting.length, 'session')} {allWaitingResuming ? 'resuming' : 'suspended'}
              </a>
            )}
            {nextSchedule && countdownMs !== null && (
              <span class="hero-next">
                next run <code>{nextSchedule.agentPath.replace(/\.agentuse$/, '')}</code>{' '}
                {countdownFired
                  ? <span class="hero-countdown">is starting…</span>
                  : <>in <span class="hero-countdown">{formatCountdown(countdownMs)}</span></>}
              </span>
            )}
          </div>
          <ActivitySpark sessions={liveHome.sessions} />
        </section>

        {sections.isVisible('running') && running.length > 0 && (
          <section class="group">
            <h2 class="group-title"><span>Running now</span><span class="count">{running.length}</span><span class="rule"></span></h2>
            <div class="now-grid">
              {running.map((row, i) => <RunningCard key={`${row.project}:${row.sessionId}`} row={row} now={now} ticker={i < 3} />)}
            </div>
          </section>
        )}

        {sections.isVisible('attention') && (
          <AttentionSection pending={liveHome.pendingRows} failed={failedRecent} onDismissFailed={dismissFailed} />
        )}

        {sections.isVisible('results') && hasAnyMetrics && (
          <section class="group">
            <h2 class="group-title">
              <span>Results</span><span class="rule"></span>
              <button
                type="button"
                class={`metric-edit-btn${editMetrics ? ' on' : ''}`}
                aria-pressed={editMetrics}
                onClick={() => setEditMetrics((on) => !on)}
              >
                {editMetrics ? 'done' : 'customize'}
              </button>
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
          <LatestResults sessions={liveHome.sessions} showProject={projects.length > 1} loading={liveHome.loading} />
        )}

        {sections.isVisible('coming-up') && (
          <ComingUp schedules={schedules.data?.schedules ?? []} />
        )}

        {sections.isVisible('feed') && (
          <section class="group">
            <h2 class="group-title"><span>Activity</span><span class="rule"></span><span class="feed-live-tag">{liveHome.live ? 'live' : 'polling'}</span></h2>
            <div class="panel feed">
              {liveHome.feed.length === 0
                ? (liveHome.loading
                  ? <Loading label="Loading activity…" />
                  : <div class="empty">No runs in the last 24 hours.</div>)
                : liveHome.feed.map((event) => <FeedRow key={event.key} event={event} />)}
            </div>
          </section>
        )}

        {sections.isVisible('cards') && <div class="cards">
          {CARDS.map((card) => {
            const count = countFor(card.title);
            const attn = card.title === 'Approvals' && pendingApprovals > 0;
            return (
              <a class={`card${attn ? ' attn' : ''}`} href={card.href} key={card.href}>
                <div class="card-top"><span class="card-title">{card.title}</span>{count && <span class="card-count">{count}</span>}</div>
                <div class="card-desc">{card.desc}</div>
              </a>
            );
          })}
        </div>}

        {sections.isVisible('projects') && <section class="group">
          <h2 class="group-title"><span>{termTitle('project', 2)}</span><span class="count">{projects.length}</span><span class="rule"></span></h2>
          <div class="panel">
            {projects.length === 0
              ? (loading
                ? <Loading label={`Loading ${term('project', 2)}…`} />
                : <div class="empty">No {term('project', 2)} loaded.</div>)
              : projects.map((p) => (
                // ABOUT.md identity (#156): the name replaces the directory id
                // and the description replaces the absolute path, which stays
                // reachable in the row tooltip. No file, current behavior.
                <a class="proj" href={`/agents/${encodeURIComponent(p.id)}`} key={p.id} {...(p.about?.name || p.about?.description ? { title: `${p.id} · ${p.path}` } : {})}>
                  <div>
                    <div class="proj-id">
                      {p.about?.name ?? p.id}
                      {(runningByProject.get(p.id) ?? 0) > 0 && <span class="proj-live" title={`${runningByProject.get(p.id)} running`} aria-label={`${runningByProject.get(p.id)} running`}></span>}
                      {p.id === data?.default && <span class="proj-default">default</span>}
                    </div>
                    <div class={p.about?.description ? 'proj-path proj-desc' : 'proj-path'}>{p.about?.description ?? `${p.path}${p.scope && p.scope !== p.path ? ` · scope ${p.scope}` : ''}`}</div>
                  </div>
                  <div class="proj-counts">{p.about?.owner && <span class="proj-owner">{p.about.owner} · </span>}{plural(loadedFor(p), 'agent')} · {plural(p.scheduleCount, 'schedule')}<span class="proj-go" aria-hidden="true">›</span></div>
                </a>
              ))}
          </div>
        </section>}

        {data && <p class="api-hint">AgentUse v{data.version}</p>}
      </main>
    </div>
  );
}
