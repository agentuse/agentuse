import chalk from 'chalk';

/**
 * Shared renderer for the aligned, headered tables the CLI prints
 * (`serve ps`, `serve agents`, `serve schedules`, `benchmark`).
 *
 * Every caller wants the same three pieces — a padded header row, a rule under
 * it, and padded data rows — but differs in whether widths are fixed or derived
 * from the content, how wide the column gap is, and which chalk style dims the
 * header. Those are options here rather than three near-identical copies.
 */

/** `'none'` emits the cell verbatim, for callers that pre-pad and pre-color. */
export type CliTableAlign = 'left' | 'right' | 'none';

export interface CliTableOptions {
  /** Fixed column widths; derived from headers + rows when omitted. */
  widths?: readonly number[];
  /** Text between columns. Defaults to two spaces. */
  gap?: string;
  /** Per-column alignment. Defaults to 'left' for every column. */
  align?: readonly CliTableAlign[];
  /** Style for the header row and the rule. Defaults to `chalk.dim`. */
  dim?: (text: string) => string;
  /** Length of the rule under the header. Defaults to the full table width. */
  separatorLength?: number;
}

const DEFAULT_GAP = '  ';

/** Widest header or cell per column. */
export function cliTableWidths(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): number[] {
  return headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length))
  );
}

/** Pad one row of cells to `widths` and join them with the column gap. */
export function formatCliRow(
  cells: ReadonlyArray<string | undefined>,
  widths: readonly number[],
  options: Pick<CliTableOptions, 'gap' | 'align'> = {},
): string {
  const gap = options.gap ?? DEFAULT_GAP;
  return widths
    .map((width, i) => {
      const cell = cells[i] ?? '';
      const align = options.align?.[i] ?? 'left';
      if (align === 'none') return cell;
      return align === 'right' ? cell.padStart(width) : cell.padEnd(width);
    })
    .join(gap);
}

/** The dimmed header row and the rule beneath it. */
export function renderCliTableHeader(
  headers: readonly string[],
  widths: readonly number[],
  options: CliTableOptions = {},
): [string, string] {
  const gap = options.gap ?? DEFAULT_GAP;
  const dim = options.dim ?? chalk.dim;
  const ruleLength =
    options.separatorLength ??
    widths.reduce((sum, width) => sum + width, 0) + gap.length * Math.max(0, widths.length - 1);
  return [dim(formatCliRow(headers, widths, { gap })), dim('─'.repeat(ruleLength))];
}

/** Header, rule, and every row, joined by newlines. */
export function renderCliTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  options: CliTableOptions = {},
): string {
  const widths = options.widths ?? cliTableWidths(headers, rows);
  const out: string[] = [...renderCliTableHeader(headers, widths, options)];
  for (const row of rows) out.push(formatCliRow(row, widths, options));
  return out.join('\n');
}
