import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectDirSync } from '../storage/paths.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

/**
 * An agent draft is the durable record behind the draft-and-refine page: the
 * creator session stays open after its first submission, every accepted
 * `submit_agent_source` appends a numbered draft, and the project file is only
 * written when the operator saves. It mirrors the agent revision record, which
 * plays the same role for changes to an agent that already exists.
 */
export type AgentDraftStatus = 'running' | 'drafted' | 'saved' | 'discarded' | 'error';

export interface AgentDraftEntry {
  /** 1-based draft number shown in the panel header. */
  index: number;
  source: string;
  name: string;
  fileName: string;
  model: string;
  submittedAt: number;
  /** Operator request that produced this draft. Absent on the first draft. */
  request?: string;
  /** The creator's short reply for this draft, shown under the file. */
  reply?: string;
  /** Skills the creator had loaded when it submitted this draft. */
  loadedSkills?: string[];
}

export type AgentDraftTestRunStatus = 'running' | 'completed' | 'error';

export interface AgentDraftTestRun {
  sessionId: string;
  draftIndex: number;
  startedAt: number;
  status: AgentDraftTestRunStatus;
  finishedAt?: number;
  error?: { code: string; message: string };
}

export interface AgentDraftSkillCounts {
  project: number;
  global: number;
  ambiguous: number;
}

export interface AgentDraftRecord {
  version: 1;
  /** Equal to the creator session id, which is also the internal job id. */
  jobId: string;
  projectId: string;
  projectRoot: string;
  objective: string;
  /** Set when the draft came from a reviewed discovery suggestion. */
  guided: boolean;
  /** Present when the brief was prefilled from a discovery idea. */
  idea?: { title: string; evidence?: string };
  authoringModel: string;
  status: AgentDraftStatus;
  createdAt: number;
  updatedAt: number;
  drafts: AgentDraftEntry[];
  testRuns: AgentDraftTestRun[];
  skillCounts: AgentDraftSkillCounts;
  /** The change request the currently running creator turn is answering. */
  pendingRequest?: string;
  savedAgentRunPath?: string;
  error?: { code: string; message: string };
}

function draftDir(projectRoot: string): string {
  return join(getProjectDirSync(projectRoot), 'draft');
}

function draftPath(projectRoot: string, jobId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(jobId)) throw new Error('Invalid agent draft id');
  return join(draftDir(projectRoot), `${jobId}.json`);
}

async function writeRecord(record: AgentDraftRecord): Promise<void> {
  await mkdir(draftDir(record.projectRoot), { recursive: true });
  await atomicWriteFile(
    draftPath(record.projectRoot, record.jobId),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function createAgentDraftRecord(
  input: Omit<AgentDraftRecord, 'version' | 'status' | 'createdAt' | 'updatedAt' | 'drafts' | 'testRuns'>,
): Promise<AgentDraftRecord> {
  const now = Date.now();
  const created: AgentDraftRecord = {
    version: 1,
    ...input,
    status: 'running',
    drafts: [],
    testRuns: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(created);
  return created;
}

export async function readAgentDraftRecord(
  projectRoot: string,
  jobId: string,
): Promise<AgentDraftRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(draftPath(projectRoot, jobId), 'utf8')) as AgentDraftRecord;
    if (parsed.version !== 1 || parsed.jobId !== jobId || parsed.projectRoot !== projectRoot) return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listAgentDraftRecords(projectRoot: string): Promise<AgentDraftRecord[]> {
  let names: string[];
  try {
    names = await readdir(draftDir(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/i.test(name))
    .map((name) => readAgentDraftRecord(projectRoot, name.slice(0, -5))));
  return records
    .filter((record): record is AgentDraftRecord => Boolean(record))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function mutate(
  projectRoot: string,
  jobId: string,
  change: (record: AgentDraftRecord) => AgentDraftRecord,
): Promise<AgentDraftRecord> {
  const record = await readAgentDraftRecord(projectRoot, jobId);
  if (!record) throw new Error('This agent draft no longer exists');
  const next = { ...change(record), updatedAt: Date.now() };
  await writeRecord(next);
  return next;
}

/**
 * Append one accepted submission. The same submission arriving twice (a live
 * consume followed by a restart recovery) must not create a duplicate draft, so
 * an identical source at the tail is treated as already recorded.
 */
export async function appendAgentDraft(
  projectRoot: string,
  jobId: string,
  submission: Omit<AgentDraftEntry, 'index' | 'submittedAt'>,
): Promise<AgentDraftRecord> {
  return mutate(projectRoot, jobId, (record) => {
    const { pendingRequest, ...retained } = record;
    const latest = record.drafts[record.drafts.length - 1];
    if (latest && latest.source === submission.source) {
      return { ...retained, status: 'drafted' };
    }
    const entry: AgentDraftEntry = {
      ...(pendingRequest && { request: pendingRequest }),
      ...submission,
      index: record.drafts.length + 1,
      submittedAt: Date.now(),
    };
    return { ...retained, status: 'drafted', drafts: [...record.drafts, entry] };
  });
}

/** Record the operator request that the reopened creator session is answering. */
export async function reopenAgentDraft(
  projectRoot: string,
  jobId: string,
  request: string,
): Promise<AgentDraftRecord> {
  const record = await readAgentDraftRecord(projectRoot, jobId);
  if (!record) throw new Error('This agent draft no longer exists');
  if (record.status !== 'drafted' && record.status !== 'error') {
    throw new Error('This draft is not waiting for a change request');
  }
  return mutate(projectRoot, jobId, (next) => {
    const { error: _error, ...retained } = next;
    return { ...retained, status: 'running', pendingRequest: request };
  });
}

export async function failAgentDraft(
  projectRoot: string,
  jobId: string,
  error: { code: string; message: string },
): Promise<AgentDraftRecord | undefined> {
  const record = await readAgentDraftRecord(projectRoot, jobId);
  if (!record || record.status !== 'running') return record;
  return mutate(projectRoot, jobId, (next) => ({ ...next, status: 'error', error }));
}

export async function markAgentDraftSaved(
  projectRoot: string,
  jobId: string,
  savedAgentRunPath: string,
): Promise<AgentDraftRecord> {
  return mutate(projectRoot, jobId, (record) => ({ ...record, status: 'saved', savedAgentRunPath }));
}

export async function markAgentDraftDiscarded(
  projectRoot: string,
  jobId: string,
): Promise<AgentDraftRecord> {
  return mutate(projectRoot, jobId, (record) => {
    if (record.status === 'saved') throw new Error('This draft was already saved');
    return { ...record, status: 'discarded' };
  });
}

export async function recordAgentDraftTestRun(
  projectRoot: string,
  jobId: string,
  run: AgentDraftTestRun,
): Promise<AgentDraftRecord> {
  return mutate(projectRoot, jobId, (record) => ({
    ...record,
    testRuns: [...record.testRuns.filter((existing) => existing.sessionId !== run.sessionId), run],
  }));
}

export async function settleAgentDraftTestRun(
  projectRoot: string,
  jobId: string,
  sessionId: string,
  outcome: { status: AgentDraftTestRunStatus; error?: { code: string; message: string } },
): Promise<AgentDraftRecord | undefined> {
  const record = await readAgentDraftRecord(projectRoot, jobId);
  if (!record) return undefined;
  return mutate(projectRoot, jobId, (next) => ({
    ...next,
    testRuns: next.testRuns.map((run) => run.sessionId === sessionId
      ? { ...run, status: outcome.status, finishedAt: Date.now(), ...(outcome.error && { error: outcome.error }) }
      : run),
  }));
}

/** The draft the panel shows and the save route writes. */
export function latestAgentDraft(record: AgentDraftRecord): AgentDraftEntry | undefined {
  return record.drafts[record.drafts.length - 1];
}
