/**
 * Minimal unified diff for showing a user what a command just changed on disk.
 *
 * Hand-rolled rather than pulled from a dependency: the inputs are single files
 * of a few hundred lines (a learnings store, an agent definition), so the
 * quadratic LCS below costs microseconds, and a diff renderer is not worth a
 * package in the dependency tree of a CLI that ships to users.
 */

interface DiffOptions {
  /** Path shown in the `---`/`+++` header. */
  label?: string;
  /** Unchanged lines kept around each change. */
  context?: number;
}

type Op = { kind: 'same' | 'add' | 'del'; text: string };

/** Longest-common-subsequence line diff. */
function diffLines(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = length of the LCS of before[i..] and after[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'same', text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'del', text: before[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', text: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: before[i++]! });
  while (j < m) ops.push({ kind: 'add', text: after[j++]! });
  return ops;
}

/**
 * Render a unified diff, or an empty string when the two texts are identical.
 *
 * Returning '' for "no change" lets callers treat an unchanged file as something
 * not worth showing, rather than printing an empty diff header that reads like
 * something went wrong.
 */
export function unifiedDiff(before: string, after: string, options: DiffOptions = {}): string {
  if (before === after) return '';
  const context = options.context ?? 3;
  const ops = diffLines(before.split('\n'), after.split('\n'));

  // Group changes into hunks, keeping `context` unchanged lines on each side.
  const changedAt = ops.map((op) => op.kind !== 'same');
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (!changedAt[k]) continue;
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
      keep[c] = true;
    }
  }

  const lines: string[] = [];
  if (options.label) {
    lines.push(`--- ${options.label}`, `+++ ${options.label}`);
  }

  let beforeLine = 1;
  let afterLine = 1;
  let hunk: string[] = [];
  let hunkBeforeStart = 1;
  let hunkAfterStart = 1;
  let hunkBeforeCount = 0;
  let hunkAfterCount = 0;

  const flush = () => {
    if (hunk.length === 0) return;
    lines.push(`@@ -${hunkBeforeStart},${hunkBeforeCount} +${hunkAfterStart},${hunkAfterCount} @@`);
    lines.push(...hunk);
    hunk = [];
    hunkBeforeCount = 0;
    hunkAfterCount = 0;
  };

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (keep[k]) {
      if (hunk.length === 0) {
        hunkBeforeStart = beforeLine;
        hunkAfterStart = afterLine;
      }
      if (op.kind === 'same') {
        hunk.push(` ${op.text}`);
        hunkBeforeCount++;
        hunkAfterCount++;
      } else if (op.kind === 'del') {
        hunk.push(`-${op.text}`);
        hunkBeforeCount++;
      } else {
        hunk.push(`+${op.text}`);
        hunkAfterCount++;
      }
    } else {
      flush();
    }
    if (op.kind !== 'add') beforeLine++;
    if (op.kind !== 'del') afterLine++;
  }
  flush();

  return lines.join('\n');
}
