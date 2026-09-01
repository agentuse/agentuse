import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentContent } from '../src/parser';
import {
  agentRevisionSubmissionContract,
  applyAgentRevision,
  buildAgentRevisionSessionAgent,
  createAgentRevisionRecord,
  createSubmitAgentRevisionTool,
  discardAgentRevision,
  readAgentRevisionRecord,
  restoreAgentRevision,
  sourceHash,
} from '../src/agents/revision';

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-revision-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-revision-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;
  const targetAgentPath = join(projectRoot, 'support-triage.agentuse');
  const currentSource = [
    '---',
    'name: Support triage',
    'model: openai:gpt-5.6-luna',
    'description: Prioritize support tickets',
    'schedule: 0 9 * * 1',
    'tools:',
    '  filesystem:',
    '    - path: ${root}',
    '      permissions: [read]',
    '---',
    '',
    'Classify active orders and prioritize urgent tickets.',
    '',
  ].join('\n');
  await writeFile(targetAgentPath, currentSource);
  const revisionSessionId = '01K4ABCDEFGHJKMNPQRSTVWXYZ';
  const originSessionId = '01K3ABCDEFGHJKMNPQRSTVWXYZ';
  await createAgentRevisionRecord({
    revisionSessionId,
    originSessionId,
    projectId: 'support',
    projectRoot,
    targetAgentPath,
    targetAgentRunPath: 'support-triage.agentuse',
    targetAgentName: 'Support triage',
    mode: 'fix',
    instruction: 'Exclude refunded orders.',
    authoringModel: 'openai:gpt-5.6-luna',
    expectedSourceHash: sourceHash(currentSource),
  });
  const contract = agentRevisionSubmissionContract({
    internal: true,
    reviser: 'agent',
    revisionSessionId,
    originSessionId,
    projectId: 'support',
    projectRoot,
    targetAgentPath,
    expectedSourceHash: sourceHash(currentSource),
    availableModels: ['openai:gpt-5.6-luna'],
    availableSkills: [],
  })!;
  return { projectRoot, targetAgentPath, currentSource, revisionSessionId, originSessionId, contract };
}

describe('internal agent revision', () => {
  it('builds a resumable AgentUse agent with optional clarification and a private contract', async () => {
    const f = await fixture();
    const source = buildAgentRevisionSessionAgent({
      revisionSessionId: f.revisionSessionId,
      originSessionId: f.originSessionId,
      projectId: 'support',
      projectRoot: f.projectRoot,
      targetAgentPath: f.targetAgentPath,
      targetAgentName: 'Support triage',
      mode: 'fix',
      instruction: 'Exclude refunded orders.',
      model: 'openai:gpt-5.6-luna',
      expectedSourceHash: sourceHash(f.currentSource),
      currentSource: f.currentSource,
      originTranscript: 'The agent stopped when it encountered refunded orders.',
      safeViewRoot: f.projectRoot,
      creatorSkill: '# Creator\nWrite the smallest useful agent.',
      availableModels: ['openai:gpt-5.6-luna'],
      availableSkills: [],
    });
    const parsed = parseAgentContent(source, 'revision');
    expect(parsed.name).toBe('Fix Support triage');
    expect(parsed.config.tools?.await_human).toBe(true);
    expect(parsed.config.approval).toBeUndefined();
    expect(parsed.config.metadata?.reviser).toBe('agent');
    expect(source).toContain('submit_agent_revision');
    expect(source).toContain('The agent stopped when it encountered refunded orders.');
  });

  it('validates a proposal, applies it atomically, and restores the prior source', async () => {
    const f = await fixture();
    const submission: { outcome?: 'revision-proposed' | 'no-agent-change' } = {};
    const tool = createSubmitAgentRevisionTool(submission, f.contract);
    const proposedSource = f.currentSource.replace(
      'Classify active orders and prioritize urgent tickets.',
      'Exclude refunded and cancelled orders, then classify active orders and prioritize urgent tickets.',
    );
    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Terminal order statuses were unspecified.',
      summary: 'Handle terminal orders explicitly.',
      source: proposedSource,
    })).resolves.toContain('ready for operator review');
    expect(submission.outcome).toBe('revision-proposed');
    expect((await readAgentRevisionRecord(f.projectRoot, f.revisionSessionId))?.status).toBe('proposed');
    expect(await readFile(f.targetAgentPath, 'utf8')).toBe(f.currentSource);

    const applied = await applyAgentRevision({
      projectRoot: f.projectRoot,
      scopeRoot: f.projectRoot,
      revisionSessionId: f.revisionSessionId,
      availableModels: ['openai:gpt-5.6-luna'],
      availableSkills: [],
    });
    expect(applied.status).toBe('applied');
    expect(await readFile(f.targetAgentPath, 'utf8')).toContain('Exclude refunded and cancelled orders');

    const restored = await restoreAgentRevision({
      projectRoot: f.projectRoot,
      scopeRoot: f.projectRoot,
      revisionSessionId: f.revisionSessionId,
    });
    expect(restored.status).toBe('restored');
    expect(await readFile(f.targetAgentPath, 'utf8')).toBe(f.currentSource);
  });

  it('returns a structured no-change diagnosis without touching source', async () => {
    const f = await fixture();
    const tool = createSubmitAgentRevisionTool({}, f.contract);
    await expect((tool.execute as any)({
      outcome: 'no-agent-change',
      diagnosis: 'The provider rejected an expired credential before the agent could run.',
      recommendedAction: 'Reconnect the provider and retry the existing agent.',
    })).resolves.toContain('no-change diagnosis');
    const record = await readAgentRevisionRecord(f.projectRoot, f.revisionSessionId);
    expect(record?.status).toBe('no-change');
    expect(record?.recommendedAction).toContain('Reconnect');
    expect(await readFile(f.targetAgentPath, 'utf8')).toBe(f.currentSource);
    await expect(discardAgentRevision(f.projectRoot, f.revisionSessionId)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('surfaces capability changes and can apply a newly loaded available skill', async () => {
    const f = await fixture();
    f.contract.availableSkills = ['refund-policy'];
    const tool = createSubmitAgentRevisionTool({}, f.contract, () => ['refund-policy']);
    const proposedSource = f.currentSource.replace(
      'schedule: 0 9 * * 1',
      'schedule: 0 9 * * 1\nskills:\n  auto: false\n  refund-policy:',
    );
    await (tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'The workflow needs the installed refund policy instructions.',
      summary: 'Load the refund policy skill.',
      source: proposedSource,
    });
    const proposal = await readAgentRevisionRecord(f.projectRoot, f.revisionSessionId);
    expect(proposal?.capabilityChanges).toContain('Skill access changed');

    await expect(applyAgentRevision({
      projectRoot: f.projectRoot,
      scopeRoot: f.projectRoot,
      revisionSessionId: f.revisionSessionId,
      availableModels: ['openai:gpt-5.6-luna'],
      availableSkills: ['refund-policy'],
    })).resolves.toMatchObject({ status: 'applied' });
  });

  it('rejects stale proposals instead of overwriting a concurrent edit', async () => {
    const f = await fixture();
    await writeFile(f.targetAgentPath, `${f.currentSource}\nHuman edit.\n`);
    const tool = createSubmitAgentRevisionTool({}, f.contract);
    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'A revision is needed.',
      summary: 'Revise behavior.',
      source: f.currentSource,
    })).rejects.toThrow('changed after this revision session started');
  });

  it('rejects a submission whose private contract does not match the durable request', async () => {
    const f = await fixture();
    const tool = createSubmitAgentRevisionTool({}, { ...f.contract, originSessionId: '01K2ABCDEFGHJKMNPQRSTVWXYZ' });
    await expect((tool.execute as any)({
      outcome: 'no-agent-change',
      diagnosis: 'No change needed.',
      recommendedAction: 'Retry.',
    })).rejects.toThrow('private revision contract does not match');
  });
});
