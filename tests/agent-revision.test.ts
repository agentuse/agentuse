import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentContent } from '../src/parser';
import { resolveSafeVariables } from '../src/tools/path-validator';
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

async function fixture(options: { explicitName?: boolean; broadGrant?: boolean; gateBroadGrant?: boolean } = {}) {
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
    ...(options.explicitName === false ? [] : ['name: Support triage']),
    'model: openai:gpt-5.6-luna',
    'description: Prioritize support tickets',
    'schedule: 0 9 * * 1',
    'tools:',
    ...(options.broadGrant ? [
      '  bash:',
      '    commands: ["gh *"]',
      ...(options.gateBroadGrant ? ['    gated: ["gh *"]'] : []),
    ] : []),
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
    expect(parsed.name).toBe('Revise Support triage');
    expect(parsed.config.tools?.await_human).toBe(true);
    expect(parsed.config.approval).toBeUndefined();
    expect(parsed.config.metadata?.reviser).toBe('agent');
    expect(source).toContain('submit_agent_revision');
    expect(source).toContain('The agent stopped when it encountered refunded orders.');
    expect(source).toContain('treat that as the primary incident unless the operator explicitly asks about an earlier failure');
    expect(source).toContain('the authoritative scope boundary');
    expect(source).toContain('removing a `schedule` field does not authorize changing “daily” to “on-demand.”');
    expect(source).toContain('derive the smallest ordered set of exact replacements against the current source');
    expect(source).toContain('Leave all unrelated source unmentioned so it remains byte-for-byte unchanged');
    expect(source).toContain('only the ordered exact edits');
    expect(source).toContain('Classification changes the diagnosis, not the authorized edit scope.');
    const preparedInstructions = resolveSafeVariables(parsed.instructions, {
      projectRoot: f.projectRoot,
      agentDir: join(f.projectRoot, 'agents'),
      tmpDir: '/tmp',
    });
    const embeddedSource = preparedInstructions.match(/<current_agent_source>\n([\s\S]*?)\n<\/current_agent_source>/)?.[1];
    expect(embeddedSource).toContain('    - path: ${root}');
    expect(embeddedSource).not.toContain(`    - path: ${f.projectRoot}`);
  });

  it('validates a proposal, applies it atomically, and restores the prior source', async () => {
    const f = await fixture();
    const submission: { outcome?: 'revision-proposed' | 'no-agent-change' } = {};
    const tool = createSubmitAgentRevisionTool(submission, f.contract);
    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Terminal order statuses were unspecified.',
      summary: 'Handle terminal orders explicitly.',
      edits: [{
        oldText: 'Classify active orders and prioritize urgent tickets.',
        newText: 'Exclude refunded and cancelled orders, then classify active orders and prioritize urgent tickets.',
      }],
    })).resolves.toContain('ready for operator review');
    expect(submission.outcome).toBe('revision-proposed');
    const proposal = await readAgentRevisionRecord(f.projectRoot, f.revisionSessionId);
    expect(proposal?.status).toBe('proposed');
    expect(proposal?.proposedSource).toContain('    - path: ${root}');
    expect(proposal?.proposedSource).toBe(f.currentSource.replace(
      'Classify active orders and prioritize urgent tickets.',
      'Exclude refunded and cancelled orders, then classify active orders and prioritize urgent tickets.',
    ));
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

  it('preserves an omitted frontmatter name while removing a schedule', async () => {
    const f = await fixture({ explicitName: false });
    const tool = createSubmitAgentRevisionTool({}, f.contract);
    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'The operator disabled recurring runs.',
      summary: 'Remove the schedule.',
      edits: [{ oldText: 'schedule: 0 9 * * 1\n', newText: '' }],
    })).resolves.toContain('ready for operator review');

    const proposal = await readAgentRevisionRecord(f.projectRoot, f.revisionSessionId);
    expect(proposal?.proposedSource).not.toContain('name:');
    expect(proposal?.capabilityChanges).toEqual(['Schedule changed']);
  });

  it('rejects adding a synthetic name when the current source omits one', async () => {
    const f = await fixture({ explicitName: false });
    const tool = createSubmitAgentRevisionTool({}, f.contract);
    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'The operator disabled recurring runs.',
      summary: 'Remove the schedule.',
      edits: [{ oldText: 'model: openai:gpt-5.6-luna', newText: 'name: current-agent\nmodel: openai:gpt-5.6-luna' }],
    })).rejects.toThrow('must not add an explicit agent name');
  });

  it('rejects ambiguous or no-op edits instead of guessing which source fragment to replace', async () => {
    const f = await fixture();
    const tool = createSubmitAgentRevisionTool({}, f.contract);

    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Tighten the wording.',
      summary: 'Tighten wording.',
      edits: [{ oldText: '---', newText: '---\nmetadata:\n  reviewed: true' }],
    })).rejects.toThrow('ambiguous because it occurs more than once');

    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Tighten the wording.',
      summary: 'Tighten wording.',
      edits: [{ oldText: 'Prioritize support tickets', newText: 'Prioritize support tickets' }],
    })).rejects.toThrow('does not change the source');

    await expect((tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Tighten the wording.',
      summary: 'Tighten wording.',
      edits: [
        { oldText: 'Prioritize support tickets', newText: 'Prioritize active support tickets' },
        { oldText: 'Prioritize active support tickets', newText: 'Prioritize support tickets' },
      ],
    })).rejects.toThrow('combined revision edits do not change the source');
  });

  it('grandfathers unchanged structural grants but rejects newly added broad grants', async () => {
    const f = await fixture({ broadGrant: true });
    const existingTool = createSubmitAgentRevisionTool({}, f.contract);
    await expect((existingTool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Terminal order statuses were unspecified.',
      summary: 'Handle terminal orders explicitly.',
      edits: [{ oldText: 'Classify active orders', newText: 'Exclude refunded orders, then classify active orders' }],
    })).resolves.toContain('ready for operator review');

    const fresh = await fixture();
    const freshTool = createSubmitAgentRevisionTool({}, fresh.contract);
    await expect((freshTool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Add repository access.',
      summary: 'Add repository access.',
      edits: [{ oldText: 'tools:\n', newText: 'tools:\n  bash:\n    commands: ["gh *"]\n' }],
    })).rejects.toThrow('introduced or ungated a structurally unsafe command grant: gh *');

    const gated = await fixture({ broadGrant: true, gateBroadGrant: true });
    const gatedTool = createSubmitAgentRevisionTool({}, gated.contract);
    await expect((gatedTool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'Remove the approval boundary.',
      summary: 'Remove the approval boundary.',
      edits: [{ oldText: '    gated: ["gh *"]\n', newText: '' }],
    })).rejects.toThrow('introduced or ungated a structurally unsafe command grant: gh *');
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
    await (tool.execute as any)({
      outcome: 'revision-proposed',
      diagnosis: 'The workflow needs the installed refund policy instructions.',
      summary: 'Load the refund policy skill.',
      edits: [{
        oldText: 'schedule: 0 9 * * 1',
        newText: 'schedule: 0 9 * * 1\nskills:\n  auto: false\n  refund-policy:',
      }],
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
      edits: [{ oldText: 'Prioritize support tickets', newText: 'Prioritize active support tickets' }],
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
