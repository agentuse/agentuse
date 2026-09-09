/**
 * Shared contract for multi-file agent changesets (agentuse-lab #226, #227,
 * #236). A changeset is the durable record behind the create and revise flows:
 * the model writes into a staged edit folder through the filesystem overlay,
 * `submit_changes` turns that folder into a proposal, the operator reviews it,
 * and Apply copies the files into the project all-or-nothing.
 *
 * This file holds types and path helpers only, so the record, validator,
 * apply, mount, and tool modules can be built against one contract.
 */
import { join } from 'node:path';
import { getProjectDirSync } from '../storage/paths.js';

export type ChangesetMode = 'create' | 'revise';

export type ChangesetStatus =
  | 'running'
  | 'proposed'
  | 'no-change'
  | 'applying'
  | 'applied'
  | 'discarded'
  | 'restoring'
  | 'restored'
  | 'error';

export type ChangesetFileKind = 'agent' | 'support';
export type ChangesetFileOp = 'add' | 'modify';

export interface ChangesetFile {
  /** Project-relative path, forward slashes, no leading `./`. */
  path: string;
  kind: ChangesetFileKind;
  op: ChangesetFileOp;
  /** sha256 hex of the real file when the overlay first copied it; null for `add`. */
  baseHash: string | null;
  /** Full proposed content. */
  content: string;
  /** sha256 hex of `content`. */
  hash: string;
  /** Unified diff against the base (empty base for `add`), for the review page. */
  patch?: string;
  /** Agent files only: human-readable capability deltas against the base. */
  capabilityChanges?: string[];
  /** Static review flags (scripts, lock files, "also used by", "not referenced by any agent"). */
  flags?: string[];
}

export interface ChangesetProposal {
  /** 1-based, shown in the review header. */
  index: number;
  submittedAt: number;
  /** Operator request this proposal answers. Absent on the first proposal. */
  request?: string;
  /** The model's short reply (summary or recommended action). */
  reply: string;
  diagnosis?: string;
  /** Project-relative path of the agent to run in a test run. Absent on a no-change proposal. */
  entry?: string;
  files: ChangesetFile[];
  loadedSkills?: string[];
  /** Web URLs fetched while producing this proposal, for provenance in review. */
  externalReads?: string[];
}

export type ChangesetTestRunStatus = 'running' | 'completed' | 'error';

export interface ChangesetTestRun {
  sessionId: string;
  proposalIndex: number;
  startedAt: number;
  status: ChangesetTestRunStatus;
  finishedAt?: number;
  error?: { code: string; message: string };
}

export interface ChangesetAppliedFile {
  path: string;
  /** Object-store hash of the content replaced, null when the file was created. */
  beforeHash: string | null;
  /** sha256 hex of the content written. */
  afterHash: string;
}

export interface ChangesetRecord {
  version: 1;
  /** Creator/reviser session id; also the internal job id. ULID. */
  sessionId: string;
  projectId: string;
  projectRoot: string;
  scopeRoot: string;
  mode: ChangesetMode;
  /** Revise only. `path` is project-relative. */
  target?: { path: string; name: string };
  /** Revise from a run: the session whose transcript is the evidence. */
  originSessionId?: string;
  instruction: string;
  authoringModel: string;
  status: ChangesetStatus;
  createdAt: number;
  updatedAt: number;
  proposals: ChangesetProposal[];
  exchange: Array<{ request?: string; reply?: string }>;
  testRuns: ChangesetTestRun[];
  /** The change request the currently running turn is answering. */
  pendingRequest?: string;
  applied?: { at: number; files: ChangesetAppliedFile[] };
  restoredAt?: number;
  error?: { code: string; message: string };
}

/** Hard deny list, applied to writes in the overlay and again at submit and apply. */
export const CHANGESET_DENIED_SEGMENTS: readonly string[] = [
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv', '.agentuse',
];

export const CHANGESET_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 64_000,
  maxTotalBytes: 256_000,
} as const;

export const CHANGESET_SUPPORT_EXTENSIONS: readonly string[] = [
  '.py', '.ts', '.js', '.sh', '.rb', '.md', '.json', '.csv', '.txt', '.yaml', '.yml',
];

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function assertChangesetId(sessionId: string): void {
  if (!ULID.test(sessionId)) throw new Error('Invalid changeset id');
}

/** `.agentuse/changeset/` under the project state dir. */
export function changesetDir(projectRoot: string): string {
  return join(getProjectDirSync(projectRoot), 'changeset');
}

/** `<changesetDir>/<id>.json` */
export function changesetRecordPath(projectRoot: string, sessionId: string): string {
  assertChangesetId(sessionId);
  return join(changesetDir(projectRoot), `${sessionId}.json`);
}

/** `<changesetDir>/<id>/edit/` — the model's staged writes, project-relative layout. */
export function changesetEditRoot(projectRoot: string, sessionId: string): string {
  assertChangesetId(sessionId);
  return join(changesetDir(projectRoot), sessionId, 'edit');
}

/** `<changesetDir>/<id>/shadow/` — host-built link farm for test runs. */
export function changesetShadowRoot(projectRoot: string, sessionId: string): string {
  assertChangesetId(sessionId);
  return join(changesetDir(projectRoot), sessionId, 'shadow');
}

/** `<changesetDir>/<id>/base.json` — `{ [path]: baseHash }` recorded by the overlay on first write. */
export function changesetBasePath(projectRoot: string, sessionId: string): string {
  assertChangesetId(sessionId);
  return join(changesetDir(projectRoot), sessionId, 'base.json');
}

/** `<changesetDir>/objects/<sha256>` — content-addressed store for undo copies. */
export function changesetObjectPath(projectRoot: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid object hash');
  return join(changesetDir(projectRoot), 'objects', hash);
}
