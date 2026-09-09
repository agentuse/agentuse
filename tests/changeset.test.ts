import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectDirSync } from '../src/storage/paths';
import { changesetRecordPath, type ChangesetFile } from '../src/agents/changeset-types';
import {
  appendChangesetProposal,
  contentHash,
  createChangesetRecord,
  discardChangeset,
  failChangeset,
  getChangesetObject,
  latestChangesetProposal,
  listChangesetRecords,
  putChangesetObject,
  readChangesetRecord,
  recordChangesetTestRun,
  reopenChangeset,
  settleChangesetTestRun,
} from '../src/agents/changeset';

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

const SESSION_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';
const OTHER_SESSION_ID = '01K5ABCDEFGHJKMNPQRSTVWXYZ';

async function project() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'changeset-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'changeset-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  return { projectRoot, dataRoot };
}

function file(path: string, content: string, overrides: Partial<ChangesetFile> = {}): ChangesetFile {
  return {
    path,
    kind: path.endsWith('.agentuse') ? 'agent' : 'support',
    op: 'add',
    baseHash: null,
    content,
    hash: contentHash(content),
    ...overrides,
  };
}

async function record(projectRoot: string, sessionId = SESSION_ID) {
  return createChangesetRecord({
    sessionId,
    projectId: 'demo',
    projectRoot,
    scopeRoot: projectRoot,
    mode: 'create',
    instruction: 'Build a collector and a journal.',
    authoringModel: 'openai:gpt-5.6-luna',
  });
}

describe('changeset record', () => {
  it('creates, reads, and lists a record', async () => {
    const { projectRoot } = await project();
    const created = await record(projectRoot);
    expect(created.status).toBe('running');
    expect(created.proposals).toEqual([]);

    const read = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(read?.instruction).toBe('Build a collector and a journal.');

    const listed = await listChangesetRecords(projectRoot);
    expect(listed.map((entry) => entry.sessionId)).toEqual([SESSION_ID]);
  });

  it('returns undefined for a missing record', async () => {
    const { projectRoot } = await project();
    expect(await readChangesetRecord(projectRoot, SESSION_ID)).toBeUndefined();
  });

  it('rejects an id that is not a ulid', async () => {
    const { projectRoot } = await project();
    expect(() => changesetRecordPath(projectRoot, '../escape')).toThrow('Invalid changeset id');
  });

  it('ignores a record whose stored project root does not match', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    const path = changesetRecordPath(projectRoot, SESSION_ID);
    const stored = JSON.parse(await readFile(path, 'utf8')) as { projectRoot: string };
    await writeFile(path, JSON.stringify({ ...stored, projectRoot: '/elsewhere' }));
    expect(await readChangesetRecord(projectRoot, SESSION_ID)).toBeUndefined();
  });

  it('filters the list by target path and origin session', async () => {
    const { projectRoot } = await project();
    await createChangesetRecord({
      sessionId: SESSION_ID,
      projectId: 'demo',
      projectRoot,
      scopeRoot: projectRoot,
      mode: 'revise',
      target: { path: 'agents/triage.agentuse', name: 'Triage' },
      originSessionId: OTHER_SESSION_ID,
      instruction: 'Exclude refunded orders.',
      authoringModel: 'openai:gpt-5.6-luna',
    });
    await record(projectRoot, OTHER_SESSION_ID);

    const byTarget = await listChangesetRecords(projectRoot, { targetPath: 'agents/triage.agentuse' });
    expect(byTarget.map((entry) => entry.sessionId)).toEqual([SESSION_ID]);
    const byOrigin = await listChangesetRecords(projectRoot, { originSessionId: OTHER_SESSION_ID });
    expect(byOrigin.map((entry) => entry.sessionId)).toEqual([SESSION_ID]);
    expect(await listChangesetRecords(projectRoot, { targetPath: 'nope.agentuse' })).toEqual([]);
  });

  it('appends a proposal, consumes the pending request, and records the reply', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    const first = await appendChangesetProposal(projectRoot, SESSION_ID, {
      reply: 'Added a collector.',
      entry: 'agents/collector.agentuse',
      files: [file('agents/collector.agentuse', '---\nname: Collector\n---\n\nCollect.\n')],
    });
    expect(first.status).toBe('proposed');
    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]!.index).toBe(1);
    expect(first.proposals[0]!.request).toBeUndefined();
    expect(first.exchange).toEqual([{ reply: 'Added a collector.' }]);

    await reopenChangeset(projectRoot, SESSION_ID, 'Also write a journal.');
    const second = await appendChangesetProposal(projectRoot, SESSION_ID, {
      reply: 'Added the journal too.',
      entry: 'agents/collector.agentuse',
      files: [
        file('agents/collector.agentuse', '---\nname: Collector\n---\n\nCollect.\n'),
        file('agents/journal.agentuse', '---\nname: Journal\n---\n\nWrite.\n'),
      ],
    });
    expect(second.proposals).toHaveLength(2);
    expect(second.proposals[1]!.index).toBe(2);
    expect(second.proposals[1]!.request).toBe('Also write a journal.');
    expect(second.pendingRequest).toBeUndefined();
    expect(second.exchange).toEqual([
      { reply: 'Added a collector.' },
      { request: 'Also write a journal.', reply: 'Added the journal too.' },
    ]);
    expect(latestChangesetProposal(second)?.files).toHaveLength(2);
  });

  it('does not duplicate an identical file set at the tail', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    const submission = {
      reply: 'Added a collector.',
      entry: 'agents/collector.agentuse',
      files: [file('agents/collector.agentuse', '---\nname: Collector\n---\n\nCollect.\n')],
    };
    await appendChangesetProposal(projectRoot, SESSION_ID, submission);
    const again = await appendChangesetProposal(projectRoot, SESSION_ID, submission);
    expect(again.proposals).toHaveLength(1);
    expect(again.exchange).toHaveLength(1);
    expect(again.status).toBe('proposed');
  });

  it('marks an empty file set as no-change and keeps the proposal on discard', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    const proposed = await appendChangesetProposal(projectRoot, SESSION_ID, {
      reply: 'Nothing to change, fix the credential instead.',
      entry: '',
      files: [],
      diagnosis: 'The failure is a missing token, not the agent contract.',
    });
    expect(proposed.status).toBe('no-change');

    const discarded = await discardChangeset(projectRoot, SESSION_ID);
    expect(discarded.status).toBe('discarded');
    expect(discarded.proposals).toHaveLength(1);
    expect(discarded.proposals[0]!.diagnosis).toBe('The failure is a missing token, not the agent contract.');
    await expect(discardChangeset(projectRoot, SESSION_ID)).rejects.toThrow('cannot be discarded');
  });

  it('reopens from proposed and from error, clearing the error', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    const failed = await failChangeset(projectRoot, SESSION_ID, { code: 'TIMEOUT', message: 'Ran out of time' });
    expect(failed?.status).toBe('error');

    const reopened = await reopenChangeset(projectRoot, SESSION_ID, 'Try again with fewer steps.');
    expect(reopened.status).toBe('running');
    expect(reopened.error).toBeUndefined();
    expect(reopened.pendingRequest).toBe('Try again with fewer steps.');

    await appendChangesetProposal(projectRoot, SESSION_ID, {
      reply: 'Done.',
      entry: 'agents/collector.agentuse',
      files: [file('agents/collector.agentuse', '---\nname: Collector\n---\n\nCollect.\n')],
    });
    await expect(reopenChangeset(projectRoot, OTHER_SESSION_ID, 'x')).rejects.toThrow('no longer exists');
  });

  it('refuses to reopen a running changeset', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    await expect(reopenChangeset(projectRoot, SESSION_ID, 'now')).rejects.toThrow('not waiting for a change request');
  });

  it('records and settles a test run', async () => {
    const { projectRoot } = await project();
    await record(projectRoot);
    await appendChangesetProposal(projectRoot, SESSION_ID, {
      reply: 'Added a collector.',
      entry: 'agents/collector.agentuse',
      files: [file('agents/collector.agentuse', '---\nname: Collector\n---\n\nCollect.\n')],
    });
    const started = await recordChangesetTestRun(projectRoot, SESSION_ID, {
      sessionId: OTHER_SESSION_ID,
      proposalIndex: 1,
      startedAt: Date.now(),
      status: 'running',
    });
    expect(started.testRuns).toHaveLength(1);

    const settled = await settleChangesetTestRun(projectRoot, SESSION_ID, OTHER_SESSION_ID, { status: 'completed' });
    expect(settled?.testRuns[0]!.status).toBe('completed');
    expect(settled?.testRuns[0]!.finishedAt).toBeGreaterThan(0);
  });
});

describe('changeset object store', () => {
  it('stores content once under its hash and reads it back', async () => {
    const { projectRoot } = await project();
    const content = 'print("hello")\n';
    const hash = await putChangesetObject(projectRoot, content);
    expect(hash).toBe(contentHash(content));
    expect(await putChangesetObject(projectRoot, content)).toBe(hash);
    expect(await getChangesetObject(projectRoot, hash)).toBe(content);
    expect(join(getProjectDirSync(projectRoot), 'changeset', 'objects', hash)).toContain(hash);
  });

  it('returns undefined for an object that was never stored', async () => {
    const { projectRoot } = await project();
    expect(await getChangesetObject(projectRoot, contentHash('absent'))).toBeUndefined();
  });
});
