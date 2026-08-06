/**
 * Move corrections files from beside the agent file into the AgentUse state
 * directory.
 *
 * Not a compatibility path — the only way across. The destination contains a
 * sha256 of the project root, so no user can type it out, and nothing reads the
 * old sibling location any more. Everything here is path arithmetic and file
 * moves: an agent file is never parsed, so a repository whose agent files no
 * longer parse (the removed `learning.file` key is exactly that case) can still
 * be migrated.
 */

import { copyFile, mkdir, readFile, rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { glob } from 'glob';
import { resolveProjectContext } from '../utils/project';
import { legacyLearningFilePath, resolveLearningFilePath } from './store';

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
  /** The destination already holds corrections; refused rather than merged. */
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
    const from = legacyLearningFilePath(agentFilePath);
    const to = resolveLearningFilePath(agentFilePath, stateRoot);

    const status: MigrationStatus = !(await hasContent(from))
      ? 'nothing-to-move'
      : (await hasContent(to))
        ? 'collision'
        : 'ready';
    entries.push({ agentFilePath, from, to, status });
  }
  return entries;
}

/**
 * Carry out one planned move. Moving is the default: the user asked for this,
 * and leaving the source behind would keep the file churning in their
 * repository, which is the whole point of the change.
 */
export async function applyLearningMigration(
  entry: MigrationEntry,
  options: { keepSource?: boolean } = {},
): Promise<void> {
  if (entry.status !== 'ready') {
    throw new Error(`Refusing to migrate ${entry.from}: ${entry.status}`);
  }
  await mkdir(dirname(entry.to), { recursive: true });

  if (options.keepSource) {
    await copyFile(entry.from, entry.to);
    return;
  }

  try {
    await rename(entry.from, entry.to);
  } catch (error) {
    // The state directory lives under the home volume and the agent file need
    // not, so a cross-device rename is an ordinary outcome here, not a failure.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(entry.from, entry.to);
    await unlink(entry.from);
  }
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
