import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changesetRecordPath, type ChangesetFile, type ChangesetRecord } from '../src/agents/changeset-types';
import {
  appendChangesetProposal,
  contentHash,
  createChangesetRecord,
  readChangesetRecord,
} from '../src/agents/changeset';
import { applyChangeset, restoreChangeset } from '../src/agents/changeset-apply';

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

const SESSION_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';
const EXISTING = 'agents/triage.agentuse';
const EXISTING_SOURCE = '---\nname: Triage\nmodel: openai:gpt-5.6-luna\n---\n\nTriage tickets.\n';
const REVISED_SOURCE = '---\nname: Triage\nmodel: openai:gpt-5.6-luna\n---\n\nTriage tickets, excluding refunds.\n';
const NEW_SCRIPT = 'scripts/collect.py\n';

const noopValidate = async (): Promise<void> => undefined;

function addFile(path: string, content: string): ChangesetFile {
  return { path, kind: 'support', op: 'add', baseHash: null, content, hash: contentHash(content) };
}

function modifyFile(path: string, base: string, content: string): ChangesetFile {
  return { path, kind: 'agent', op: 'modify', baseHash: contentHash(base), content, hash: contentHash(content) };
}

/** A project with one existing agent plus a proposed add and modify. */
async function fixture(files?: ChangesetFile[]) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'changeset-apply-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'changeset-apply-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  await mkdir(join(projectRoot, 'agents'), { recursive: true });
  await writeFile(join(projectRoot, EXISTING), EXISTING_SOURCE);

  await createChangesetRecord({
    sessionId: SESSION_ID,
    projectId: 'demo',
    projectRoot,
    scopeRoot: projectRoot,
    mode: 'revise',
    target: { path: EXISTING, name: 'Triage' },
    instruction: 'Exclude refunded orders and add the collector script.',
    authoringModel: 'openai:gpt-5.6-luna',
  });
  await appendChangesetProposal(projectRoot, SESSION_ID, {
    reply: 'Excluded refunds and added the script.',
    entry: EXISTING,
    files: files ?? [
      modifyFile(EXISTING, EXISTING_SOURCE, REVISED_SOURCE),
      addFile('scripts/collect.py', NEW_SCRIPT),
    ],
  });
  return { projectRoot };
}

const apply = (projectRoot: string) => applyChangeset({
  projectRoot,
  scopeRoot: projectRoot,
  sessionId: SESSION_ID,
  validate: noopValidate,
});

describe('applyChangeset', () => {
  it('writes an add and a modify, then records the applied files', async () => {
    const { projectRoot } = await fixture();
    const applied = await apply(projectRoot);

    expect(applied.status).toBe('applied');
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(REVISED_SOURCE);
    expect(await readFile(join(projectRoot, 'scripts/collect.py'), 'utf8')).toBe(NEW_SCRIPT);
    expect(applied.applied?.files).toEqual([
      { path: EXISTING, beforeHash: contentHash(EXISTING_SOURCE), afterHash: contentHash(REVISED_SOURCE) },
      { path: 'scripts/collect.py', beforeHash: null, afterHash: contentHash(NEW_SCRIPT) },
    ]);
  });

  it('runs the injected validator before touching the project', async () => {
    const { projectRoot } = await fixture();
    const seen: string[] = [];
    await expect(applyChangeset({
      projectRoot,
      scopeRoot: projectRoot,
      sessionId: SESSION_ID,
      validate: async (_record, proposal) => {
        seen.push(...proposal.files.map((file) => file.path));
        throw new Error('Rejected by the validator');
      },
    })).rejects.toThrow('Rejected by the validator');

    expect(seen).toEqual([EXISTING, 'scripts/collect.py']);
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(EXISTING_SOURCE);
    await expect(readFile(join(projectRoot, 'scripts/collect.py'), 'utf8')).rejects.toThrow();
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('proposed');
  });

  it('refuses when a modified file changed since the proposal, and writes nothing', async () => {
    const { projectRoot } = await fixture();
    await writeFile(join(projectRoot, EXISTING), `${EXISTING_SOURCE}\nHand edit.\n`);

    await expect(apply(projectRoot)).rejects.toThrow('changed after this changeset started');
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(`${EXISTING_SOURCE}\nHand edit.\n`);
    await expect(readFile(join(projectRoot, 'scripts/collect.py'), 'utf8')).rejects.toThrow();
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('proposed');
  });

  it('refuses when an added path already exists', async () => {
    const { projectRoot } = await fixture();
    await mkdir(join(projectRoot, 'scripts'), { recursive: true });
    await writeFile(join(projectRoot, 'scripts/collect.py'), 'already here\n');

    await expect(apply(projectRoot)).rejects.toThrow('already exists');
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(EXISTING_SOURCE);
    expect(await readFile(join(projectRoot, 'scripts/collect.py'), 'utf8')).toBe('already here\n');
  });

  it('refuses a modify whose target is a symlink', async () => {
    const { projectRoot } = await fixture([modifyFile('agents/linked.agentuse', EXISTING_SOURCE, REVISED_SOURCE)]);
    await symlink(join(projectRoot, EXISTING), join(projectRoot, 'agents/linked.agentuse'));

    await expect(apply(projectRoot)).rejects.toThrow('must be a regular file, not a symlink');
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(EXISTING_SOURCE);
  });

  it('refuses a path that escapes the served scope', async () => {
    const { projectRoot } = await fixture([addFile('outside/note.txt', 'nope\n')]);
    const outside = await mkdtemp(join(tmpdir(), 'changeset-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, join(projectRoot, 'outside'));

    await expect(applyChangeset({
      projectRoot,
      scopeRoot: join(projectRoot, 'agents'),
      sessionId: SESSION_ID,
      validate: noopValidate,
    })).rejects.toThrow('outside the served project scope');
  });

  it('refuses to apply a changeset that is not proposed', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);
    await expect(apply(projectRoot)).rejects.toThrow('not ready to apply');
  });
});

describe('reconcile on read', () => {
  async function stall(projectRoot: string, status: 'applying' | 'restoring'): Promise<void> {
    const path = changesetRecordPath(projectRoot, SESSION_ID);
    const stored = JSON.parse(await readFile(path, 'utf8')) as ChangesetRecord;
    await writeFile(path, `${JSON.stringify({ ...stored, status }, null, 2)}\n`);
  }

  it('settles an interrupted apply as applied when every file landed', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);
    await stall(projectRoot, 'applying');

    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('applied');
  });

  it('settles an interrupted apply back to proposed when nothing landed', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);
    await writeFile(join(projectRoot, EXISTING), EXISTING_SOURCE);
    await rm(join(projectRoot, 'scripts/collect.py'));
    await stall(projectRoot, 'applying');

    const reconciled = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(reconciled?.status).toBe('proposed');
    expect(reconciled?.applied).toBeUndefined();
  });

  it('errors when an interrupted apply left the project half-written', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);
    await writeFile(join(projectRoot, EXISTING), EXISTING_SOURCE);
    await stall(projectRoot, 'applying');

    const reconciled = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(reconciled?.status).toBe('error');
    expect(reconciled?.error?.code).toBe('CHANGESET_APPLY_STATE_DIVERGED');
  });

  it('errors when an interrupted restore left the project half-written', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);
    await writeFile(join(projectRoot, EXISTING), EXISTING_SOURCE);
    await stall(projectRoot, 'restoring');

    const reconciled = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(reconciled?.status).toBe('error');
    expect(reconciled?.error?.code).toBe('CHANGESET_RESTORE_STATE_DIVERGED');
  });
});

describe('restoreChangeset', () => {
  const restore = (projectRoot: string) => restoreChangeset({
    projectRoot,
    scopeRoot: projectRoot,
    sessionId: SESSION_ID,
  });

  it('puts the previous content back and deletes what apply created', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);

    const result = await restore(projectRoot);
    expect(result.record.status).toBe('restored');
    expect(result.skipped).toEqual([]);
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(EXISTING_SOURCE);
    await expect(readFile(join(projectRoot, 'scripts/collect.py'), 'utf8')).rejects.toThrow();
  });

  it('skips a file hand-edited since apply and names it, restoring the rest', async () => {
    const { projectRoot } = await fixture();
    await apply(projectRoot);
    await writeFile(join(projectRoot, EXISTING), `${REVISED_SOURCE}\nOperator note.\n`);

    const result = await restore(projectRoot);
    expect(result.record.status).toBe('restored');
    expect(result.skipped).toEqual([
      { path: EXISTING, reason: 'The file was edited after this changeset was applied' },
    ]);
    expect(await readFile(join(projectRoot, EXISTING), 'utf8')).toBe(`${REVISED_SOURCE}\nOperator note.\n`);
    await expect(readFile(join(projectRoot, 'scripts/collect.py'), 'utf8')).rejects.toThrow();
  });

  it('refuses to restore a changeset that was never applied', async () => {
    const { projectRoot } = await fixture();
    await expect(restore(projectRoot)).rejects.toThrow('no applied files to restore');
  });
});
