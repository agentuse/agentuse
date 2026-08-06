/**
 * Undo the read tool's presentation so file content can be rendered as the
 * document it is.
 *
 * `tools__filesystem_read` returns its text line-numbered (`"  1\tcontext"`,
 * see tools/filesystem.ts formatWithLineNumbers) and, when it read only part of
 * a file, prefixed with a `[Reading lines X-Y of Z total]` header. That form is
 * exactly what the model received, so the payload keeps it verbatim; this
 * splits it apart for display. `tools__skill_load` output is not line-numbered
 * and passes through untouched.
 */

export interface ParsedReadOutput {
  /** The tool's range header, when it read only part of the file. */
  header?: string;
  /** The file text itself, line numbers removed. */
  body: string;
  /** True when line numbering was detected and stripped. */
  lineNumbered: boolean;
}

const HEADER = /^\[Reading lines \d+-\d+ of \d+ total\]\n+/;
const NUMBERED_LINE = /^ *\d+\t/;

export function parseReadOutput(value: string): ParsedReadOutput {
  let header: string | undefined;
  let rest = value;

  const headerMatch = rest.match(HEADER);
  if (headerMatch) {
    header = headerMatch[0].trim();
    rest = rest.slice(headerMatch[0].length);
  }

  const lines = rest.split('\n');
  // A document can legitimately contain a line that looks numbered, so require
  // most non-empty lines to match before stripping anything. Otherwise a file
  // that merely starts with a table of contents would lose real characters.
  const candidates = lines.filter((l) => l.trim().length > 0);
  const numbered = candidates.filter((l) => NUMBERED_LINE.test(l)).length;
  const lineNumbered = candidates.length > 0 && numbered >= candidates.length * 0.8;

  const body = lineNumbered
    ? lines.map((l) => l.replace(NUMBERED_LINE, '')).join('\n')
    : rest;

  return {
    ...(header ? { header } : {}),
    body,
    lineNumbered,
  };
}

/** Markdown files get rendered as markdown even when the text is plain prose. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
