import { useMemo, useState } from 'preact/hooks';
import { useCountUp } from '../hooks/use-count-up';
import { useMetricPrefs, type MetricDisplay } from '../hooks/use-metric-prefs';
import type { StoreRowsPayload } from '../lib/api';
import { agentDetailHref } from '../lib/links';
import { humanizeMetric, plural } from '../lib/format';
import { normalizeMetricValues } from '../../../../shared/metric-values';

/**
 * Agent-recorded business metrics (reserved "metrics" store) rolled up into
 * result tiles. Home shows the whole fleet; an agent's Results tab passes a
 * `source` so only that agent's records are counted. Sums are plain code over
 * runtime-stamped records - no model output is ever in the math path.
 */

/** One agent's identity as the metric store records it (`createdBy`). */
export interface MetricSource {
  projectId: string;
  agentId: string;
}

/** One raw metric record's contribution, kept for the tile charts. */
export interface MetricEvent {
  at: number;
  value: number | null;
  count: number | null;
}

/** One record_metric name rolled up across projects for the results window. */
export interface MetricAgg {
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
  /** Distinct (project, agent) pairs that wrote this metric: one means the
   *  tile can lead straight to that agent's jobs. */
  sources: Array<{ projectId: string; agentId: string }>;
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
export function aggregateMetrics(payload: StoreRowsPayload | null | undefined, windowDays: number, source?: MetricSource): MetricAgg[] {
  if (!payload) return [];
  const cutoff = Date.now() - windowDays * 24 * 3_600_000;
  const byMetric = new Map<string, MetricAgg>();
  for (const row of payload.rows) {
    if (source && row.projectId !== source.projectId) continue;
    for (const item of row.items) {
      if (item.type !== 'metric') continue;
      if (source && item.createdBy !== source.agentId) continue;
      const metric = item.data.metric;
      if (typeof metric !== 'string') continue;
      const at = Date.parse(item.updatedAt);
      if (!Number.isFinite(at) || at < cutoff) continue;

      let agg = byMetric.get(metric);
      if (!agg) {
        agg = { metric, count: 0, hasCount: false, value: 0, hasValue: false, unit: null, mixedUnits: false, latestAt: 0, events: [], sources: [] };
        byMetric.set(metric, agg);
      }
      if (typeof item.createdBy === 'string' && item.createdBy
        && !agg.sources.some((source) => source.projectId === row.projectId && source.agentId === item.createdBy)) {
        agg.sources.push({ projectId: row.projectId, agentId: item.createdBy });
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

/**
 * Where a results tile leads: the runs behind the number. One recording agent
 * means that agent's jobs tab, narrowed to this metric; several (or an agent
 * the fleet no longer lists) means the sessions list narrowed the same way.
 */
export function metricTileHref(
  agg: Pick<MetricAgg, 'metric' | 'sources'>,
  agents: ReadonlyArray<{ projectId: string; path: string; runPath: string }> | undefined,
): string {
  if (agg.sources.length === 1) {
    const [source] = agg.sources;
    const agent = agents?.find((candidate) =>
      candidate.projectId === source.projectId && candidate.path.replace(/\.agentuse$/, '') === source.agentId);
    if (agent) return agentDetailHref(agent.projectId, agent.runPath, { tab: 'jobs', metric: agg.metric });
  }
  return `/sessions?metric=${encodeURIComponent(agg.metric)}`;
}

function MetricTile(props: { agg: MetricAgg; windowDays: number; display: MetricDisplay; href: string; onOpen?: (() => void) | undefined; edit?: MetricTileEdit | undefined }) {
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
    return <a class="metric-tile" href={props.href} onClick={props.onOpen} title={`${agg.metric} · open the runs behind this number`}>{body}</a>;
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


/**
 * The Results tiles with their window toggle and customize mode. Renders
 * nothing while no metric landed in the widest window (30 days) so the
 * section never appears just to say it is empty; `emptyLabel` opts into
 * showing that empty state instead (the agent tab, where the tab itself is
 * already on screen).
 */
export function MetricResults(props: {
  payload: StoreRowsPayload | null | undefined;
  /** Only count records this agent wrote; omit for the fleet-wide rollup. */
  source?: MetricSource | undefined;
  hrefFor: (agg: MetricAgg) => string;
  /** Fired alongside the tile link, for a page that swaps its own view. */
  onOpen?: ((agg: MetricAgg) => void) | undefined;
  /** Show this when nothing was recorded in 30 days, instead of rendering nothing. */
  emptyLabel?: string | undefined;
}) {
  const { payload, source } = props;
  // Visibility probes the widest window so picking a quiet 1-day view leaves
  // the section (and its window toggle) on screen instead of stranding you.
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
  const metricAggs = useMemo(() => aggregateMetrics(payload, metricsWindow, source), [payload, metricsWindow, source]);
  const hasAnyMetrics = useMemo(
    () => (metricsWindow === 30 ? metricAggs : aggregateMetrics(payload, 30, source)).length > 0,
    [payload, metricsWindow, metricAggs, source]
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

  if (!hasAnyMetrics) {
    return props.emptyLabel ? <div class="metric-empty">{props.emptyLabel}</div> : null;
  }

  return (
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
                href={props.hrefFor(agg)}
                onOpen={props.onOpen ? () => props.onOpen?.(agg) : undefined}
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
  );
}
