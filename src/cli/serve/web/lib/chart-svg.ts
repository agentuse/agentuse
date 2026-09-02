/**
 * Renderer for ```agentuse:chart fenced blocks.
 *
 * Agents emit data (categories + numeric series), never presentation; this
 * module owns all layout and color decisions so old sessions keep rendering
 * as the renderer improves. Colors resolve through the --chart-N custom
 * properties, so the same markup follows the light/dark theme.
 *
 * Output is an escaped HTML string consumed through the content-html
 * dangerouslySetInnerHTML choke point: every dynamic value below flows
 * through escapeHtml() before markup is added.
 */
import { escapeHtml } from './html';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: 'bar' | 'line';
  title?: string;
  categories: string[];
  series: ChartSeries[];
  yLabel?: string;
  unit?: string;
}

export const CHART_FENCE_LANGUAGE = 'agentuse:chart';

const MAX_SERIES = 6;
const MAX_CATEGORIES = 60;
const MAX_LABEL_LENGTH = 120;

/** Strict-parse a fenced block body; null means "not a valid chart, fall back to a code block". */
export function parseChartSpec(code: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  if (spec.type !== 'bar' && spec.type !== 'line') return null;
  if (!Array.isArray(spec.categories) || spec.categories.length === 0 || spec.categories.length > MAX_CATEGORIES) return null;
  if (!spec.categories.every(c => typeof c === 'string' && c.length <= MAX_LABEL_LENGTH)) return null;
  if (!Array.isArray(spec.series) || spec.series.length === 0 || spec.series.length > MAX_SERIES) return null;
  const categories = spec.categories as string[];
  const series: ChartSeries[] = [];
  for (const entry of spec.series) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    // LLM emitters commonly guess `data` (the chart.js/echarts convention);
    // accept it as an alias so a near-miss still renders.
    const values = record.values ?? record.data;
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_LABEL_LENGTH) return null;
    if (!Array.isArray(values) || values.length !== categories.length) return null;
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    series.push({ name, values: values as number[] });
  }
  const parsed: ChartSpec = { type: spec.type, categories, series };
  if (typeof spec.title === 'string' && spec.title.trim() && spec.title.length <= MAX_LABEL_LENGTH) parsed.title = spec.title;
  if (typeof spec.yLabel === 'string' && spec.yLabel.length <= MAX_LABEL_LENGTH) parsed.yLabel = spec.yLabel;
  if (typeof spec.unit === 'string' && spec.unit.length <= 12) parsed.unit = spec.unit;
  return parsed;
}

/** Render a fenced block body, or null when it is not a valid chart spec. */
export function renderChartBlock(code: string): string | null {
  const spec = parseChartSpec(code);
  return spec ? renderChartHtml(spec) : null;
}

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 240;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;
const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const BAR_END_RADIUS = 2;
const BAR_GAP = 2;

export function renderChartHtml(spec: ChartSpec): string {
  const scale = buildScale(spec);
  const plot = {
    left: PAD_LEFT,
    top: PAD_TOP,
    width: VIEW_WIDTH - PAD_LEFT - PAD_RIGHT - (spec.type === 'line' && spec.series.length > 1 ? 70 : 0),
    height: VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM,
  };
  const parts = [
    renderGrid(scale, plot),
    renderXAxis(spec, plot),
    spec.type === 'bar' ? renderBars(spec, scale, plot) : renderLines(spec, scale, plot),
  ];
  const svg = `<svg viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="${escapeHtml(chartAriaLabel(spec))}" preserveAspectRatio="xMinYMin meet">${parts.join('')}</svg>`;
  // The unit lives in the caption (and tooltips/table), never on axis ticks,
  // so the axis stays internally consistent once k/M abbreviation kicks in.
  const yCaption = [spec.yLabel ? escapeHtml(spec.yLabel) : '', spec.unit ? `(${escapeHtml(spec.unit)})` : ''].filter(Boolean).join(' ');
  const caption = spec.title || yCaption
    ? `<figcaption class="au-chart-title">${escapeHtml(spec.title ?? '')}${yCaption ? `<span class="au-chart-ylabel">${yCaption}</span>` : ''}</figcaption>`
    : '';
  // Without a title, the legend is the only thing naming a lone series.
  const legend = spec.series.length > 1 || !spec.title ? renderLegend(spec) : '';
  return `<figure class="au-chart" data-chart-type="${spec.type}">
    ${caption}
    ${legend}
    <div class="au-chart-scroll">${svg}</div>
    ${renderDataTable(spec)}
  </figure>`;
}

function chartAriaLabel(spec: ChartSpec): string {
  return `${spec.type === 'bar' ? 'Bar' : 'Line'} chart${spec.title ? `: ${spec.title}` : ''}. ${spec.series.length} series, ${spec.categories.length} points. Data table below.`;
}

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function buildScale(spec: ChartSpec): Scale {
  const all = spec.series.flatMap(s => s.values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  return niceScale(min, max === min ? min + 1 : max);
}

/** Standard nice-number tick scale (~4 intervals). */
function niceScale(min: number, max: number): Scale {
  const span = niceNumber(max - min, false);
  const step = niceNumber(span / 4, true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Epsilon guards float drift so the top tick is not dropped.
  for (let tick = lo; tick <= hi + step * 1e-6; tick += step) {
    ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : tick);
  }
  return { min: lo, max: hi, ticks };
}

function niceNumber(value: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

function yPosition(value: number, scale: Scale, plot: { top: number; height: number }): number {
  const ratio = (value - scale.min) / (scale.max - scale.min);
  return plot.top + plot.height - ratio * plot.height;
}

export function formatChartNumber(value: number, unit?: string): string {
  const abs = Math.abs(value);
  // "2kms" reads as a unit soup, so the unit is dropped once k/M kicks in;
  // tooltips and the data table still carry it on the unabbreviated values.
  if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (abs >= 1000) return `${trimDecimal(value / 1000)}k`;
  return unit ? `${trimDecimal(value)}${unit}` : trimDecimal(value);
}

function trimDecimal(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function renderGrid(scale: Scale, plot: { left: number; top: number; width: number; height: number }): string {
  return scale.ticks.map(tick => {
    const y = yPosition(tick, scale, plot);
    return `<line class="au-chart-grid" x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y}" y2="${y}" />` +
      `<text class="au-chart-tick" x="${plot.left - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(formatChartNumber(tick))}</text>`;
  }).join('');
}

function renderXAxis(spec: ChartSpec, plot: { left: number; top: number; width: number; height: number }): string {
  const count = spec.categories.length;
  const step = Math.ceil(count / 8);
  return spec.categories.map((category, index) => {
    if (index % step !== 0 && index !== count - 1) return '';
    // The final label is always shown; skip a stride label that would collide with it.
    if (index % step === 0 && index !== count - 1 && count - 1 - index < step / 2) return '';
    const x = plot.left + ((index + 0.5) / count) * plot.width;
    return `<text class="au-chart-tick" x="${x}" y="${plot.top + plot.height + 16}" text-anchor="middle">${escapeHtml(truncateLabel(category))}</text>`;
  }).join('');
}

function truncateLabel(value: string): string {
  return value.length > 14 ? `${value.slice(0, 13)}…` : value;
}

function renderBars(spec: ChartSpec, scale: Scale, plot: { left: number; top: number; width: number; height: number }): string {
  const groups = spec.categories.length;
  const groupWidth = plot.width / groups;
  const groupPad = Math.min(groupWidth * 0.18, 12);
  // Thin marks: cap bar width and center the group instead of filling the slot.
  const barWidth = Math.min(28, Math.max(1, (groupWidth - groupPad * 2 - BAR_GAP * (spec.series.length - 1)) / spec.series.length));
  const groupSpan = barWidth * spec.series.length + BAR_GAP * (spec.series.length - 1);
  const groupOffset = (groupWidth - groupSpan) / 2;
  const zeroY = yPosition(0, scale, plot);
  const showValueLabels = groups * spec.series.length <= 12;
  return spec.series.map((series, seriesIndex) => {
    const marks = series.values.map((value, index) => {
      const x = plot.left + index * groupWidth + groupOffset + seriesIndex * (barWidth + BAR_GAP);
      const y = yPosition(value, scale, plot);
      const top = Math.min(y, zeroY);
      const height = Math.abs(y - zeroY);
      const label = `${spec.categories[index]} · ${series.name}: ${formatChartNumber(value, spec.unit)}`;
      return `<g class="au-chart-mark"><title>${escapeHtml(label)}</title>${roundedEndBar(x, top, barWidth, height, value >= 0)}${
        showValueLabels && height > 0
          ? `<text class="au-chart-value" x="${x + barWidth / 2}" y="${value >= 0 ? top - 4 : top + height + 11}" text-anchor="middle">${escapeHtml(formatChartNumber(value, spec.unit))}</text>`
          : ''
      }</g>`;
    }).join('');
    return `<g class="au-chart-series" style="--series-color: var(--chart-${seriesIndex + 1})">${marks}</g>`;
  }).join('');
}

/** Bar with a rounded data-end and a square baseline end, per the mark spec. */
function roundedEndBar(x: number, y: number, width: number, height: number, positive: boolean): string {
  const radius = Math.min(BAR_END_RADIUS, width / 2, height);
  if (height <= 0) return '';
  const x2 = x + width;
  const path = positive
    ? `M${x} ${y + height} V${y + radius} Q${x} ${y} ${x + radius} ${y} H${x2 - radius} Q${x2} ${y} ${x2} ${y + radius} V${y + height} Z`
    : `M${x} ${y} V${y + height - radius} Q${x} ${y + height} ${x + radius} ${y + height} H${x2 - radius} Q${x2} ${y + height} ${x2} ${y + height - radius} V${y} Z`;
  return `<path class="au-chart-fill" d="${path}" />`;
}

function renderLines(spec: ChartSpec, scale: Scale, plot: { left: number; top: number; width: number; height: number }): string {
  const count = spec.categories.length;
  const xAt = (index: number) => plot.left + ((index + 0.5) / count) * plot.width;
  return spec.series.map((series, seriesIndex) => {
    const points = series.values.map((value, index) => ({ x: xAt(index), y: yPosition(value, scale, plot) }));
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round1(p.x)} ${round1(p.y)}`).join(' ');
    const markers = points.map((p, index) => {
      const label = `${spec.categories[index]} · ${series.name}: ${formatChartNumber(series.values[index], spec.unit)}`;
      return `<g class="au-chart-mark"><title>${escapeHtml(label)}</title>` +
        `<circle class="au-chart-hit" cx="${round1(p.x)}" cy="${round1(p.y)}" r="9" />` +
        `<circle class="au-chart-dot" cx="${round1(p.x)}" cy="${round1(p.y)}" r="3.5" /></g>`;
    }).join('');
    const last = points[points.length - 1];
    const endLabel = spec.series.length > 1
      ? `<text class="au-chart-series-label" x="${round1(last.x + 8)}" y="${round1(last.y + 3)}">${escapeHtml(truncateLabel(series.name))}</text>`
      : '';
    return `<g class="au-chart-series" style="--series-color: var(--chart-${seriesIndex + 1})"><path class="au-chart-line" d="${path}" fill="none" />${markers}${endLabel}</g>`;
  }).join('');
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function renderLegend(spec: ChartSpec): string {
  const items = spec.series.map((series, index) =>
    `<span class="au-chart-legend-item"><span class="au-chart-swatch" style="background: var(--chart-${index + 1})"></span>${escapeHtml(series.name)}</span>`);
  return `<div class="au-chart-legend">${items.join('')}</div>`;
}

/** Collapsible table view: the accessibility relief for color-only identity and hover-only values. */
function renderDataTable(spec: ChartSpec): string {
  const header = `<tr><th></th>${spec.series.map(s => `<th>${escapeHtml(s.name)}</th>`).join('')}</tr>`;
  const rows = spec.categories.map((category, index) =>
    `<tr><th>${escapeHtml(category)}</th>${spec.series.map(s => `<td>${escapeHtml(formatChartNumber(s.values[index], spec.unit))}</td>`).join('')}</tr>`).join('');
  return `<details class="au-chart-data"><summary>Data</summary><div class="content-table-scroll" tabindex="0" role="group" aria-label="Chart data"><table><thead>${header}</thead><tbody>${rows}</tbody></table></div></details>`;
}
