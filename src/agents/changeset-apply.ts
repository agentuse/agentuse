import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { isPathInside } from '../utils/path-policy.js';
import type {
  ChangesetAppliedFile,
  ChangesetFile,
  ChangesetProposal,
  ChangesetRecord,
} from './changeset-types.js';
import {
  contentHash,
  getChangesetObject,
  latestChangesetProposal,
  putChangesetObject,
  readChangesetRecord,
  writeChangesetRecord,
} from './changeset.js';

/**
 * Apply and restore for a multi-file changeset. Every check that can refuse the
 * operation runs before the first project file is touched, so a rejected apply
 * leaves the project byte-for-byte as it was. A crash between the `applying`
 * marker and the final status is settled by the reconcile in `changeset.ts`.
 */

/** Injected so apply does not depend on the validator module's shape. */
export type ChangesetValidate = (record: ChangesetRecord, proposal: ChangesetProposal) => Promise<void>;

export interface ChangesetSkippedFile {
  path: string;
  reason: string;
}

export interface ChangesetRestoreResult {
  record: ChangesetRecord;
  /** Files left as they are because they no longer match what apply wrote. */
  skipped: ChangesetSkippedFile[];
}

function assertRelativePath(path: string): void {
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\\')) {
    throw new Error(`Changeset path must be project-relative with forward slashes: ${path}`);
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new Error(`Changeset path must not contain relative segments: ${path}`);
  }
}

/**
 * Resolve a project-relative path to an absolute one whose real location is
 * inside the served scope. The nearest existing ancestor is realpathed so a
 * symlinked directory cannot smuggle a new file outside the project.
 */
async function resolveInScope(
  projectRoot: string,
  scopeRoot: string,
  relativePath: string,
): Promise<string> {
  assertRelativePath(relativePath);
  // Changeset paths are scope-relative (the overlay and submit_changes both
  // work from scopeRoot); projectRoot only locates the record and object store.
  void projectRoot;
  const absolute = join(scopeRoot, relativePath);
  const missing: string[] = [];
  let existing = dirname(absolute);
  let realExisting: string | undefined;
  while (realExisting === undefined) {
    try {
      realExisting = await realpath(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`Could not resolve a parent directory for ${relativePath}`);
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  const realScope = await realpath(scopeRoot);
  const directory = join(realExisting, ...missing);
  if (!isPathInside(realScope, directory)) {
    throw new Error(`${relativePath} resolves outside the served project scope`);
  }
  return join(directory, basename(absolute));
}

async function readIfPresent(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** `lstat`, so a dangling or escaping symlink still counts as an occupied path. */
async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Refuse anything that is not a plain regular file, the way `replaceAgentSource` does. */
async function assertRegularFile(absolutePath: string, relativePath: string): Promise<void> {
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${relativePath} must be a regular file, not a symlink`);
  }
}

interface PlannedFile {
  file: ChangesetFile;
  absolutePath: string;
  before: string | null;
}

async function planFile(
  projectRoot: string,
  scopeRoot: string,
  file: ChangesetFile,
): Promise<PlannedFile> {
  const absolutePath = await resolveInScope(projectRoot, scopeRoot, file.path);
  if (file.op === 'add') {
    if (await pathExists(absolutePath)) {
      throw new Error(`${file.path} already exists. Review the current file and start a new changeset.`);
    }
    return { file, absolutePath, before: null };
  }
  await assertRegularFile(absolutePath, file.path);
  const before = await readIfPresent(absolutePath);
  if (before === undefined) {
    throw new Error(`${file.path} no longer exists. Review the current files and start a new changeset.`);
  }
  if (!file.baseHash || contentHash(before) !== file.baseHash) {
    throw new Error(`${file.path} changed after this changeset started. Review the current file and start a new changeset.`);
  }
  return { file, absolutePath, before };
}

/** Exclusive create through a temp file plus `link`, as `createAgentFile` does. */
async function createExclusive(absolutePath: string, content: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporary = join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, absolutePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function applyChangeset(input: {
  projectRoot: string;
  scopeRoot: string;
  sessionId: string;
  validate: ChangesetValidate;
}): Promise<ChangesetRecord> {
  const record = await readChangesetRecord(input.projectRoot, input.sessionId);
  if (!record || record.status !== 'proposed') throw new Error('This changeset is not ready to apply');
  const proposal = latestChangesetProposal(record);
  if (!proposal || proposal.files.length === 0) throw new Error('This changeset has no files to apply');
  await input.validate(record, proposal);

  const planned: PlannedFile[] = [];
  for (const file of proposal.files) {
    planned.push(await planFile(input.projectRoot, input.scopeRoot, file));
  }

  const appliedFiles: ChangesetAppliedFile[] = [];
  for (const entry of planned) {
    appliedFiles.push({
      path: entry.file.path,
      beforeHash: entry.before === null ? null : await putChangesetObject(input.projectRoot, entry.before),
      afterHash: contentHash(entry.file.content),
    });
  }

  const startedAt = Date.now();
  const applying: ChangesetRecord = {
    ...record,
    status: 'applying',
    applied: { at: startedAt, files: appliedFiles },
  };
  await writeChangesetRecord(applying);

  for (const entry of planned) {
    if (entry.file.op === 'add') {
      await createExclusive(entry.absolutePath, entry.file.content);
    } else {
      await atomicWriteFile(entry.absolutePath, entry.file.content);
    }
  }

  const applied: ChangesetRecord = { ...applying, status: 'applied' };
  await writeChangesetRecord(applied);
  return applied;
}

export async function restoreChangeset(input: {
  projectRoot: string;
  scopeRoot: string;
  sessionId: string;
}): Promise<ChangesetRestoreResult> {
  const record = await readChangesetRecord(input.projectRoot, input.sessionId);
  if (!record || record.status !== 'applied' || !record.applied) {
    throw new Error('This changeset has no applied files to restore');
  }

  const skipped: ChangesetSkippedFile[] = [];
  const restorable: Array<{ file: ChangesetAppliedFile; absolutePath: string; before: string | null }> = [];
  for (const file of record.applied.files) {
    const absolutePath = await resolveInScope(input.projectRoot, input.scopeRoot, file.path);
    const current = await readIfPresent(absolutePath);
    if (current === undefined) {
      skipped.push({ path: file.path, reason: 'The file no longer exists' });
      continue;
    }
    if (contentHash(current) !== file.afterHash) {
      skipped.push({ path: file.path, reason: 'The file was edited after this changeset was applied' });
      continue;
    }
    await assertRegularFile(absolutePath, file.path);
    if (file.beforeHash === null) {
      restorable.push({ file, absolutePath, before: null });
      continue;
    }
    const before = await getChangesetObject(input.projectRoot, file.beforeHash);
    if (before === undefined) {
      skipped.push({ path: file.path, reason: 'The stored copy of the previous content is missing' });
      continue;
    }
    restorable.push({ file, absolutePath, before });
  }

  if (restorable.length === 0) {
    return { record, skipped };
  }

  const restoring: ChangesetRecord = { ...record, status: 'restoring', restoredAt: Date.now() };
  await writeChangesetRecord(restoring);

  for (const entry of restorable) {
    if (entry.before === null) await rm(entry.absolutePath, { force: true });
    else await atomicWriteFile(entry.absolutePath, entry.before);
  }

  const restored: ChangesetRecord = { ...restoring, status: 'restored' };
  await writeChangesetRecord(restored);
  return { record: restored, skipped };
}
