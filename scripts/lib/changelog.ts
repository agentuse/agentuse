/**
 * Read version sections out of CHANGELOG.md.
 *
 * Shared by the release script, which dates a section and slices it into the
 * GitHub Release body, and the review brief, which shows the reviewer that same
 * text before they approve. One reader means the notes someone approves and the
 * notes that get published cannot drift apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADING = /^## /;

function lines(root: string): string[] {
  return readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
}

/** Everything under a heading, up to the next one. */
function bodyAfter(all: string[], index: number): string {
  const rest = all.slice(index + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  return rest
    .slice(0, end === -1 ? rest.length : end)
    .join('\n')
    .trim();
}

/** The released section for a version, or null if it was never dated. */
export function sectionFor(root: string, version: string): string | null {
  const all = lines(root);
  const index = all.findIndex((line) => line.startsWith(`## [${version}]`));
  return index === -1 ? null : bodyAfter(all, index);
}

/** The pending section. Null means no heading at all; '' means an empty one. */
export function unreleasedBody(root: string): string | null {
  const all = lines(root);
  const index = all.findIndex((line) => line.trim() === '## [Unreleased]');
  return index === -1 ? null : bodyAfter(all, index);
}
