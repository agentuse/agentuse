import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionRow, StoreRowsPayload } from '../lib/api';
import { fetchInfo, fetchAgents, fetchSchedules, fetchStoreRows } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useLiveHome, sessionRowKey, type ActivityEvent } from '../hooks/use-live-home';
import { useSessionTail } from '../hooks/use-session-tail';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { formatApprovalTime, formatRelativeTime, displayStatusLabel, humanizeMetric, runTone } from '../lib/format';
import { brandName, pageTitle } from '../lib/brand';

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

/** Animate a stat toward its target so counts visibly count up on load. */
function useCountUp(target: number, duration = 700): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const progress = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
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
  return LIVE_STATUSES.has(row.status);
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
        agg = { metric, count: 0, hasCount: false, value: 0, hasValue: false, unit: null, mixedUnits: false, latestAt: 0 };
        byMetric.set(metric, agg);
      }
      const { count, value, unit, note } = item.data;
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

function MetricTile(props: { agg: MetricAgg }) {
  const { agg } = props;
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
  return (
    <a class="metric-tile" href="/stores/metrics" title={agg.metric}>
      <div class="metric-num">{bigLabel}</div>
      <div class="metric-name">{humanizeMetric(agg.metric)}</div>
      {sub && <div class="metric-sub">{sub}</div>}
    </a>
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

  const running = liveHome.sessions.filter(isLiveRow);
  const waiting = liveHome.sessions.filter((s) => s.status === 'suspended');
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

  const heroCount = useCountUp(running.length, 500);
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

        {hasAnyMetrics && (
          <section class="group">
            <h2 class="group-title">
              <span>Results</span><span class="rule"></span>
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
            {metricAggs.length > 0
              ? (
                <div class="metric-grid">
                  {metricAggs.map((agg) => <MetricTile key={agg.metric} agg={agg} />)}
                </div>
              )
              : <div class="metric-empty">No results in the last {metricsWindow === 1 ? 'day' : `${metricsWindow} days`}.</div>}
          </section>
        )}

        {running.length > 0 && (
          <section class="group">
            <h2 class="group-title"><span>Running now</span><span class="count">{running.length}</span><span class="rule"></span></h2>
            <div class="now-grid">
              {running.map((row, i) => <RunningCard key={`${row.project}:${row.sessionId}`} row={row} now={now} ticker={i < 3} />)}
            </div>
          </section>
        )}

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

        <div class="cards">
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
        </div>

        <section class="group">
          <h2 class="group-title"><span>Projects</span><span class="count">{projects.length}</span><span class="rule"></span></h2>
          <div class="panel">
            {projects.length === 0
              ? (loading
                ? <Loading label="Loading projects…" />
                : <div class="empty">No projects loaded.</div>)
              : projects.map((p) => (
                <a class="proj" href={`/agents/${encodeURIComponent(p.id)}`} key={p.id}>
                  <div>
                    <div class="proj-id">
                      {p.id}
                      {(runningByProject.get(p.id) ?? 0) > 0 && <span class="proj-live" title={`${runningByProject.get(p.id)} running`} aria-label={`${runningByProject.get(p.id)} running`}></span>}
                      {p.id === data?.default && <span class="proj-default">default</span>}
                    </div>
                    <div class="proj-path">{p.path}{p.scope && p.scope !== p.path ? ` · scope ${p.scope}` : ''}</div>
                  </div>
                  <div class="proj-counts">{plural(loadedFor(p), 'agent')} · {plural(p.scheduleCount, 'schedule')}<span class="proj-go" aria-hidden="true">›</span></div>
                </a>
              ))}
          </div>
        </section>

        {data && <p class="api-hint">Programmatic clients: server info JSON at <code>/api</code>, JSON twins at <code>/api/agents</code>, <code>/api/sessions</code>, <code>/api/schedules</code>. v{data.version}</p>}
      </main>
    </div>
  );
}
