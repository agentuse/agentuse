import { afterEach, describe, expect, it } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REASONING_LEVELS } from '../src/model-compatibility';
import { buildChangesetCreatorSessionAgent } from '../src/onboarding/session-agents';
import { buildChangesetRevisionSessionAgent } from '../src/agents/revision';
import { parseAgentContent } from '../src/parser';
import {
  appendChangesetProposal,
  contentHash,
  readChangesetRecord,
} from '../src/agents/changeset';
import { restoreChangeset } from '../src/agents/changeset-apply';
import {
  changesetBasePath,
  changesetDir,
  changesetEditRoot,
  type ChangesetFile,
} from '../src/agents/changeset-types';
import { __testing } from '../src/cli/serve';

/**
 * The change set route family. The handlers live inside the serve closure, so
 * what is exercised here is everything the routes delegate to: the durable half
 * of a start, the list projection, the review actions, and the settle that
 * closes a session which never called `submit_changes`. Nothing here talks to a
 * model or a worker.
 */

const {
  activeChangesetForTarget,
  applyProjectChangeset,
  ChangesetTargetError,
  resolveChangesetTargetPath,
  changesetAcceptsChangeRequest,
  changesetListSummary,
  changesetSessionPurpose,
  ChangesetActiveError,
  CHANGESET_ID_PATTERN,
  discardProjectChangeset,
  prepareChangesetStart,
  settleChangesetSession,
} = __testing;

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

const SESSION_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';
const OTHER_SESSION_ID = '01K5ABCDEFGHJKMNPQRSTVWXYZ';
const TARGET = 'agents/triage.agentuse';
const TARGET_SOURCE = '---\nname: Triage\nmodel: openai:gpt-5.6-luna\n---\n\nTriage tickets.\n';
const REVISED_SOURCE = '---\nname: Triage\nmodel: openai:gpt-5.6-luna\n---\n\nTriage tickets, excluding refunds.\n';
const SCRIPT = 'scripts/collect.py';
const SCRIPT_SOURCE = 'print("collect")\n';

async function project() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'changeset-routes-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'changeset-routes-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  await mkdir(join(projectRoot, 'agents'), { recursive: true });
  await writeFile(join(projectRoot, TARGET), TARGET_SOURCE);
  return projectRoot;
}

function start(projectRoot: string, overrides: Partial<Parameters<typeof prepareChangesetStart>[0]> = {}) {
  return prepareChangesetStart({
    sessionId: SESSION_ID,
    projectId: 'demo',
    projectRoot,
    scopeRoot: projectRoot,
    mode: 'create',
    instruction: 'Collect the overnight orders.',
    authoringModel: 'openai:gpt-5.6-luna',
    ...overrides,
  });
}

function modifyFile(path: string, base: string, content: string): ChangesetFile {
  return { path, kind: 'agent', op: 'modify', baseHash: contentHash(base), content, hash: contentHash(content) };
}

function addFile(path: string, content: string): ChangesetFile {
  return { path, kind: 'support', op: 'add', baseHash: null, content, hash: contentHash(content) };
}

/** A started change set carrying one modify and one add, ready to apply. */
async function proposed(projectRoot: string, sessionId = SESSION_ID) {
  await start(projectRoot, {
    sessionId,
    mode: 'revise',
    target: { path: TARGET, name: 'Triage' },
  });
  await appendChangesetProposal(projectRoot, sessionId, {
    reply: 'Excluded refunds and added the collector.',
    entry: TARGET,
    files: [
      modifyFile(TARGET, TARGET_SOURCE, REVISED_SOURCE),
      addFile(SCRIPT, SCRIPT_SOURCE),
    ],
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const validation = { availableModels: ['openai:gpt-5.6-luna'], availableSkills: [] };

describe('starting a change set', () => {
  it('writes a running record, the edit root, and an empty base manifest', async () => {
    const projectRoot = await project();
    const record = await start(projectRoot);

    expect(record.status).toBe('running');
    expect(record.mode).toBe('create');
    expect(record.proposals).toEqual([]);
    expect((await stat(changesetEditRoot(projectRoot, SESSION_ID))).isDirectory()).toBe(true);
    expect(await readFile(changesetBasePath(projectRoot, SESSION_ID), 'utf8')).toBe('{}\n');
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('running');
  });

  it('refuses a second revise while one is still open on the same target', async () => {
    const projectRoot = await project();
    await start(projectRoot, { mode: 'revise', target: { path: TARGET, name: 'Triage' } });

    const second = start(projectRoot, {
      sessionId: OTHER_SESSION_ID,
      mode: 'revise',
      target: { path: TARGET, name: 'Triage' },
    });
    await expect(second).rejects.toThrow('already has a change set waiting');
    await expect(second).rejects.toBeInstanceOf(ChangesetActiveError);
    // The refused start leaves nothing behind for the operator to clean up.
    expect(await exists(join(changesetDir(projectRoot), OTHER_SESSION_ID))).toBe(false);
  });

  it('allows a revise on a different target, and one on a settled change set', async () => {
    const projectRoot = await project();
    await writeFile(join(projectRoot, 'agents/other.agentuse'), TARGET_SOURCE);
    await start(projectRoot, { mode: 'revise', target: { path: TARGET, name: 'Triage' } });

    await expect(start(projectRoot, {
      sessionId: OTHER_SESSION_ID,
      mode: 'revise',
      target: { path: 'agents/other.agentuse', name: 'Other' },
    })).resolves.toMatchObject({ status: 'running' });

    const records = await Promise.all([
      readChangesetRecord(projectRoot, SESSION_ID),
      readChangesetRecord(projectRoot, OTHER_SESSION_ID),
    ]);
    expect(activeChangesetForTarget(records.flatMap((r) => r ? [r] : []), TARGET)?.sessionId).toBe(SESSION_ID);
  });
});

describe('resolving a revise target', () => {
  it('accepts the relative run path the agent page sends', async () => {
    const projectRoot = await project();
    expect(await resolveChangesetTargetPath(projectRoot, TARGET)).toBe(TARGET);
    expect(await resolveChangesetTargetPath(projectRoot, `./${TARGET}`)).toBe(TARGET);
  });

  it('accepts the absolute file path the session page sends', async () => {
    const projectRoot = await project();
    expect(await resolveChangesetTargetPath(projectRoot, join(projectRoot, TARGET))).toBe(TARGET);
  });

  it('normalizes an absolute path reached through a symlinked scope root', async () => {
    const projectRoot = await project();
    // macOS hands out /var/folders temp dirs behind a symlink, which is exactly
    // the shape a session page's agentFilePath arrives in.
    const real = await realpath(projectRoot);
    expect(await resolveChangesetTargetPath(projectRoot, join(real, TARGET))).toBe(TARGET);
  });

  it('refuses a path outside the scope, a missing file, and a symlink', async () => {
    const projectRoot = await project();
    const outside = await mkdtemp(join(tmpdir(), 'changeset-routes-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'evil.agentuse'), TARGET_SOURCE);
    await symlink(join(outside, 'evil.agentuse'), join(projectRoot, 'agents/linked.agentuse'));

    for (const requested of [join(outside, 'evil.agentuse'), '../evil.agentuse']) {
      await expect(resolveChangesetTargetPath(projectRoot, requested))
        .rejects.toBeInstanceOf(ChangesetTargetError);
    }
    await expect(resolveChangesetTargetPath(projectRoot, 'agents/missing.agentuse'))
      .rejects.toThrow('outside the served project scope');
    await expect(resolveChangesetTargetPath(projectRoot, 'agents/linked.agentuse'))
      .rejects.toThrow('must be a regular file');
    await expect(resolveChangesetTargetPath(projectRoot, 'agents'))
      .rejects.toThrow('must be a regular file');
  });
});

describe('authoring effort', () => {
  const editRoot = '/tmp/edit';
  const basePath = '/tmp/base.json';

  it('carries a requested thinking effort into both session agents', () => {
    for (const reasoning of REASONING_LEVELS) {
      const creator = buildChangesetCreatorSessionAgent({
        model: 'openai:gpt-5.6-luna',
        reasoning,
        sessionId: SESSION_ID,
        projectId: 'demo',
        projectRoot: '/tmp/project',
        scopeRoot: '/tmp/project',
        editRoot,
        basePath,
        creatorSkill: 'Creator guidance.',
        objective: 'Collect the overnight orders.',
        availableModels: ['openai:gpt-5.6-luna'],
      });
      expect(creator).toContain(`reasoning: ${reasoning}`);

      const reviser = buildChangesetRevisionSessionAgent({
        sessionId: SESSION_ID,
        projectId: 'demo',
        projectRoot: '/tmp/project',
        scopeRoot: '/tmp/project',
        editRoot,
        basePath,
        targetRunPath: TARGET,
        targetAgentName: 'Triage',
        instruction: 'Exclude refunded orders.',
        model: 'openai:gpt-5.6-luna',
        reasoning,
        currentSource: TARGET_SOURCE,
        creatorSkill: 'Creator guidance.',
        availableModels: ['openai:gpt-5.6-luna'],
        availableSkills: [],
      });
      expect(reviser).toContain(`reasoning: ${reasoning}`);
    }
  });

  it("falls back to each builder's default when none is requested", () => {
    expect(buildChangesetCreatorSessionAgent({
      model: 'openai:gpt-5.6-luna',
      sessionId: SESSION_ID,
      projectId: 'demo',
      projectRoot: '/tmp/project',
      scopeRoot: '/tmp/project',
      editRoot,
      basePath,
      creatorSkill: 'Creator guidance.',
      objective: 'Collect the overnight orders.',
      availableModels: ['openai:gpt-5.6-luna'],
    })).toContain('reasoning: low');
  });
});

describe('reviser session name', () => {
  it('stays a parseable agent name when the target name came from a filename', () => {
    const reviser = buildChangesetRevisionSessionAgent({
      sessionId: SESSION_ID,
      projectId: 'demo',
      projectRoot: '/tmp/project',
      scopeRoot: '/tmp/project',
      editRoot: '/tmp/edit',
      basePath: '/tmp/base.json',
      targetRunPath: TARGET,
      targetAgentName: 'process-fastmail-support.agentuse',
      instruction: 'Exclude refunded orders.',
      model: 'openai:gpt-5.6-luna',
      currentSource: TARGET_SOURCE,
      creatorSkill: 'Creator guidance.',
      availableModels: ['openai:gpt-5.6-luna'],
      availableSkills: [],
    });
    expect(() => parseAgentContent(reviser, 'reviser')).not.toThrow();
  });
});

describe('listing change sets', () => {
  it('strips every proposed file body and patch', async () => {
    const projectRoot = await project();
    await proposed(projectRoot);
    const record = (await readChangesetRecord(projectRoot, SESSION_ID))!;

    const summary = changesetListSummary(record);
    const files = summary.proposals[0]!.files;
    expect(files.map((file) => file.path)).toEqual([TARGET, SCRIPT]);
    for (const file of files) {
      expect(file).not.toHaveProperty('content');
      expect(file).not.toHaveProperty('patch');
      expect(file.hash).toBeTruthy();
    }
    // The record itself is untouched: the projection is a copy.
    expect(record.proposals[0]!.files[0]!.content).toBe(REVISED_SOURCE);
  });
});

describe('applying a change set', () => {
  it('writes every file and removes the staged workspace', async () => {
    const projectRoot = await project();
    await proposed(projectRoot);
    expect(await exists(changesetEditRoot(projectRoot, SESSION_ID))).toBe(true);

    const applied = await applyProjectChangeset({
      projectRoot,
      scopeRoot: projectRoot,
      sessionId: SESSION_ID,
      ...validation,
    });

    expect(applied.status).toBe('applied');
    expect(await readFile(join(projectRoot, TARGET), 'utf8')).toBe(REVISED_SOURCE);
    expect(await readFile(join(projectRoot, SCRIPT), 'utf8')).toBe(SCRIPT_SOURCE);
    expect(await exists(join(changesetDir(projectRoot), SESSION_ID))).toBe(false);
    // The record survives the workspace it was staged in.
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('applied');
  });

  it('re-validates the stored proposal and writes nothing when it no longer passes', async () => {
    const projectRoot = await project();
    await start(projectRoot, { mode: 'revise', target: { path: TARGET, name: 'Triage' } });
    // The proposal switched the runtime model. If that provider is gone by the
    // time the operator presses Apply, the re-validation must catch it.
    const switched = REVISED_SOURCE.replace('openai:gpt-5.6-luna', 'openai:gpt-5.6-nova');
    await appendChangesetProposal(projectRoot, SESSION_ID, {
      reply: 'Moved Triage to the cheaper model.',
      entry: TARGET,
      files: [modifyFile(TARGET, TARGET_SOURCE, switched)],
    });

    await expect(applyProjectChangeset({
      projectRoot,
      scopeRoot: projectRoot,
      sessionId: SESSION_ID,
      availableModels: ['openai:gpt-5.6-luna'],
      availableSkills: [],
    })).rejects.toThrow('unavailable runtime model');

    expect(await readFile(join(projectRoot, TARGET), 'utf8')).toBe(TARGET_SOURCE);
    expect(await exists(changesetEditRoot(projectRoot, SESSION_ID))).toBe(true);
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('proposed');
  });
});

describe('discarding a change set', () => {
  it('marks the record discarded and removes the staged workspace', async () => {
    const projectRoot = await project();
    await proposed(projectRoot);

    const discarded = await discardProjectChangeset(projectRoot, SESSION_ID);

    expect(discarded.status).toBe('discarded');
    expect(await exists(join(changesetDir(projectRoot), SESSION_ID))).toBe(false);
    // Discard never touches the project.
    expect(await readFile(join(projectRoot, TARGET), 'utf8')).toBe(TARGET_SOURCE);
    expect(await exists(join(projectRoot, SCRIPT))).toBe(false);
  });
});

describe('restoring an applied change set', () => {
  it('skips a file hand-edited since Apply and restores the rest', async () => {
    const projectRoot = await project();
    await proposed(projectRoot);
    await applyProjectChangeset({ projectRoot, scopeRoot: projectRoot, sessionId: SESSION_ID, ...validation });
    await writeFile(join(projectRoot, TARGET), `${REVISED_SOURCE}\nHand edit.\n`);

    const result = await restoreChangeset({ projectRoot, scopeRoot: projectRoot, sessionId: SESSION_ID });

    expect(result.skipped).toEqual([
      { path: TARGET, reason: 'The file was edited after this changeset was applied' },
    ]);
    expect(await readFile(join(projectRoot, TARGET), 'utf8')).toBe(`${REVISED_SOURCE}\nHand edit.\n`);
    expect(await exists(join(projectRoot, SCRIPT))).toBe(false);
    expect(result.record.status).toBe('restored');
  });
});

describe('requesting changes', () => {
  it('accepts a settled change set and refuses one whose session is still running', async () => {
    expect(changesetAcceptsChangeRequest('proposed')).toBe(true);
    expect(changesetAcceptsChangeRequest('no-change')).toBe(true);
    expect(changesetAcceptsChangeRequest('error')).toBe(true);
    expect(changesetAcceptsChangeRequest('running')).toBe(false);
    expect(changesetAcceptsChangeRequest('applied')).toBe(false);
    expect(changesetAcceptsChangeRequest('discarded')).toBe(false);
  });
});

describe('settling an authoring session', () => {
  const completed = {
    success: true as const,
    result: { finishReason: 'stop' },
  } as unknown as Parameters<typeof settleChangesetSession>[2];
  const suspended = {
    success: true as const,
    result: { finishReason: 'suspended' },
  } as unknown as Parameters<typeof settleChangesetSession>[2];

  it('marks a run that never called submit_changes CHANGESET_NOT_SUBMITTED', async () => {
    const projectRoot = await project();
    await start(projectRoot);

    const failure = await settleChangesetSession(projectRoot, SESSION_ID, completed);

    expect(failure?.code).toBe('CHANGESET_NOT_SUBMITTED');
    const record = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(record?.status).toBe('error');
    expect(record?.error?.code).toBe('CHANGESET_NOT_SUBMITTED');
  });

  it('leaves a submitted proposal and a suspended turn alone', async () => {
    const projectRoot = await project();
    await proposed(projectRoot);
    expect(await settleChangesetSession(projectRoot, SESSION_ID, completed)).toBeUndefined();
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.status).toBe('proposed');

    const other = await project();
    await start(other);
    expect(await settleChangesetSession(other, SESSION_ID, suspended)).toBeUndefined();
    expect((await readChangesetRecord(other, SESSION_ID))?.status).toBe('running');
  });

  it("carries a failed execution's error onto the record", async () => {
    const projectRoot = await project();
    await start(projectRoot);
    const failed = {
      success: false as const,
      error: { code: 'WORKER_DIED', message: 'Worker process died unexpectedly' },
    } as unknown as Parameters<typeof settleChangesetSession>[2];

    const failure = await settleChangesetSession(projectRoot, SESSION_ID, failed);

    expect(failure).toEqual({ code: 'WORKER_DIED', message: 'Worker process died unexpectedly' });
    expect((await readChangesetRecord(projectRoot, SESSION_ID))?.error?.code).toBe('WORKER_DIED');
  });
});

describe('session identity', () => {
  it('links a change set session to its review page', () => {
    expect(changesetSessionPurpose('demo', {
      sessionId: SESSION_ID,
      mode: 'revise',
      target: { path: TARGET, name: 'Triage' },
    })).toEqual({
      kind: 'changeset',
      mode: 'revise',
      targetAgentName: 'Triage',
      href: `/projects/demo/changesets/${SESSION_ID}`,
    });
  });

  it('only accepts a ULID as a change set id', () => {
    expect(CHANGESET_ID_PATTERN.test(SESSION_ID)).toBe(true);
    expect(CHANGESET_ID_PATTERN.test('../../etc/passwd')).toBe(false);
    expect(CHANGESET_ID_PATTERN.test('')).toBe(false);
  });
});
