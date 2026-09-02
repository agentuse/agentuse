import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectDir, getSessionStorageDir } from '../storage/index.js';
import { EFFECT_WAL_FILENAME, STRUCTURED_DELIVERY_CHECKPOINT } from '../runner/effect-wal.js';
import { parseAgentContent } from '../parser.js';

const JOB_DIRECTORY = 'internal-agent-jobs';

function jobFile(projectDir: string, id: string): string {
  if (!/^[0-9A-Z]+$/u.test(id)) throw new Error('Invalid internal agent job id');
  return join(projectDir, JOB_DIRECTORY, `${id}.json`);
}

/** Persist the host-owned envelope around an internal session. Session state is
 * already durable; this record retains the request needed to turn a completed
 * structured handoff into its project artifact after a serve restart. */
export async function writeInternalAgentJobRecord(projectRoot: string, id: string, record: unknown): Promise<void> {
  const projectDir = await getProjectDir(projectRoot);
  const directory = join(projectDir, JOB_DIRECTORY);
  const target = jobFile(projectDir, id);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(record), 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readInternalAgentJobRecord<T>(projectRoot: string, id: string): Promise<T | null> {
  const projectDir = await getProjectDir(projectRoot);
  try {
    return JSON.parse(await readFile(jobFile(projectDir, id), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface RecoveredAgentSourceSubmission {
  source: string;
  name: string;
  fileName: string;
  model: string;
}

export type InternalCreatorRecovery =
  | { status: 'running' }
  | { status: 'error'; error: { code: string; message: string } }
  | { status: 'completed'; submission: RecoveredAgentSourceSubmission };

function parseSubmission(value: unknown): RecoveredAgentSourceSubmission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'agent-source'
    || typeof record.source !== 'string'
    || typeof record.name !== 'string'
    || typeof record.fileName !== 'string'
    || typeof record.model !== 'string') return null;
  return {
    source: record.source,
    name: record.name,
    fileName: record.fileName,
    model: record.model,
  };
}

async function findTopLevelSessionDirectory(projectRoot: string, sessionId: string): Promise<string | null> {
  const storageRoot = await getSessionStorageDir(projectRoot);
  const entries = await readdir(storageRoot, { withFileTypes: true }).catch(() => []);
  const entry = entries.find((candidate) => candidate.isDirectory() && candidate.name.startsWith(`${sessionId}-`));
  return entry ? join(storageRoot, entry.name) : null;
}

/** Read the durable result of a creator session whose owning serve process may
 * no longer exist. New sessions use the untruncated checkpoint. The WAL fallback
 * recovers sessions created before that checkpoint existed when their accepted
 * payload fit in the audit journal. */
export async function recoverInternalCreatorSession(
  projectRoot: string,
  sessionId: string,
): Promise<InternalCreatorRecovery | null> {
  const directory = await findTopLevelSessionDirectory(projectRoot, sessionId);
  if (!directory) return null;
  const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')) as {
    status?: string;
    error?: { code?: string; message?: string };
  };
  if (session.status !== 'completed') {
    if (session.status === 'error' || session.status === 'stopped') {
      return {
        status: 'error',
        error: {
          code: session.error?.code ?? 'CREATOR_SESSION_FAILED',
          message: session.error?.message ?? 'The creator session did not finish successfully',
        },
      };
    }
    return { status: 'running' };
  }

  const checkpoint = await readFile(join(directory, `${STRUCTURED_DELIVERY_CHECKPOINT}.json`), 'utf8')
    .then((contents) => parseSubmission(JSON.parse(contents)))
    .catch(() => null);
  if (checkpoint) return { status: 'completed', submission: checkpoint };

  const records: Array<Record<string, unknown>> = await readFile(join(directory, EFFECT_WAL_FILENAME), 'utf8')
    .then((contents) => contents.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    }))
    .catch(() => []);
  const acceptedCalls = new Set(records.filter((record) =>
    record.event === 'tool-end' && record.tool === 'submit_agent_source' && record.ok === true && typeof record.callId === 'string'
  ).map((record) => record.callId as string));
  const submission = [...records].reverse().find((record) =>
    record.event === 'tool-start'
      && record.tool === 'submit_agent_source'
      && typeof record.callId === 'string'
      && acceptedCalls.has(record.callId)
  );
  const input = submission?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {
    status: 'error',
    error: { code: 'CREATOR_RESULT_MISSING', message: 'The completed creator session has no recoverable agent source' },
  };
  const source = input as Record<string, unknown>;
  let model: string | undefined;
  if (typeof source.source === 'string') {
    try { model = parseAgentContent(source.source, '').config.model; } catch { /* handled below */ }
  }
  const recovered = parseSubmission({
    kind: 'agent-source',
    source: source.source,
    name: source.name,
    fileName: source.filename,
    model,
  });
  return recovered
    ? { status: 'completed', submission: recovered }
    : { status: 'error', error: { code: 'CREATOR_RESULT_MISSING', message: 'The completed creator session has no recoverable agent source' } };
}
