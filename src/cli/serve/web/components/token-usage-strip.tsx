import type { ApprovalPageInfo } from '../../types';
import { useCountUp } from '../hooks/use-count-up';

const tokenFmt = new Intl.NumberFormat('en-US');
export function formatTokenCount(value: number | undefined): string {
  return value === undefined ? '—' : tokenFmt.format(value);
}

export function formatUsagePercent(value: number | undefined): string | undefined {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : undefined;
}

/**
 * The context-and-cost strip. It answers "what did this run consume", and is
 * shared by the session detail header and the agent draft panel so both read
 * the same numbers the same way.
 */
export interface TokenMetaItem {
  label: string;
  value: string;
  title?: string;
  /** Numeric value for count-up animation; the renderer formats via `format`. */
  num?: number;
  format?: (n: number) => string;
  /** Percent of context window remaining (0-100); renders the headroom gauge. */
  gaugePctLeft?: number;
}

export function tokenUsageMetaItems(tokenUsage: ApprovalPageInfo['tokenUsage'] | undefined): TokenMetaItem[] {
  if (!tokenUsage) return [];

  const items: TokenMetaItem[] = [];
  const context = tokenUsage.context;
  if (context) {
    // Lead with "% context left" (like Codex): a stable 0-100 gauge of how much
    // working room remains, rather than a raw, ever-growing token count. The
    // absolute tokens/limit stay available on hover so the headline stays clean.
    const hasLimit = typeof context.contextLimit === 'number' && context.contextLimit > 0;
    const pctLeft = hasLimit ? Math.max(0, 100 - context.usagePercentage) : undefined;
    const leftPercent = pctLeft !== undefined ? formatUsagePercent(pctLeft) : undefined;
    const detail = [
      formatTokenCount(context.activeTokens),
      hasLimit ? `/ ${formatTokenCount(context.contextLimit)}` : undefined,
    ].filter(Boolean).join(' ');
    items.push({
      label: 'context used',
      value: leftPercent ? `${leftPercent} left` : detail,
      ...(leftPercent ? { title: detail } : {}),
      ...(pctLeft !== undefined ? { gaugePctLeft: pctLeft } : {}),
    });
  }

  const cached = Math.max(0, tokenUsage.cachedInput);
  const newInput = Math.max(0, tokenUsage.input - cached);
  const output = Math.max(0, tokenUsage.output);

  const hasProviderUsage = tokenUsage.input > 0 || cached > 0 || output > 0;
  if (!hasProviderUsage) {
    items.push({ label: 'provider usage', value: 'not reported yet' });
    return items;
  }

  // Show the real full-rate spend split: non-cached input + output. Cached reads
  // are billed ~10x cheaper and re-counted on every step, so surfacing them as a
  // primary count made spend look far scarier than it is; we show them separately
  // with a leading '+' to signal they sit on top of (not inside) the input count.
  const wholeTokens = (n: number): string => formatTokenCount(Math.round(n));
  items.push({ label: 'input', value: formatTokenCount(newInput), num: newInput, format: wholeTokens });
  items.push({ label: 'output', value: formatTokenCount(output), num: output, format: wholeTokens });
  if (cached > 0) {
    items.push({ label: 'cached', value: `+${formatTokenCount(cached)}`, num: cached, format: (n) => `+${wholeTokens(n)}` });
  }
  return items;
}

/** Headroom tone for the context gauge: calm green until half, then amber, then red. */
export function gaugeTone(pctLeft: number): string {
  return pctLeft > 50 ? '' : pctLeft > 20 ? ' warn' : ' crit';
}

/**
 * Animates a stat toward its latest value so live sessions read as motion:
 * counters visibly tick up on each SSE status update instead of snapping.
 */
export function CountUpValue(props: { num: number; format: (n: number) => string }) {
  const display = useCountUp(props.num, { duration: 600, startAtTarget: true, round: false });
  return <>{props.format(display)}</>;
}

export function TokenUsageStrip(props: {
  tokenUsage: ApprovalPageInfo['tokenUsage'] | undefined;
  estimatedCost?: number | undefined;
  formatUsd?: ((value: number) => string) | undefined;
  /** Denser variant for a side column; the session header uses the default. */
  compact?: boolean;
  ariaLabel?: string;
  children?: preact.ComponentChildren;
}) {
  const items = tokenUsageMetaItems(props.tokenUsage);
  if (items.length === 0 && props.estimatedCost === undefined) return null;
  return (
    <div
      class={`meta meta-context${props.compact ? ' is-compact' : ''}`}
      {...(props.ariaLabel ? { 'aria-label': props.ariaLabel } : {})}
    >
      {items.map((item) => (
        <div class="cell token-cell" key={item.label}>
          <span class="label">{item.label}</span>
          <span class="value" {...(item.title ? { title: item.title } : {})}>
            {item.num !== undefined && item.format ? <CountUpValue num={item.num} format={item.format} /> : item.value}
          </span>
          {item.gaugePctLeft !== undefined && (
            <span class="token-gauge" role="img" aria-label={`${item.gaugePctLeft.toFixed(1)}% of the context window left`}>
              <span class={`token-gauge-fill${gaugeTone(item.gaugePctLeft)}`} style={{ width: `${item.gaugePctLeft}%` }} />
            </span>
          )}
        </div>
      ))}
      {props.estimatedCost !== undefined && props.formatUsd && (
        <div class="cell token-cell" key="est-cost">
          <span class="label">est. cost</span>
          <span class="value" title="Estimated from models.dev per-token pricing; cached input billed at input/10">
            <CountUpValue num={props.estimatedCost} format={props.formatUsd} />
          </span>
        </div>
      )}
      {props.children}
    </div>
  );
}
