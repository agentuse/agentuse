import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error-message';
import {
  changesetDir,
  changesetObjectPath,
  changesetRecordPath,
  type ChangesetProposal,
  type ChangesetRecord,
  type ChangesetTestRun,
  type ChangesetTestRunStatus,
} from './changeset-types.js';

/**
 * The durable record behind a multi-file changeset. It plays the role that
 * `AgentDraftRecord` plays for a single-file create and `AgentRevisionRecord`
 * plays for a single-file revise: one JSON per authoring session, appended to
 * as the model proposes, and reconciled on read when an apply or a restore was
 * interrupted part-way through the file writes.
 */

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeRecord(record: ChangesetRecord): Promise<void> {
  await mkdir(changesetDir(record.projectRoot), { recursive: true });
  await atomicWriteFile(
    changesetRecordPath(record.projectRoot, record.sessionId),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Persist a record built by apply or restore, which own their own transitions. */
export async function writeChangesetRecord(record: ChangesetRecord): Promise<void> {
  await writeRecord({ ...record, updatedAt: Date.now() });
}

export async function createChangesetRecord(
  input: Omit<ChangesetRecord, 'version' | 'status' | 'createdAt' | 'updatedAt' | 'proposals' | 'exchange' | 'testRuns'>,
): Promise<ChangesetRecord> {
  const now = Date.now();
  const created: ChangesetRecord = {
    version: 1,
    ...input,
    status: 'running',
    proposals: [],
    exchange: [],
    testRuns: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(created);
  return created;
}

/** Hash of the file on disk, or undefined when it does not exist. */
async function currentFileHash(absolutePath: string): Promise<string | undefined> {
  try {
    return contentHash(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function failReconcile(record: ChangesetRecord, message: string): Promise<ChangesetRecord> {
  const failed: ChangesetRecord = {
    ...record,
    status: 'error',
    error: {
      code: record.status === 'applying' ? 'CHANGESET_APPLY_STATE_DIVERGED' : 'CHANGESET_RESTORE_STATE_DIVERGED',
      message,
    },
    updatedAt: Date.now(),
  };
  await writeRecord(failed);
  return failed;
}

/**
 * Settle a crash between the `applying`/`restoring` marker and the final
 * status. Generalizes `reconcileRevisionMutation` to a file list: every file
 * matching its after-hash means the mutation completed, every file matching its
 * base means nothing landed, and a mix is a divergence the operator must look
 * at before anything else touches the project.
 */
async function reconcileChangesetMutation(record: ChangesetRecord): Promise<ChangesetRecord> {
  if (record.status !== 'applying' && record.status !== 'restoring') return record;
  const files = record.applied?.files;
  if (!files || files.length === 0) {
    return failReconcile(record, 'The interrupted changeset recorded no files to reconcile.');
  }

  let hashes: Array<string | undefined>;
  try {
    // Changeset paths are scope-relative, the same base apply and restore write
    // under; projectRoot only locates the record.
    hashes = await Promise.all(files.map((file) => currentFileHash(join(record.scopeRoot, file.path))));
  } catch (error) {
    return failReconcile(
      record,
      `Could not reconcile the interrupted changeset: ${toErrorMessage(error)}`,
    );
  }

  const matchesAfter = files.every((file, index) => hashes[index] === file.afterHash);
  const matchesBefore = files.every((file, index) => hashes[index] === (file.beforeHash ?? undefined));

  if (record.status === 'applying') {
    if (matchesAfter) {
      const applied: ChangesetRecord = { ...record, status: 'applied', updatedAt: Date.now() };
      await writeRecord(applied);
      return applied;
    }
    if (matchesBefore) {
      const { applied: _applied, error: _error, ...retained } = record;
      const proposed: ChangesetRecord = { ...retained, status: 'proposed', updatedAt: Date.now() };
      await writeRecord(proposed);
      return proposed;
    }
  } else {
    if (matchesBefore) {
      const restored: ChangesetRecord = { ...record, status: 'restored', restoredAt: Date.now(), updatedAt: Date.now() };
      await writeRecord(restored);
      return restored;
    }
    if (matchesAfter) {
      const { restoredAt: _restoredAt, error: _error, ...retained } = record;
      const applied: ChangesetRecord = { ...retained, status: 'applied', updatedAt: Date.now() };
      await writeRecord(applied);
      return applied;
    }
  }

  return failReconcile(
    record,
    record.status === 'applying'
      ? 'The project changed while an interrupted changeset apply was being reconciled. Review the current files before applying again.'
      : 'The project changed while an interrupted changeset restore was being reconciled. Review the current files before restoring again.',
  );
}

export async function readChangesetRecord(
  projectRoot: string,
  sessionId: string,
): Promise<ChangesetRecord | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(changesetRecordPath(projectRoot, sessionId), 'utf8'),
    ) as ChangesetRecord;
    if (parsed.version !== 1 || parsed.sessionId !== sessionId || parsed.projectRoot !== projectRoot) {
      return undefined;
    }
    return reconcileChangesetMutation(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface ChangesetRecordFilter {
  /** Project-relative path of the revise target, for the agent history tab. */
  targetPath?: string;
  originSessionId?: string;
}

export async function listChangesetRecords(
  projectRoot: string,
  filter: ChangesetRecordFilter = {},
): Promise<ChangesetRecord[]> {
  let names: string[];
  try {
    names = await readdir(changesetDir(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/i.test(name))
    .map((name) => readChangesetRecord(projectRoot, name.slice(0, -5))));
  return records
    .filter((record): record is ChangesetRecord => Boolean(record))
    .filter((record) => (filter.targetPath === undefined || record.target?.path === filter.targetPath)
      && (filter.originSessionId === undefined || record.originSessionId === filter.originSessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function mutate(
  projectRoot: string,
  sessionId: string,
  change: (record: ChangesetRecord) => ChangesetRecord,
): Promise<ChangesetRecord> {
  const record = await readChangesetRecord(projectRoot, sessionId);
  if (!record) throw new Error('This changeset no longer exists');
  const next = { ...change(record), updatedAt: Date.now() };
  await writeRecord(next);
  return next;
}

/** Identity of a proposed file set, used to spot a resubmitted proposal. */
function fileSetKey(files: ChangesetProposal['files']): string {
  return JSON.stringify([...files]
    .map((file) => [file.path, file.op, file.hash] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** Attach the model's reply to the turn the operator opened, or start the first. */
function withChangesetReply(exchange: ChangesetRecord['exchange'], reply: string): ChangesetRecord['exchange'] {
  const last = exchange[exchange.length - 1];
  if (last && last.reply === undefined) return [...exchange.slice(0, -1), { ...last, reply }];
  return [...exchange, { reply }];
}

/**
 * Append one accepted submission. The same submission arriving twice (a live
 * consume followed by a restart recovery) must not create a duplicate
 * proposal, so an identical file set at the tail is treated as already
 * recorded.
 */
export async function appendChangesetProposal(
  projectRoot: string,
  sessionId: string,
  submission: Omit<ChangesetProposal, 'index' | 'submittedAt' | 'request'>,
): Promise<ChangesetRecord> {
  return mutate(projectRoot, sessionId, (record) => {
    const { pendingRequest, ...retained } = record;
    const status = submission.files.length === 0 ? 'no-change' : 'proposed';
    const latest = record.proposals[record.proposals.length - 1];
    if (latest && fileSetKey(latest.files) === fileSetKey(submission.files) && latest.reply === submission.reply) {
      return { ...retained, status };
    }
    const proposal: ChangesetProposal = {
      ...(pendingRequest && { request: pendingRequest }),
      ...submission,
      index: record.proposals.length + 1,
      submittedAt: Date.now(),
    };
    return {
      ...retained,
      status,
      proposals: [...record.proposals, proposal],
      exchange: withChangesetReply(record.exchange, submission.reply),
    };
  });
}

/** Record the operator request that the reopened authoring session answers. */
export async function reopenChangeset(
  projectRoot: string,
  sessionId: string,
  request: string,
): Promise<ChangesetRecord> {
  const record = await readChangesetRecord(projectRoot, sessionId);
  if (!record) throw new Error('This changeset no longer exists');
  if (record.status !== 'proposed' && record.status !== 'no-change' && record.status !== 'error') {
    throw new Error('This changeset is not waiting for a change request');
  }
  return mutate(projectRoot, sessionId, (next) => {
    const { error: _error, ...retained } = next;
    return {
      ...retained,
      status: 'running',
      pendingRequest: request,
      exchange: [...retained.exchange, { request }],
    };
  });
}

export async function failChangeset(
  projectRoot: string,
  sessionId: string,
  error: { code: string; message: string },
): Promise<ChangesetRecord | undefined> {
  const record = await readChangesetRecord(projectRoot, sessionId);
  if (!record || record.status !== 'running') return record;
  return mutate(projectRoot, sessionId, (next) => ({ ...next, status: 'error', error }));
}

/**
 * Close a changeset the operator does not want applied. A `no-change` proposal
 * is an accepted diagnosis rather than a rejected edit, so its proposal stays
 * intact for the history tab; only the status moves.
 */
export async function discardChangeset(projectRoot: string, sessionId: string): Promise<ChangesetRecord> {
  const record = await readChangesetRecord(projectRoot, sessionId);
  if (!record || (record.status !== 'proposed' && record.status !== 'no-change')) {
    throw new Error('This changeset cannot be discarded');
  }
  return mutate(projectRoot, sessionId, (next) => ({ ...next, status: 'discarded' }));
}

export async function recordChangesetTestRun(
  projectRoot: string,
  sessionId: string,
  run: ChangesetTestRun,
): Promise<ChangesetRecord> {
  return mutate(projectRoot, sessionId, (record) => ({
    ...record,
    testRuns: [...record.testRuns.filter((existing) => existing.sessionId !== run.sessionId), run],
  }));
}

export async function settleChangesetTestRun(
  projectRoot: string,
  sessionId: string,
  testRunSessionId: string,
  outcome: { status: ChangesetTestRunStatus; error?: { code: string; message: string } },
): Promise<ChangesetRecord | undefined> {
  const record = await readChangesetRecord(projectRoot, sessionId);
  if (!record) return undefined;
  return mutate(projectRoot, sessionId, (next) => ({
    ...next,
    testRuns: next.testRuns.map((run) => run.sessionId === testRunSessionId
      ? { ...run, status: outcome.status, finishedAt: Date.now(), ...(outcome.error && { error: outcome.error }) }
      : run),
  }));
}

/** The proposal the review page shows and Apply writes. */
export function latestChangesetProposal(record: ChangesetRecord): ChangesetProposal | undefined {
  return record.proposals[record.proposals.length - 1];
}

/**
 * Content-addressed store for the copies Restore writes back. Idempotent: the
 * same content always lands under the same name, so a re-apply of a file whose
 * previous content is already stored is a no-op.
 */
export async function putChangesetObject(projectRoot: string, content: string): Promise<string> {
  const hash = contentHash(content);
  const target = changesetObjectPath(projectRoot, hash);
  try {
    await stat(target);
    return hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await atomicWriteFile(target, content, { mode: 0o600 });
  return hash;
}

export async function getChangesetObject(projectRoot: string, hash: string): Promise<string | undefined> {
  try {
    return await readFile(changesetObjectPath(projectRoot, hash), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
