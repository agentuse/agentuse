import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChangesetRecord } from '../src/agents/changeset';
import { changesetRecordPath, type ChangesetRecord } from '../src/agents/changeset-types';
import {
  ChangesetActiveError,
  prepareChangesetStart,
  reconcileChangesetSession,
} from '../src/cli/serve/changesets';
import type { AuthoringSessionStatusSource } from '../src/cli/serve/authoring-session';

/**
 * A change set's first run and its continuations are settled by in-memory
 * callbacks. After a daemon restart nothing would ever move a `running` record,
 * so reads settle it against the durable session instead, the way revisions do.
 */

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

const SESSION_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';
const NEXT_SESSION_ID = '01K5ABCDEFGHJKMNPQRSTVWXYZ';
const TARGET = 'agents/triage.agentuse';

async function runningChangeset(options: { ageMs?: number } = {}): Promise<{ projectRoot: string; record: ChangesetRecord }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'changeset-reconcile-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'changeset-reconcile-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  await mkdir(join(projectRoot, 'agents'), { recursive: true });
  await writeFile(join(projectRoot, TARGET), '---\nname: Triage\nmodel: openai:gpt-5.6-luna\n---\n\nTriage tickets.\n');
  let record = await prepareChangesetStart({
    sessionId: SESSION_ID,
    projectId: 'demo',
    projectRoot,
    scopeRoot: projectRoot,
    mode: 'revise',
    target: { path: TARGET, name: 'Triage' },
    instruction: 'Exclude refunds.',
    authoringModel: 'openai:gpt-5.6-luna',
  });
  if (options.ageMs) {
    record = { ...record, createdAt: record.createdAt - options.ageMs };
    await writeFile(changesetRecordPath(projectRoot, SESSION_ID), `${JSON.stringify(record, null, 2)}\n`);
  }
  return { projectRoot, record };
}

function worker(answer: Awaited<ReturnType<AuthoringSessionStatusSource['getSessionStatusInfo']>>) {
  const calls: string[] = [];
  const source: AuthoringSessionStatusSource = {
    async getSessionStatusInfo(options) {
      calls.push(options.sessionId);
      return answer;
    },
  };
  return { source, calls };
}

function session(sessionStatus: string, extra: { errorCode?: string; errorMessage?: string } = {}) {
  return worker({
    success: true,
    session: { sessionId: SESSION_ID, sessionStatus, agent: { id: 'reviser', name: 'Reviser' }, ...extra },
  });
}

const missing = () => worker({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'not found' } });

describe('settling a running change set against its durable session', () => {
  it('fails a session that completed without submitting', async () => {
    const { record } = await runningChangeset();
    const settled = await reconcileChangesetSession({ worker: session('completed').source, record, inFlight: false });
    expect(settled.status).toBe('error');
    expect(settled.error?.code).toBe('CHANGESET_NOT_SUBMITTED');
    expect((await readChangesetRecord(record.projectRoot, SESSION_ID))?.status).toBe('error');
  });

  it("carries a failed session's own error onto the record", async () => {
    const { record } = await runningChangeset();
    const settled = await reconcileChangesetSession({
      worker: session('error', { errorCode: 'PROVIDER_FAILED', errorMessage: 'The provider rejected the key' }).source,
      record,
      inFlight: false,
    });
    expect(settled.error).toEqual({ code: 'PROVIDER_FAILED', message: 'The provider rejected the key' });
  });

  it('calls a session lost only once the start-up window has passed', async () => {
    const young = await runningChangeset();
    expect((await reconcileChangesetSession({ worker: missing().source, record: young.record, inFlight: false })).status)
      .toBe('running');

    const old = await runningChangeset({ ageMs: 60_000 });
    const settled = await reconcileChangesetSession({ worker: missing().source, record: old.record, inFlight: false });
    expect(settled.status).toBe('error');
    expect(settled.error?.code).toBe('CHANGESET_SESSION_MISSING');
  });

  it('leaves running, suspended, and mid-handoff sessions alone', async () => {
    const { record } = await runningChangeset();
    for (const status of ['running', 'suspended']) {
      expect((await reconcileChangesetSession({ worker: session(status).source, record, inFlight: false })).status)
        .toBe('running');
    }
    const handoff = session('completed');
    expect((await reconcileChangesetSession({ worker: handoff.source, record, inFlight: true })).status).toBe('running');
    expect(handoff.calls).toEqual([]);
    expect((await readChangesetRecord(record.projectRoot, SESSION_ID))?.status).toBe('running');
  });

  it('does not ask about a record that is not running', async () => {
    const { record } = await runningChangeset();
    const done = session('completed');
    const proposed = { ...record, status: 'proposed' as const };
    expect(await reconcileChangesetSession({ worker: done.source, record: proposed, inFlight: false })).toBe(proposed);
    expect(done.calls).toEqual([]);
  });

  it('frees the target of a dead authoring run for a new change set', async () => {
    const { projectRoot } = await runningChangeset();
    const next = {
      sessionId: NEXT_SESSION_ID,
      projectId: 'demo',
      projectRoot,
      scopeRoot: projectRoot,
      mode: 'revise' as const,
      target: { path: TARGET, name: 'Triage' },
      instruction: 'Exclude refunds, again.',
      authoringModel: 'openai:gpt-5.6-luna',
    };
    const live = session('running').source;
    await expect(prepareChangesetStart({
      ...next,
      reconcile: (existing) => reconcileChangesetSession({ worker: live, record: existing, inFlight: false }),
    })).rejects.toBeInstanceOf(ChangesetActiveError);

    const dead = session('completed').source;
    const started = await prepareChangesetStart({
      ...next,
      reconcile: (existing) => reconcileChangesetSession({ worker: dead, record: existing, inFlight: false }),
    });
    expect(started.status).toBe('running');
    const stale = JSON.parse(await readFile(changesetRecordPath(projectRoot, SESSION_ID), 'utf8')) as ChangesetRecord;
    expect(stale.status).toBe('error');
    expect(stale.error?.code).toBe('CHANGESET_NOT_SUBMITTED');
  });
});
