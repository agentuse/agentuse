import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAgentDraft,
  createAgentDraftRecord,
  failAgentDraft,
  latestAgentDraft,
  listAgentDraftRecords,
  markAgentDraftDiscarded,
  markAgentDraftSaved,
  readAgentDraftRecord,
  recordAgentDraftTestRun,
  reopenAgentDraft,
  settleAgentDraftTestRun,
} from '../src/agents/draft';

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

const JOB_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';

function source(body: string): string {
  return `---\nname: Issue digest\nmodel: openai:gpt-5.6-luna\n---\n\n${body}\n`;
}

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-draft-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-draft-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  const record = await createAgentDraftRecord({
    jobId: JOB_ID,
    projectId: 'demo',
    projectRoot,
    objective: 'Digest new GitHub issues into Slack every morning.',
    guided: false,
    authoringModel: 'openai:gpt-5.6-luna',
    skillCounts: { project: 4, global: 9, ambiguous: 1 },
  });
  return { projectRoot, record };
}

describe('agent draft record', () => {
  it('starts running with no drafts and nothing written to the project', async () => {
    const { projectRoot, record } = await fixture();
    expect(record.status).toBe('running');
    expect(record.drafts).toEqual([]);
    expect(latestAgentDraft(record)).toBeUndefined();
    const reread = await readAgentDraftRecord(projectRoot, JOB_ID);
    expect(reread?.skillCounts).toEqual({ project: 4, global: 9, ambiguous: 1 });
  });

  it('numbers each accepted submission and marks the record drafted', async () => {
    const { projectRoot } = await fixture();
    await appendAgentDraft(projectRoot, JOB_ID, {
      source: source('Collect issues.'),
      name: 'Issue digest',
      fileName: 'issue-digest.agentuse',
      model: 'openai:gpt-5.6-luna',
      loadedSkills: ['github'],
    });
    const afterFirst = await readAgentDraftRecord(projectRoot, JOB_ID);
    expect(afterFirst?.status).toBe('drafted');
    expect(afterFirst?.drafts).toHaveLength(1);
    expect(afterFirst?.drafts[0]?.index).toBe(1);
    expect(afterFirst?.drafts[0]?.loadedSkills).toEqual(['github']);

    await reopenAgentDraft(projectRoot, JOB_ID, 'Skip days with no new issues.');
    const running = await readAgentDraftRecord(projectRoot, JOB_ID);
    expect(running?.status).toBe('running');
    expect(running?.pendingRequest).toBe('Skip days with no new issues.');

    await appendAgentDraft(projectRoot, JOB_ID, {
      source: source('Collect issues. Finish early when empty.'),
      name: 'Issue digest',
      fileName: 'issue-digest.agentuse',
      model: 'openai:gpt-5.6-luna',
      reply: 'Added an early finish.',
    });
    const afterSecond = await readAgentDraftRecord(projectRoot, JOB_ID);
    expect(afterSecond?.drafts).toHaveLength(2);
    expect(afterSecond?.drafts[1]?.index).toBe(2);
    // The request that produced the draft is carried onto it and cleared.
    expect(afterSecond?.drafts[1]?.request).toBe('Skip days with no new issues.');
    expect(afterSecond?.drafts[1]?.reply).toBe('Added an early finish.');
    expect(afterSecond?.pendingRequest).toBeUndefined();
    expect(latestAgentDraft(afterSecond!)?.index).toBe(2);
  });

  it('does not duplicate a draft when a restart recovers the same submission', async () => {
    const { projectRoot } = await fixture();
    const submission = {
      source: source('Collect issues.'),
      name: 'Issue digest',
      fileName: 'issue-digest.agentuse',
      model: 'openai:gpt-5.6-luna',
    };
    await appendAgentDraft(projectRoot, JOB_ID, submission);
    await appendAgentDraft(projectRoot, JOB_ID, submission);
    const record = await readAgentDraftRecord(projectRoot, JOB_ID);
    expect(record?.drafts).toHaveLength(1);
  });

  it('refuses a change request once the draft is saved or discarded', async () => {
    const { projectRoot } = await fixture();
    await appendAgentDraft(projectRoot, JOB_ID, {
      source: source('Collect issues.'),
      name: 'Issue digest',
      fileName: 'issue-digest.agentuse',
      model: 'openai:gpt-5.6-luna',
    });
    const saved = await markAgentDraftSaved(projectRoot, JOB_ID, 'agents/issue-digest.agentuse');
    expect(saved.status).toBe('saved');
    expect(saved.savedAgentRunPath).toBe('agents/issue-digest.agentuse');
    await expect(reopenAgentDraft(projectRoot, JOB_ID, 'one more change')).rejects.toThrow();
    await expect(markAgentDraftDiscarded(projectRoot, JOB_ID)).rejects.toThrow();
  });

  it('records a failed creator turn only while the draft is running', async () => {
    const { projectRoot } = await fixture();
    const failure = { code: 'DRAFT_NOT_SUBMITTED', message: 'no new draft' };
    const failed = await failAgentDraft(projectRoot, JOB_ID, failure);
    expect(failed?.status).toBe('error');
    expect(failed?.error).toEqual(failure);

    await appendAgentDraft(projectRoot, JOB_ID, {
      source: source('Collect issues.'),
      name: 'Issue digest',
      fileName: 'issue-digest.agentuse',
      model: 'openai:gpt-5.6-luna',
    });
    const untouched = await failAgentDraft(projectRoot, JOB_ID, failure);
    expect(untouched?.status).toBe('drafted');
  });

  it('tracks mock test runs per draft and settles them', async () => {
    const { projectRoot } = await fixture();
    await recordAgentDraftTestRun(projectRoot, JOB_ID, {
      sessionId: '01K5ABCDEFGHJKMNPQRSTVWXYZ',
      draftIndex: 1,
      startedAt: Date.now(),
      status: 'running',
    });
    const settled = await settleAgentDraftTestRun(projectRoot, JOB_ID, '01K5ABCDEFGHJKMNPQRSTVWXYZ', {
      status: 'completed',
    });
    expect(settled?.testRuns).toHaveLength(1);
    expect(settled?.testRuns[0]?.status).toBe('completed');
    expect(settled?.testRuns[0]?.finishedAt).toBeGreaterThan(0);
  });

  it('lists the drafts stored for a project', async () => {
    const { projectRoot } = await fixture();
    const records = await listAgentDraftRecords(projectRoot);
    expect(records.map((record) => record.jobId)).toEqual([JOB_ID]);
  });

  it('rejects an id that is not a session ulid', async () => {
    const { projectRoot } = await fixture();
    await expect(readAgentDraftRecord(projectRoot, '../escape')).rejects.toThrow(/Invalid agent draft id/u);
  });
});
