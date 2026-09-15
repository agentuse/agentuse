import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Tool } from 'ai';
import {
  changesetBasePath,
  changesetEditRoot,
  type ChangesetRecord,
} from '../src/agents/changeset-types';
import { contentHash, createChangesetRecord, readChangesetRecord } from '../src/agents/changeset';
import {
  changesetSubmissionContract,
  createSubmitChangesTool,
  SUBMIT_CHANGES_TOOL,
  type ChangesetSubmission,
  type ChangesetSubmissionContract,
} from '../src/onboarding/submit-changes';

const MODEL = 'opencode-go:glm-5.1';
const SESSION_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';
const AVAILABLE_MODELS = [MODEL];

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

function agentSource(options: { name: string; description?: string; extra?: string; body?: string }): string {
  return `---
name: ${options.name}
model: ${MODEL}
description: ${options.description ?? 'Collect and summarize the daily inputs'}${options.extra ? `\n${options.extra}` : ''}
---

## Task

${options.body ?? 'Collect the inputs described in the run prompt and summarize them.'}
`;
}

const manager = agentSource({
  name: 'Collector Manager',
  description: 'Collect the daily inputs and file the result',
  extra: `tools:
  bash:
    commands:
      - python3 \${agentDir}/collect.py`,
});

const script = 'import json\n\n\ndef main() -> None:\n    print(json.dumps({"ok": True}))\n';

async function project(): Promise<{ projectRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'submit-changes-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'submit-changes-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  return { projectRoot };
}

async function writeUnder(root: string, relPath: string, content: string): Promise<void> {
  const target = join(root, ...relPath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

/** Stage the model's writes the way the filesystem overlay would. */
async function stage(projectRoot: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    await writeUnder(changesetEditRoot(projectRoot, SESSION_ID), relPath, content);
  }
}

async function stageBases(projectRoot: string, bases: Record<string, string>): Promise<void> {
  const target = changesetBasePath(projectRoot, SESSION_ID);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(bases, null, 2)}\n`, 'utf8');
}

function contract(projectRoot: string, overrides: Partial<ChangesetSubmissionContract> = {}): ChangesetSubmissionContract {
  return {
    sessionId: SESSION_ID,
    projectId: 'demo',
    projectRoot,
    scopeRoot: projectRoot,
    mode: 'create',
    availableModels: AVAILABLE_MODELS,
    availableSkills: [],
    ...overrides,
  };
}

async function startRecord(projectRoot: string, overrides: Partial<ChangesetRecord> = {}): Promise<void> {
  await createChangesetRecord({
    sessionId: SESSION_ID,
    projectId: 'demo',
    projectRoot,
    scopeRoot: projectRoot,
    mode: 'create',
    instruction: 'Build a collector.',
    authoringModel: MODEL,
    ...overrides,
  });
}

type SubmitInput = {
  outcome: 'proposed' | 'no-change';
  summary: string;
  diagnosis?: string;
  entry?: string;
  recommendedAction?: string;
};

function run(tool: Tool, input: SubmitInput): Promise<string> {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== 'function') throw new Error('submit_changes is not executable');
  return (execute as (args: SubmitInput, options?: unknown) => Promise<string>)(input);
}

function tool(
  projectRoot: string,
  submission: ChangesetSubmission = {},
  overrides: Partial<ChangesetSubmissionContract> = {},
): Tool {
  return createSubmitChangesTool(submission, contract(projectRoot, overrides));
}

describe('changesetSubmissionContract', () => {
  it('reads a host-authored create contract', () => {
    const parsed = changesetSubmissionContract({
      internal: true,
      changeset: 'agent',
      sessionId: SESSION_ID,
      projectId: 'demo',
      projectRoot: '/tmp/demo',
      scopeRoot: '/tmp/demo',
      mode: 'create',
      availableModels: [MODEL],
      availableSkills: ['writer'],
    });
    expect(parsed?.mode).toBe('create');
    expect(parsed?.targetPath).toBeUndefined();
    expect(parsed?.availableSkills).toEqual(['writer']);
  });

  it('reads a revise contract with a target path', () => {
    const parsed = changesetSubmissionContract({
      internal: true,
      changeset: 'agent',
      sessionId: SESSION_ID,
      projectId: 'demo',
      projectRoot: '/tmp/demo',
      scopeRoot: '/tmp/demo',
      mode: 'revise',
      targetPath: 'agents/manager.agentuse',
      availableModels: [MODEL],
      availableSkills: [],
    });
    expect(parsed?.targetPath).toBe('agents/manager.agentuse');
  });

  it('rejects metadata that is not a host changeset contract', () => {
    const base = {
      internal: true,
      changeset: 'agent',
      sessionId: SESSION_ID,
      projectId: 'demo',
      projectRoot: '/tmp/demo',
      scopeRoot: '/tmp/demo',
      mode: 'create',
      availableModels: [MODEL],
      availableSkills: [],
    };
    expect(changesetSubmissionContract(undefined)).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, internal: false })).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, changeset: 'other' })).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, mode: 'delete' })).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, scopeRoot: '' })).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, availableModels: [1] })).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, availableSkills: 'writer' })).toBeUndefined();
    expect(changesetSubmissionContract({ ...base, targetPath: 42 })).toBeUndefined();
  });

  it('names the tool submit_changes', () => {
    expect(SUBMIT_CHANGES_TOOL).toBe('submit_changes');
  });
});

describe('submit_changes proposed', () => {
  it('turns the staged edit folder into a proposal', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await stage(projectRoot, {
      'agents/manager.agentuse': manager,
      'agents/collect.py': script,
    });

    const submission: ChangesetSubmission = {};
    const accepted = await run(tool(projectRoot, submission), {
      outcome: 'proposed',
      summary: 'Add a collector agent and its script.',
      diagnosis: 'The project had no collector.',
      entry: 'agents/manager.agentuse',
    });

    expect(accepted).toContain('Accepted:');
    expect(submission.outcome).toBe('proposed');

    const record = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(record?.status).toBe('proposed');
    const proposal = record?.proposals[0];
    expect(proposal?.entry).toBe('agents/manager.agentuse');
    expect(proposal?.reply).toBe('Add a collector agent and its script.');
    expect(proposal?.diagnosis).toBe('The project had no collector.');
    expect(proposal?.files.map((file) => file.path)).toEqual(['agents/collect.py', 'agents/manager.agentuse']);
    expect(proposal?.files.every((file) => file.op === 'add' && file.baseHash === null)).toBe(true);
    expect(proposal?.files.every((file) => (file.patch ?? '').includes('+++'))).toBe(true);
    const agentFile = proposal?.files.find((file) => file.kind === 'agent');
    expect(agentFile?.capabilityChanges).toContain(`Runtime model added: ${MODEL}`);
    const supportFile = proposal?.files.find((file) => file.kind === 'support');
    expect(supportFile?.flags ?? []).not.toContain('not referenced by any agent in this changeset');
  });

  it('accepts an edit whose real file still matches the recorded base', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    const current = agentSource({ name: 'Collector Manager', body: 'Collect the inputs.' });
    await writeUnder(projectRoot, 'agents/manager.agentuse', current);
    await stageBases(projectRoot, { 'agents/manager.agentuse': contentHash(current) });
    const edited = agentSource({ name: 'Collector Manager', body: 'Collect the inputs and file the summary.' });
    await stage(projectRoot, { 'agents/manager.agentuse': edited });

    await run(tool(projectRoot), {
      outcome: 'proposed',
      summary: 'Sharpen the collector instructions.',
      entry: 'agents/manager.agentuse',
    });

    const record = await readChangesetRecord(projectRoot, SESSION_ID);
    const file = record?.proposals[0]?.files[0];
    expect(file?.op).toBe('modify');
    expect(file?.baseHash).toBe(contentHash(current));
    expect(file?.content).toBe(edited);
    expect(file?.patch).toContain('file the summary');
  });

  it('refuses an edit whose real file changed after the session started', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    const original = agentSource({ name: 'Collector Manager', body: 'Collect the inputs.' });
    await stageBases(projectRoot, { 'agents/manager.agentuse': contentHash(original) });
    await writeUnder(projectRoot, 'agents/manager.agentuse', agentSource({ name: 'Collector Manager', body: 'Edited by hand.' }));
    await stage(projectRoot, { 'agents/manager.agentuse': agentSource({ name: 'Collector Manager', body: 'Collect and file.' }) });

    await expect(run(tool(projectRoot), {
      outcome: 'proposed',
      summary: 'Sharpen the collector instructions.',
      entry: 'agents/manager.agentuse',
    })).rejects.toThrow('changed after this session started');

    const record = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(record?.status).toBe('running');
  });

  it('refuses a submission with an empty edit folder', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await expect(run(tool(projectRoot), {
      outcome: 'proposed',
      summary: 'Nothing staged.',
      entry: 'agents/manager.agentuse',
    })).rejects.toThrow('No files were written.');
  });

  it('requires an entry', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await stage(projectRoot, { 'agents/manager.agentuse': manager });
    await expect(run(tool(projectRoot), {
      outcome: 'proposed',
      summary: 'Add a collector.',
    })).rejects.toThrow('requires an entry');
  });

  it('relays a validator error as a correctable rejection', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await stage(projectRoot, {
      'agents/manager.agentuse': agentSource({
        name: 'Collector Manager',
        extra: `tools:
  bash:
    commands:
      - python3 \${agentDir}/missing.py`,
      }),
    });

    await expect(run(tool(projectRoot), {
      outcome: 'proposed',
      summary: 'Add a collector.',
      entry: 'agents/manager.agentuse',
    })).rejects.toThrow(/^Changes rejected: .*missing\.py.*call submit_changes again\.$/s);

    const record = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(record?.status).toBe('running');
    expect(record?.proposals).toEqual([]);
  });

  it('rejects a submission whose contract does not match the record', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await stage(projectRoot, { 'agents/manager.agentuse': manager });
    await expect(run(tool(projectRoot, {}, { projectId: 'other' }), {
      outcome: 'proposed',
      summary: 'Add a collector.',
      entry: 'agents/manager.agentuse',
    })).rejects.toThrow('does not match its durable host record');
  });
});

describe('submit_changes no-change', () => {
  it('records a diagnosis with no files', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    const submission: ChangesetSubmission = {};
    const accepted = await run(tool(projectRoot, submission), {
      outcome: 'no-change',
      summary: 'The agent is already correct.',
      diagnosis: 'The failure came from an expired credential, not the agent.',
      recommendedAction: 'Refresh the API token in the project environment.',
      cause: 'setup',
    });

    expect(accepted).toContain('no-change diagnosis');
    expect(submission.outcome).toBe('no-change');
    const record = await readChangesetRecord(projectRoot, SESSION_ID);
    expect(record?.status).toBe('no-change');
    expect(record?.proposals[0]?.files).toEqual([]);
    expect(record?.proposals[0]?.entry).toBeUndefined();
    expect(record?.proposals[0]?.reply).toBe('Refresh the API token in the project environment.');
    expect(record?.proposals[0]?.cause).toBe('setup');
  });

  it('requires a recommendedAction', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await expect(run(tool(projectRoot), {
      outcome: 'no-change',
      summary: 'Nothing to change.',
    })).rejects.toThrow('requires a recommendedAction');
  });

  it('requires a cause, so an upstream verdict is never lost in prose', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await expect(run(tool(projectRoot), {
      outcome: 'no-change',
      summary: 'Nothing to change.',
      recommendedAction: 'Report it.',
    })).rejects.toThrow('requires a cause');
  });
});

describe('submit_changes concurrency', () => {
  it('refuses a second submission while one is in flight', async () => {
    const { projectRoot } = await project();
    await startRecord(projectRoot);
    await stage(projectRoot, {
      'agents/manager.agentuse': manager,
      'agents/collect.py': script,
    });
    const submit = tool(projectRoot);
    const input: SubmitInput = {
      outcome: 'proposed',
      summary: 'Add a collector agent and its script.',
      entry: 'agents/manager.agentuse',
    };
    const results = await Promise.allSettled([run(submit, input), run(submit, input)]);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('already being reviewed');
  });
});
