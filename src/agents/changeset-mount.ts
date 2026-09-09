/**
 * Shadow root for changeset test runs (agentuse-lab #226).
 *
 * `startMockTestRun` runs a proposal's source in memory with
 * `projectRoot = project.root`, so `${agentDir}`, sibling workers and scripts
 * beside the agent cannot resolve while the operator is testing a draft. This
 * module builds a throwaway link farm instead: every top-level entry of the
 * project scope becomes a symlink, and only the directories a changeset file
 * actually lives in are materialized as real directories of links. The entry is
 * then run from `shadow/<entry>` with `projectRoot = shadow`, so relative
 * references, bash cwd and `.agentuse` state all resolve without a single write
 * landing in the real project.
 *
 * Cost scales with changeset depth times sibling count, never with project
 * size: the project tree is never globbed or walked.
 */
import { lstat, mkdir, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import { changesetShadowRoot } from './changeset-types.js';
import { isPathInside } from '../utils/path-policy.js';

/**
 * Fan-out cap for any directory the mount links or materializes. A project root
 * with more entries than this is refused rather than turned into tens of
 * thousands of symlinks.
 */
export const CHANGESET_MOUNT_MAX_ENTRIES = 5000;

export interface ChangesetMountFile {
  /** Project-relative path, forward slashes. */
  path: string;
  content: string;
}

export interface ChangesetMountInput {
  projectRoot: string;
  scopeRoot: string;
  sessionId: string;
  files: ReadonlyArray<ChangesetMountFile>;
}

export interface ChangesetMount {
  /** Absolute path of the shadow root; use it as `projectRoot` for the run. */
  root: string;
  /** Absolute path inside the shadow root for a project-relative path. */
  entryFor: (relPath: string) => string;
  /** Removes the shadow root only. Never follows links out into the project. */
  cleanup: () => Promise<void>;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Normalize a changeset path and refuse anything that leaves `scopeRoot`.
 * Returns the path segments, so callers can walk ancestors without re-parsing.
 */
function segmentsFor(scopeRoot: string, relPath: string): string[] {
  const normalized = relPath.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!normalized || isAbsolute(normalized) || isAbsolute(relPath)) {
    throw new Error(`Changeset path must be project-relative: ${relPath}`);
  }
  const absolute = resolve(scopeRoot, normalized);
  if (!isPathInside(scopeRoot, absolute, { allowEqual: false })) {
    throw new Error(`Changeset path escapes the project scope: ${relPath}`);
  }
  const segments = normalized.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new Error(`Changeset path must name a file: ${relPath}`);
  return segments;
}

/** Link every child of `realDir` into `shadowDir`, which must already exist. */
async function linkChildren(realDir: string, shadowDir: string): Promise<void> {
  const entries = await readdir(realDir);
  if (entries.length > CHANGESET_MOUNT_MAX_ENTRIES) {
    throw new Error(
      `Refusing to mount ${realDir}: ${entries.length} entries exceeds the ${CHANGESET_MOUNT_MAX_ENTRIES} cap`,
    );
  }
  for (const name of entries) {
    await symlink(join(realDir, name), join(shadowDir, name));
  }
}

/**
 * Turn a shadow symlink that stands for a real directory into a real directory
 * holding one symlink per child, so a changeset file can be placed beneath it
 * without the write travelling through the link into the project.
 */
async function materialize(shadowPath: string): Promise<void> {
  const target = await readlink(shadowPath);
  await unlink(shadowPath);
  await mkdir(shadowPath);
  await linkChildren(target, shadowPath);
}

/**
 * Build `.agentuse/changeset/<id>/shadow/` for a test run. The shadow root is
 * rebuilt from scratch on every call.
 */
export async function mountChangesetShadow(input: ChangesetMountInput): Promise<ChangesetMount> {
  const scopeRoot = await realpath(input.scopeRoot);
  const root = changesetShadowRoot(input.projectRoot, input.sessionId);
  const cleanup = async (): Promise<void> => {
    // `fs.rm` unlinks symlinks instead of descending into their targets, so the
    // real project is untouched even though the shadow is mostly links.
    await rm(root, { recursive: true, force: true });
  };

  await cleanup();
  await mkdir(root, { recursive: true });
  try {
    await linkChildren(scopeRoot, root);

    for (const file of input.files) {
      const segments = segmentsFor(scopeRoot, file.path);
      for (let depth = 1; depth < segments.length; depth += 1) {
        const relative = segments.slice(0, depth);
        const realPath = join(scopeRoot, ...relative);
        const shadowPath = join(root, ...relative);
        const realStats = await lstatOrNull(realPath);
        if (realStats?.isSymbolicLink()) {
          throw new Error(`Refusing to mount under a symlinked project directory: ${relative.join('/')}`);
        }
        if (realStats && !realStats.isDirectory()) {
          throw new Error(`Changeset path collides with a project file: ${relative.join('/')}`);
        }
        const shadowStats = await lstatOrNull(shadowPath);
        if (!shadowStats) {
          await mkdir(shadowPath);
        } else if (shadowStats.isSymbolicLink()) {
          await materialize(shadowPath);
        } else if (!shadowStats.isDirectory()) {
          throw new Error(`Changeset path collides with a staged file: ${relative.join('/')}`);
        }
      }

      const relative = segments.join('/');
      const realFile = join(scopeRoot, ...segments);
      const realFileStats = await lstatOrNull(realFile);
      if (realFileStats?.isDirectory()) {
        throw new Error(`Changeset path collides with a project directory: ${relative}`);
      }
      const shadowFile = join(root, ...segments);
      const shadowFileStats = await lstatOrNull(shadowFile);
      if (shadowFileStats?.isDirectory()) {
        throw new Error(`Changeset path collides with a staged directory: ${relative}`);
      }
      // The placeholder is a link to the real file: writing through it would
      // edit the project, so drop the link before writing a regular file.
      if (shadowFileStats) await unlink(shadowFile);
      await mkdir(dirname(shadowFile), { recursive: true });
      await writeFile(shadowFile, file.content, { encoding: 'utf8', mode: 0o644 });
    }
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }

  return {
    root,
    entryFor: (relPath: string) => join(root, ...segmentsFor(scopeRoot, relPath)),
    cleanup,
  };
}
