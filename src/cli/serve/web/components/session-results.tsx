import type { SessionResult } from '../../types';
import type { SessionRow } from '../lib/api';
import { humanizeMetric } from '../lib/format';

/**
 * A finished run that recorded results (record_metric) and that nobody has
 * opened or waved off yet. This is the "important completed session" signal:
 * the agent already said what it did, so the run only has to be looked at.
 */
export function isUnseenResultsRow(
  row: Pick<SessionRow, 'status' | 'results' | 'reviewedAt' | 'dismissedAt'>
): boolean {
  return row.status === 'completed'
    && (row.results?.length ?? 0) > 0
    && row.reviewedAt === undefined
    && row.dismissedAt === undefined;
}

export function resultLabel(result: SessionResult): string {
  const name = humanizeMetric(result.metric).toLowerCase();
  if (result.value !== undefined) {
    const amount = result.unit === 'usd'
      ? `$${result.value.toLocaleString()}`
      : `${result.value.toLocaleString()}${result.unit ? ` ${result.unit}` : ''}`;
    return `${amount} ${name}`;
  }
  if (result.count !== undefined) return `${result.count.toLocaleString()} ${name}`;
  return name;
}

/** The one line a reader needs to triage a finished run: its top result's note,
 *  or the results themselves when the agent left no note. */
export function resultsHeadline(results: SessionResult[] | undefined): string | undefined {
  if (!results || results.length === 0) return undefined;
  const noted = results.find((result) => result.note);
  if (noted?.note) return noted.note;
  return results.map(resultLabel).join(' · ');
}

/** What the run recorded, as chips. `unseen` marks the row as not yet looked at. */
export function ResultChips(props: { results: SessionResult[] | undefined; unseen?: boolean | undefined; max?: number | undefined }) {
  const results = props.results ?? [];
  if (results.length === 0) return null;
  const max = props.max ?? 3;
  const shown = results.slice(0, max);
  const folded = results.length - shown.length;
  const title = results.map((r) => (r.note ? `${resultLabel(r)}: ${r.note}` : resultLabel(r))).join('\n');
  return (
    <span class={`result-chips${props.unseen ? ' unseen' : ''}`} title={title}>
      {props.unseen && <span class="result-new">new</span>}
      {shown.map((result) => <span class="result-chip" key={`${result.metric}:${result.at}`}>{resultLabel(result)}</span>)}
      {folded > 0 && <span class="result-chip more">+{folded}</span>}
    </span>
  );
}
