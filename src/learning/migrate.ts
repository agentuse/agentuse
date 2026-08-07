/**
 * Move learnings files from beside the agent file into the AgentUse state
 * directory.
 *
 * Not a compatibility path — the only way across. The destination contains a
 * sha256 of the project root, so no user can type it out, and nothing reads the
 * old sibling location any more. Everything here is path arithmetic and file
 * copies: an agent file is never parsed, so a repository whose agent files no
 * longer parse (the removed `learning.file` key is exactly that case) can still
 * be migrated.
 *
 * Copying and deleting are two calls, not one, so the caller can put a
 * confirmation between them. See {@link applyLearningMigration}.
 */

import { mkdir, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';
import { glob } from 'glob';
import matter from 'gray-matter';
import { resolveProjectContext } from '../utils/project';
import { legacyLearningFilePath, resolveLearningFilePath, withLearningFileLock } from './store';
import { atomicWriteFile } from '../utils/atomic-write';

const LEARNINGS_SUFFIX = '.learnings.md';

/** Same exclusions the agent listing uses, so `--all` covers the same set of
 *  agents `agentuse agents` does. */
const IGNORED_DIRS = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

/** Re-exported so callers of the migration have one import, but defined in
 *  ./store beside the notice that reports the same file. Two copies could drift
 *  into a notice pointing at a path this migration would not move. */
export { legacyLearningFilePath };

export type MigrationStatus =
  /** A sibling exists and the destination is free. */
  | 'ready'
  /**
   * The destination already holds this exact file: a previous run copied it and
   * the source was kept. Nothing left to copy, but the source is still there to
   * offer to delete.
   *
   * Distinguishing this from a collision is what makes the command safe to run
   * twice. Since the copy no longer removes the source, the second run would
   * otherwise report the file it wrote itself as an unresolvable conflict.
   */
  | 'already-copied'
  /** The destination holds DIFFERENT learnings; refused rather than merged. */
  | 'collision'
  /** No sibling to move. The common case once an agent has been migrated. */
  | 'nothing-to-move';

export interface MigrationEntry {
  agentFilePath: string;
  /** Absolute path of the legacy sibling. */
  from: string;
  /** Absolute path of the keyed corrections file. */
  to: string;
  status: MigrationStatus;
  /** Source bytes observed while planning; rejects a stale copy/delete plan. */
  sourceHash?: string;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Recover the pre-0.17 custom source without validating the removed schema. */
async function migrationSource(agentFilePath: string): Promise<string> {
  try {
    const raw = await readFile(agentFilePath, 'utf-8');
    const learning = matter(raw).data?.learning as { file?: unknown } | undefined;
    if (typeof learning?.file === 'string' && learning.file.trim()) {
      return resolve(dirname(agentFilePath), learning.file);
    }
  } catch {
    // A malformed agent still gets the deterministic legacy sibling fallback.
  }
  return legacyLearningFilePath(agentFilePath);
}

/** True when the file exists and holds something other than whitespace. An
 *  empty file is not corrections, so it is not worth refusing a migration over. */
async function hasContent(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  return (await readFile(filePath, 'utf-8')).trim().length > 0;
}

/**
 * Work out, for each agent file, what would move and where.
 *
 * Each agent is anchored on its OWN project root (`stateRoot`), the same way a
 * run resolves its corrections file, so migrating from any directory produces
 * the destination the agent will actually read from.
 */
export async function planLearningMigration(
  agentFilePaths: string[],
  cwd: string,
): Promise<MigrationEntry[]> {
  const entries: MigrationEntry[] = [];
  for (const agentFileArg of agentFilePaths) {
    const agentFilePath = resolve(agentFileArg);
    const { stateRoot } = resolveProjectContext(cwd, { agentFilePath });
    const from = await migrationSource(agentFilePath);
    const to = resolveLearningFilePath(agentFilePath, stateRoot);

    let status: MigrationStatus;
    if (!(await hasContent(from))) {
      status = 'nothing-to-move';
    } else if (!(await hasContent(to))) {
      status = 'ready';
    } else {
      // Byte equality, not a heuristic. Anything short of identical is two
      // different sets of learnings for one agent, which is the collision this
      // command refuses to resolve on the user's behalf.
      const [source, destination] = await Promise.all([
        readFile(from, 'utf-8'),
        readFile(to, 'utf-8'),
      ]);
      status = source === destination ? 'already-copied' : 'collision';
    }
    const sourceHash = await hasContent(from)
      ? hash(await readFile(from, 'utf-8'))
      : undefined;
    entries.push({ agentFilePath, from, to, status, ...(sourceHash ? { sourceHash } : {}) });
  }
  return entries;
}

/**
 * Carry out one planned migration: copy, never move.
 *
 * The copy and the deletion are separate steps on purpose. Deleting a file out
 * of someone's repository is the irreversible half — a surprise deletion, a
 * dirty working tree, a diff they have to explain — and it should not happen as
 * a side effect of the half they asked for. Writing into our own state directory
 * is ours to do; removing their file is theirs to confirm. {@link
 * deleteMigrationSource} is that second step.
 */
export async function applyLearningMigration(entry: MigrationEntry): Promise<void> {
  if (entry.status !== 'ready') {
    throw new Error(`Refusing to migrate ${entry.from}: ${entry.status}`);
  }
  await withLearningFileLock(entry.to, async () => {
    const source = await readFile(entry.from, 'utf-8');
    if (!source.trim()) throw new Error(`Refusing to migrate ${entry.from}: source is empty`);
    if (entry.sourceHash && hash(source) !== entry.sourceHash) {
      throw new Error(`Refusing to migrate ${entry.from}: source changed after the migration was planned`);
    }

    if (await hasContent(entry.to)) {
      const destination = await readFile(entry.to, 'utf-8');
      if (destination === source) return; // a concurrent identical copy won
      throw new Error(`Refusing to migrate ${entry.from}: destination changed after planning`);
    }
    await mkdir(dirname(entry.to), { recursive: true });
    await atomicWriteFile(entry.to, source);
  });
}

/**
 * Remove a source file whose copy is confirmed present.
 *
 * Re-checks the destination rather than trusting the caller's bookkeeping. This
 * is the only destructive call in the migration, and the cost of the two states
 * is wildly asymmetric: a leftover source is untidy, a deleted source with no
 * copy is lost learnings.
 */
export async function deleteMigrationSource(entry: MigrationEntry): Promise<void> {
  await withLearningFileLock(entry.to, async () => {
    const [source, destination] = await Promise.all([
      readFile(entry.from, 'utf-8'),
      readFile(entry.to, 'utf-8').catch(() => ''),
    ]);
    if (!destination.trim()) {
      throw new Error(`Refusing to delete ${entry.from}: nothing was copied to ${entry.to}`);
    }
    if (!source.trim() || source !== destination) {
      throw new Error(`Refusing to delete ${entry.from}: destination is not an exact copy`);
    }
    if (entry.sourceHash && hash(source) !== entry.sourceHash) {
      throw new Error(`Refusing to delete ${entry.from}: source changed after the migration was planned`);
    }
    await unlink(entry.from);
  });
}

/** Every agent file in the project, absolute and sorted. */
export async function findAgentFiles(projectRoot: string): Promise<string[]> {
  const files = await glob('**/*.agentuse', {
    cwd: projectRoot,
    absolute: true,
    ignore: IGNORED_DIRS,
  });
  return files.sort();
}

/**
 * Corrections files whose agent file is gone — almost always a rename that
 * happened before the migration.
 *
 * Reported, never touched. There is no way to know which agent they belong to,
 * and the load-time warning cannot fire for them either (nothing resolves to
 * that sibling any more), so without this line a rename would lose the file in
 * silence.
 */
export async function findOrphanedLearningFiles(projectRoot: string): Promise<string[]> {
  const files = await glob(`**/*${LEARNINGS_SUFFIX}`, {
    cwd: projectRoot,
    absolute: true,
    ignore: IGNORED_DIRS,
  });
  return files
    .filter((file) => {
      const stem = file.slice(0, -LEARNINGS_SUFFIX.length);
      // `x.agentuse.learnings.md` pairs with `x.agentuse`; the pre-0.17 resolver
      // also produced `x.learnings.md` for an `x.md` agent, so check both.
      return !existsSync(stem) && !existsSync(`${stem}.md`);
    })
    .sort();
}
