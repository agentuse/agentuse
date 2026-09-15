/**
 * Change-set bookkeeping for the serve daemon.
 *
 * Resolving and guarding a change set's target path, summarising records for
 * the list surface, and applying, discarding or settling one. Moved verbatim
 * out of serve.ts.
 */
import { createChangesetRecord, discardChangeset, failChangeset, listChangesetRecords, readChangesetRecord } from "../../agents/changeset";
import { applyChangeset } from "../../agents/changeset-apply";
import type { ChangesetValidate } from "../../agents/changeset-apply";
import { assertChangesetId, changesetBasePath, changesetDir, changesetEditRoot } from "../../agents/changeset-types";
import type { ChangesetFile, ChangesetMode, ChangesetProposal, ChangesetRecord, ChangesetStatus } from "../../agents/changeset-types";
import { validateChangesetFiles } from "../../agents/changeset-validate";
import { projectFileReader as changesetProjectFileReader, listProjectAgents as listChangesetProjectAgents } from "../../onboarding/submit-changes";
import { isPathInside } from "../../utils/path-policy";
import type { SessionPurpose } from "./types";
import { WorkerExecuteError, WorkerExecuteResult } from "./worker-types";
import { lstat, mkdir, realpath, rm, writeFile } from "fs/promises";
import { join, relative, resolve } from "path";

/** ULID, the only shape a change set id can take. Checked before the record
 *  helpers throw on it, so a junk path is a 404 rather than a 400. */
export const CHANGESET_NOT_SUBMITTED = {
  code: 'CHANGESET_NOT_SUBMITTED',
  message: 'The change set session ended without submitting a validated outcome',
} as const;

export const CHANGESET_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Where a changeset review page lives. */
export function changesetReviewHref(projectId: string, sessionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(sessionId)}`;
}

export function changesetSessionPurpose(
  projectId: string,
  record: Pick<ChangesetRecord, 'sessionId' | 'mode' | 'target'>,
): SessionPurpose {
  return {
    kind: 'changeset',
    mode: record.mode,
    ...(record.target?.name && { targetAgentName: record.target.name }),
    href: changesetReviewHref(projectId, record.sessionId),
  };
}

/** A change set the operator can still steer: a second one on the same target
 *  would review two proposals against the same base. */
export const CHANGESET_OPEN_STATUSES: ReadonlySet<ChangesetStatus> = new Set<ChangesetStatus>([
  'running', 'proposed', 'no-change',
]);

/** Statuses whose turn has ended, so a change request reopens the session
 *  instead of racing a running one. `error` is included so a failed authoring
 *  turn can be steered rather than abandoned. */
export function changesetAcceptsChangeRequest(status: ChangesetStatus): boolean {
  return status === 'proposed' || status === 'no-change' || status === 'error';
}

export function activeChangesetForTarget(
  records: readonly ChangesetRecord[],
  targetPath: string,
): ChangesetRecord | undefined {
  return records.find((record) => record.target?.path === targetPath
    && CHANGESET_OPEN_STATUSES.has(record.status));
}

/** A revise target that is not a plain agent file inside the served scope. */
export class ChangesetTargetError extends Error {}

/**
 * Resolve the agent a revise change set is about, to the scope-relative run
 * path the record, the overlay and `submit_changes` all speak.
 *
 * Both forms arrive here: the agent page sends a relative run path, while the
 * session page only knows `context.agentFilePath` and sends an absolute one.
 * The realpath pair is what decides scope membership, so an absolute path
 * reached through a symlinked ancestor still normalizes onto the real tree
 * instead of naming a file the apply would later refuse.
 */
export async function resolveChangesetTargetPath(scopeRoot: string, requested: string): Promise<string> {
  const outsideScope = 'The agent is outside the served project scope';
  const notAFile = 'The agent must be a regular file inside the served project scope';
  const realScope = await realpath(scopeRoot);
  // The session page reads its path back from a run, so it can already be in
  // realpath form (/private/var/... for a /var/... scope). Accept the target
  // under either spelling of the scope, then settle both on the real tree.
  const absolute = [resolve(scopeRoot, requested), resolve(realScope, requested)]
    .find((candidate) => isPathInside(scopeRoot, candidate) || isPathInside(realScope, candidate));
  if (!absolute) throw new ChangesetTargetError(outsideScope);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new ChangesetTargetError(outsideScope);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new ChangesetTargetError(notAFile);
  const realTarget = await realpath(absolute);
  if (!isPathInside(realScope, realTarget)) throw new ChangesetTargetError(notAFile);
  return relative(realScope, realTarget).replace(/\\/gu, '/');
}

/** A start refused because another change set already owns the same target. */
export class ChangesetActiveError extends Error {
  constructor(public readonly sessionId: string, message: string) {
    super(message);
  }
}

/** A file row without its body, for the cheap list endpoint. */
export type ChangesetFileSummary = Omit<ChangesetFile, 'content' | 'patch'>;

export interface ChangesetSummaryRecord extends Omit<ChangesetRecord, 'proposals'> {
  proposals: Array<Omit<ChangesetProposal, 'files'> & { files: ChangesetFileSummary[] }>;
}

/** Strip every proposed file body: a list of change sets is a list of paths. */
export function changesetListSummary(record: ChangesetRecord): ChangesetSummaryRecord {
  return {
    ...record,
    proposals: record.proposals.map((proposal) => ({
      ...proposal,
      files: proposal.files.map(({ content: _content, patch: _patch, ...file }) => file),
    })),
  };
}

/** The model's staged workspace: `<changesetDir>/<id>/`, edit folder included.
 *  `rm` unlinks symlinks instead of descending, so the real project is safe
 *  even though the shadow root under here is mostly links. */
export async function removeChangesetWorkspace(projectRoot: string, sessionId: string): Promise<void> {
  assertChangesetId(sessionId);
  await rm(join(changesetDir(projectRoot), sessionId), { recursive: true, force: true });
}

/**
 * Create the durable record and the workspace the filesystem overlay writes
 * into. The empty base map is written up front so a session that only adds new
 * files still has a well-formed manifest for `submit_changes` to read.
 */
export async function prepareChangesetStart(input: {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  scopeRoot: string;
  mode: ChangesetMode;
  instruction: string;
  authoringModel: string;
  target?: { path: string; name: string };
  originSessionId?: string;
  originTranscript?: string;
}): Promise<ChangesetRecord> {
  if (input.mode === 'revise') {
    if (!input.target) throw new Error('A revise change set needs a target agent');
    const conflict = activeChangesetForTarget(
      await listChangesetRecords(input.projectRoot, { targetPath: input.target.path }),
      input.target.path,
    );
    if (conflict) {
      throw new ChangesetActiveError(
        conflict.sessionId,
        'This agent already has a change set waiting for completion or review',
      );
    }
  }
  const record = await createChangesetRecord({
    sessionId: input.sessionId,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    scopeRoot: input.scopeRoot,
    mode: input.mode,
    ...(input.target && { target: input.target }),
    ...(input.originSessionId && { originSessionId: input.originSessionId }),
    ...(input.originTranscript && { originTranscript: input.originTranscript }),
    instruction: input.instruction,
    authoringModel: input.authoringModel,
  });
  await mkdir(changesetEditRoot(input.projectRoot, input.sessionId), { recursive: true });
  await writeFile(changesetBasePath(input.projectRoot, input.sessionId), '{}\n', { mode: 0o600 });
  return record;
}

/** Apply re-runs the same validator `submit_changes` ran, against the stored
 *  proposal, so a project that moved under the review is caught before a
 *  single file is written. */
export function changesetApplyValidator(input: {
  projectRoot: string;
  scopeRoot: string;
  availableModels: readonly string[];
  availableSkills: readonly string[];
}): ChangesetValidate {
  return async (record, proposal) => {
    if (!proposal.entry) throw new Error('This change set has no entry agent to validate');
    await validateChangesetFiles({
      mode: record.mode,
      scopeRoot: input.scopeRoot,
      projectRoot: input.projectRoot,
      ...(record.target && { target: { path: record.target.path } }),
      entry: proposal.entry,
      files: proposal.files.map((file) => ({
        path: file.path,
        op: file.op,
        baseHash: file.baseHash,
        content: file.content,
      })),
      availableModels: input.availableModels,
      availableSkills: input.availableSkills,
      readProjectFile: changesetProjectFileReader(input.scopeRoot),
      listProjectAgents: () => listChangesetProjectAgents(input.scopeRoot),
    });
  };
}

/** Apply, then drop the staged workspace: the record carries everything the
 *  review and Restore still need. */
export async function applyProjectChangeset(input: {
  projectRoot: string;
  scopeRoot: string;
  sessionId: string;
  availableModels: readonly string[];
  availableSkills: readonly string[];
}): Promise<ChangesetRecord> {
  const record = await applyChangeset({
    projectRoot: input.projectRoot,
    scopeRoot: input.scopeRoot,
    sessionId: input.sessionId,
    validate: changesetApplyValidator(input),
  });
  await removeChangesetWorkspace(input.projectRoot, input.sessionId).catch(() => undefined);
  return record;
}

export async function discardProjectChangeset(projectRoot: string, sessionId: string): Promise<ChangesetRecord> {
  const record = await discardChangeset(projectRoot, sessionId);
  await removeChangesetWorkspace(projectRoot, sessionId).catch(() => undefined);
  return record;
}

/**
 * Settle a change set whose authoring session reached a terminal turn.
 * Mirrors `settleAgentRevisionExecution`: a successful turn that never called
 * `submit_changes` is an invalid internal outcome, otherwise the review page
 * would poll a record nothing will ever move on. `failChangeset` re-reads and
 * only acts on a still-`running` record, which is what keeps a submission (or
 * a request-changes reopen) landing between the two reads from being
 * overwritten. Returns the error it applied, so the caller can mirror it onto
 * the job envelope.
 */
export async function settleChangesetSession(
  projectRoot: string,
  sessionId: string,
  result: WorkerExecuteResult | WorkerExecuteError,
): Promise<{ code: string; message: string } | undefined> {
  const record = await readChangesetRecord(projectRoot, sessionId);
  if (!record || record.status !== 'running') return undefined;
  if (!result.success) {
    await failChangeset(projectRoot, sessionId, result.error);
    return result.error;
  }
  if (result.result.finishReason === 'suspended' || result.result.approvalUrl) return undefined;
  const error = { ...CHANGESET_NOT_SUBMITTED };
  await failChangeset(projectRoot, sessionId, error);
  return error;
}
