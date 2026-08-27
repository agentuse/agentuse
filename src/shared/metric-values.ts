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

  const unitKey = unit?.toLowerCase().replace(/[\s_-]+/g, '') ?? '';
  const countOnlyUnit = unitKey === 'count' || unitKey === 'counts' || unitKey === 'countonly';
  const emptyZeroPlaceholder = count !== null && count > 0 && value === 0 && unit === null;
  if (count !== null && value !== null && (value === count || countOnlyUnit || emptyZeroPlaceholder)) {
    value = null;
    unit = null;
  }

  // A unit without an amount has no display meaning.
  if (value === null) unit = null;
  return { count, value, unit };
}
