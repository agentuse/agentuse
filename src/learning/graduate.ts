import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import type { Learning, LearningCategory } from './types';
import { atomicWriteFile } from '../utils/atomic-write';

/**
 * Graduation: moving a proven correction out of the learnings file and into the
 * agent's own instructions.
 *
 * The learnings file is a staging buffer metered by the per-run injection cap.
 * The agent file is the durable artifact — uncapped, diffable, reviewable in a
 * pull request, and the place a teammate looks to find out what this agent has
 * been taught. A correction that has proven itself belongs there, and moving it
 * frees the cap slot it was occupying.
 *
 * Rules are written into a marked block so the write is idempotent: re-running
 * replaces the block rather than appending a second copy of everything.
 */
export const LEARNED_BLOCK_START = '<!-- agentuse:learned -->';
export const LEARNED_BLOCK_END = '<!-- /agentuse:learned -->';

/** One permanent rule, as it exists in the agent file. No id, no counters: once
 *  a rule is permanent there is nothing further to decide about it, and the
 *  bullet in the file is the whole record. */
export interface PermanentRule {
  category: LearningCategory;
  instruction: string;
}

/**
 * Read the block back out of an agent file.
 *
 * This is what makes the agent file the source of truth rather than a printout
 * of one. Before it existed the block could only be REPRINTED from a copy held
 * in the store, so anything a human edited between the markers was silently
 * restored to the stored wording on the next graduation. Parsing it means the
 * text in the file is the input to every later edit, not something to overwrite.
 *
 * Bullets may span lines — a graduated rule can carry its own numbered list — so
 * a bullet runs until the next one starts rather than to the end of its line.
 */
export function parseLearnedBlock(source: string): PermanentRule[] {
  const start = source.indexOf(LEARNED_BLOCK_START);
  const end = source.indexOf(LEARNED_BLOCK_END);
  if (start === -1 || end <= start) return [];

  const body = source.slice(start + LEARNED_BLOCK_START.length, end);
  const rules: PermanentRule[] = [];
  // Split on a bullet at the start of a line, keeping whatever follows it until
  // the next one. `[\w-]+` matches the category names, which are the only thing
  // rendered inside the brackets.
  //
  // Deliberately NOT multiline: with `m`, `$` matches at every line ending, so
  // the lazy capture stopped at the first blank line and a rule carrying its own
  // numbered list lost everything after its opening sentence. The line anchor is
  // written explicitly as `(?:^|\n)` instead.
  const regex = /(?:^|\n)- \[([\w-]+)\] ([\s\S]*?)(?=\n- \[[\w-]+\] |$)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const category = match[1] as LearningCategory;
    const instruction = match[2]!.trim();
    if (instruction) rules.push({ category, instruction });
  }
  return rules;
}

/**
 * The heading is deliberately identical in meaning to the runtime block in
 * ../runner/system-messages, so a graduated rule behaves exactly as it did while
 * it was being injected. The runtime block is titled "Recent Corrections" so the
 * two do not collide as duplicate `## Learned Guidelines` headings once an agent
 * file carries a graduated block.
 */
export function renderLearnedBlock(learnings: (Learning | PermanentRule)[]): string {
  const bullets = learnings.map((l) => `- [${l.category}] ${l.instruction}`).join('\n');
  return `${LEARNED_BLOCK_START}
## Learned Guidelines (override skill defaults on conflict)

Corrections graduated from previous runs. These take precedence over Skills — if one contradicts a skill's default, follow the guideline:

${bullets}
${LEARNED_BLOCK_END}`;
}

/**
 * Splice the marked block into an agent file's raw text.
 *
 * Deliberately a string operation on the raw file rather than a gray-matter
 * parse/serialize round trip: re-serializing the frontmatter reformats the
 * user's YAML, reorders nothing but restyles everything, and silently drops
 * their comments. This is someone's source file — the only bytes that may change
 * are the ones inside the markers.
 *
 * An empty learning set removes the block entirely rather than leaving an empty
 * heading behind.
 */
export function spliceLearnedBlock(source: string, learnings: (Learning | PermanentRule)[]): string {
  const start = source.indexOf(LEARNED_BLOCK_START);
  const end = source.indexOf(LEARNED_BLOCK_END);
  const block = learnings.length > 0 ? renderLearnedBlock(learnings) : '';

  if (start !== -1 && end !== -1 && end > start) {
    const before = source.slice(0, start);
    const after = source.slice(end + LEARNED_BLOCK_END.length);
    if (!block) {
      // Collapse the blank lines that surrounded the removed block so deleting
      // it leaves the file as it was before it existed.
      return `${before.replace(/\n+$/, '\n')}${after.replace(/^\n+/, '')}`.trimEnd() + '\n';
    }
    return `${before}${block}${after}`;
  }

  if (!block) return source;
  return `${source.replace(/\s+$/, '')}\n\n${block}\n`;
}

/** Whether the agent file can be rewritten. A generated or read-only agent file
 *  is a legitimate setup, so graduation degrades instead of failing the run. */
export async function agentFileIsWritable(agentFilePath: string): Promise<boolean> {
  try {
    await access(agentFilePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the graduated set into the agent file.
 *
 * @returns the file text before and after, so the caller can show a diff and
 * restore the exact prior bytes on undo.
 */
export async function writeLearnedBlock(
  agentFilePath: string,
  learnings: (Learning | PermanentRule)[],
): Promise<{ before: string; after: string; changed: boolean }> {
  const before = await readFile(agentFilePath, 'utf-8');
  const after = spliceLearnedBlock(before, learnings);
  if (after === before) return { before, after, changed: false };
  await atomicWriteFile(agentFilePath, after);
  return { before, after, changed: true };
}
