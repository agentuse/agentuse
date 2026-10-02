const DURATION_UNITS = new Set([
  'ms', 's', 'sec', 'secs', 'second', 'seconds', 'min', 'mins', 'minute', 'minutes',
  'h', 'hr', 'hrs', 'hour', 'hours', 'day', 'days',
]);
let currencyCodes: Set<string> | undefined;

/** A currency code or duration: a real amount even when it equals the count. */
function isMeasurementUnit(unitKey: string): boolean {
  currencyCodes ??= new Set(Intl.supportedValuesOf('currency').map((code) => code.toLowerCase()));
  return currencyCodes.has(unitKey) || DURATION_UNITS.has(unitKey);
}

/** Whether value/unit only restate the count (or are a count-only placeholder). */
function isCountEcho(count: number, value: number, unit: string | null): boolean {
  const unitKey = unit?.toLowerCase().replace(/[\s_-]+/g, '') ?? '';
  if (unitKey === 'count' || unitKey === 'counts' || unitKey === 'countonly') return true;
  if (unit === null && count > 0 && value === 0) return true;
  return value === count && !isMeasurementUnit(unitKey);
}

/** A metric record's numeric fields after removing redundant count-as-value data. */
export interface NormalizedMetricValues {
  count: number | null;
  value: number | null;
  unit: string | null;
}

/**
 * Models occasionally duplicate an item count into `value`/`unit` even though
 * `count` is already present (for example, count=1, value=1, unit="reply").
 * Some also use count_only/count-only as a sentinel with value=0. Those are
 * not amounts and must not take precedence over the real count in rollups.
 * A value equal to the count is still a real amount when its unit is a
 * measurement (currency or duration), e.g. count=1, value=1, unit="usd".
 *
 * Keep this compatibility normalization shared by the write path and the Web
 * UI so existing store records recover immediately without a data migration.
 */
export function normalizeMetricValues(input: {
  count?: unknown;
  value?: unknown;
  unit?: unknown;
}): NormalizedMetricValues {
  const count = typeof input.count === 'number' && Number.isFinite(input.count)
    ? input.count
    : null;
  let value = typeof input.value === 'number' && Number.isFinite(input.value)
    ? input.value
    : null;
  let unit = typeof input.unit === 'string' && input.unit.trim() !== ''
    ? input.unit.trim()
    : null;

  if (count !== null && value !== null && isCountEcho(count, value, unit)) {
    value = null;
    unit = null;
  }

  // A unit without an amount has no display meaning.
  if (value === null) unit = null;
  return { count, value, unit };
}
