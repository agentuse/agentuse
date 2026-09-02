import { structuredPatch } from 'diff';

export type RevisionDiffLine = { kind: 'same' | 'add' | 'remove' | 'meta'; text: string };

function hunkRange(start: number, lines: number): string {
  return lines === 1 ? `${start}` : `${start},${lines}`;
}

export function revisionLineDiff(currentSource: string, proposedSource: string): RevisionDiffLine[] {
  const patch = structuredPatch('current', 'proposed', currentSource, proposedSource, '', '', { context: 2 });
  return patch.hunks.flatMap((hunk, index) => [
    ...(index > 0 ? [{ kind: 'meta' as const, text: '' }] : []),
    {
      kind: 'meta' as const,
      text: `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
    },
    ...hunk.lines.map((line): RevisionDiffLine => {
      if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
      if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1) };
      if (line.startsWith(' ')) return { kind: 'same', text: line.slice(1) };
      return { kind: 'meta', text: line };
    }),
  ]);
}
