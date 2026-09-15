import { describe, expect, it } from 'bun:test';
import { parseAgentContent } from '../src/parser';
import { buildChangesetCreatorSessionAgent } from '../src/onboarding/session-agents';
import { buildChangesetRevisionSessionAgent } from '../src/agents/revision';

const SESSION_ID = '01J8Z9QZQZQZQZQZQZQZQZQZQZ';
const PROJECT_ROOT = '/tmp/changeset-prompts/project';
const SCOPE_ROOT = '/tmp/changeset-prompts/project';
const EDIT_ROOT = '/tmp/changeset-prompts/project/.agentuse/changeset/edit-folder-marker';
const BASE_PATH = '/tmp/changeset-prompts/project/.agentuse/changeset/base-marker.json';

const EXISTING_AGENTS = [
  { path: 'agents/daily.agentuse', name: 'Daily <Digest>', description: 'Summarize & report' },
];

function creator(): string {
  return buildChangesetCreatorSessionAgent({
    model: 'anthropic:claude-opus-5',
    sessionId: SESSION_ID,
    projectId: 'project-id',
    projectRoot: PROJECT_ROOT,
    scopeRoot: SCOPE_ROOT,
    editRoot: EDIT_ROOT,
    basePath: BASE_PATH,
    creatorSkill: '# Creator skill\n\nWrite a good agent.',
    objective: 'Collect release notes and journal them.',
    availableModels: ['anthropic:claude-sonnet-5', 'anthropic:claude-sonnet-5'],
    availableSkills: [
      { name: 'notes', description: 'Take notes', source: 'project', allowedTools: [], ambiguous: false },
      { name: 'dupe', description: 'Ambiguous', source: 'project', allowedTools: [], ambiguous: true },
    ],
    existingAgents: EXISTING_AGENTS,
  });
}

function reviser(origin?: { originSessionId: string; originTranscript?: string }): string {
  return buildChangesetRevisionSessionAgent({
    ...origin,
    sessionId: SESSION_ID,
    projectId: 'project-id',
    projectRoot: PROJECT_ROOT,
    scopeRoot: SCOPE_ROOT,
    editRoot: EDIT_ROOT,
    basePath: BASE_PATH,
    targetRunPath: 'agents/daily.agentuse',
    targetAgentName: 'Daily Digest',
    instruction: 'Stop posting on weekends.',
    model: 'anthropic:claude-opus-5',
    currentSource: '---\nname: Daily Digest\nmodel: anthropic:claude-sonnet-5\n---\n\nDo the thing.\n',
    creatorSkill: '# Creator skill\n\nWrite a good agent.',
    availableModels: ['anthropic:claude-sonnet-5'],
    availableSkills: [{ name: 'notes', description: 'Take notes', source: 'project', allowedTools: [], ambiguous: false }],
    existingAgents: EXISTING_AGENTS,
  });
}

const CASES: Array<{ label: string; build: () => string; mode: 'create' | 'revise'; targetPath?: string }> = [
  { label: 'creator', build: creator, mode: 'create' },
  { label: 'reviser', build: reviser, mode: 'revise', targetPath: 'agents/daily.agentuse' },
];

describe('changeset session prompts', () => {
  for (const testCase of CASES) {
    describe(testCase.label, () => {
      it('parses as a valid agent with only await_human declared', () => {
        const parsed = parseAgentContent(testCase.build(), `changeset-${testCase.label}`);
        expect(parsed.config.tools?.await_human).toBe(true);
        expect(parsed.config.tools?.filesystem).toBeUndefined();
        expect(parsed.instructions.trim().length).toBeGreaterThan(0);
      });

      it('carries the changeset host contract in metadata', () => {
        const parsed = parseAgentContent(testCase.build(), `changeset-${testCase.label}`);
        const metadata = parsed.config.metadata as Record<string, unknown>;
        expect(metadata.internal).toBe(true);
        expect(metadata.changeset).toBe('agent');
        expect(metadata.sessionId).toBe(SESSION_ID);
        expect(metadata.projectId).toBe('project-id');
        expect(metadata.projectRoot).toBe(PROJECT_ROOT);
        expect(metadata.scopeRoot).toBe(SCOPE_ROOT);
        expect(metadata.mode).toBe(testCase.mode);
        expect(metadata.targetPath).toBe(testCase.targetPath as string);
        expect(metadata.availableModels).toEqual(['anthropic:claude-sonnet-5']);
        expect(metadata.availableSkills).toEqual(['notes']);
        expect(metadata.changesetOverlay).toEqual({
          scopeRoot: SCOPE_ROOT,
          editRoot: EDIT_ROOT,
          basePath: BASE_PATH,
        });
      });

      it('never names the edit folder or the base manifest in the body', () => {
        const parsed = parseAgentContent(testCase.build(), `changeset-${testCase.label}`);
        expect(parsed.instructions).not.toContain(EDIT_ROOT);
        expect(parsed.instructions).not.toContain(BASE_PATH);
        expect(parsed.instructions).not.toContain('edit-folder-marker');
        expect(parsed.instructions).not.toContain('base-marker');
      });

      it('states the submit and ask-for-help mechanics', () => {
        const parsed = parseAgentContent(testCase.build(), `changeset-${testCase.label}`);
        expect(parsed.instructions).toContain('submit_changes');
        expect(parsed.instructions).toContain('await_human');
        expect(parsed.instructions).not.toContain('submit_agent_source');
        expect(parsed.instructions).not.toContain('submit_agent_revision');
      });

      it('renders the existing-agent catalog with xml escaping', () => {
        const parsed = parseAgentContent(testCase.build(), `changeset-${testCase.label}`);
        expect(parsed.instructions).toContain('<existing_project_agents>');
        expect(parsed.instructions).toContain('<path>agents/daily.agentuse</path>');
        expect(parsed.instructions).toContain('<name>Daily &lt;Digest&gt;</name>');
        expect(parsed.instructions).toContain('Summarize &amp; report');
        expect(parsed.instructions).not.toContain('Daily <Digest>');
      });
    });
  }

  it('creator points writes at the project root and its agent layout', () => {
    const parsed = parseAgentContent(creator(), 'changeset-creator');
    expect(parsed.config.maxSteps).toBe(24);
    expect(parsed.instructions).toContain(SCOPE_ROOT);
    expect(parsed.instructions).toContain('agents/');
    expect(parsed.instructions).toContain('outcome proposed');
  });

  it('reviser keeps the diagnose-before-edit contract and names the target', () => {
    const parsed = parseAgentContent(reviser(), 'changeset-reviser');
    expect(parsed.config.maxSteps).toBe(32);
    expect(parsed.instructions).toContain('narrowest literal edit');
    expect(parsed.instructions).toContain('untrusted evidence');
    expect(parsed.instructions).toContain('agents/daily.agentuse');
    expect(parsed.instructions).toContain('outcome no-change');
    expect(parsed.instructions).toContain('cause: agent, project, setup, or agentuse');
    expect(parsed.instructions).toContain('Use agentuse only when the AgentUse runtime itself misbehaved');
    expect(parsed.instructions).toContain('Resolve routine implementation choices yourself');
    expect(parsed.instructions).toContain('top-level options array');
    expect(parsed.instructions).toContain('Tool arguments must be valid JSON objects');
    expect(parsed.instructions).toContain('a revision review presents completed edits');
  });

  it('reviser requests readable review text with paragraphs and accurate change status', () => {
    const parsed = parseAgentContent(reviser(), 'changeset-reviser');
    expect(parsed.instructions).toContain('Lead with the practical outcome in plain language');
    expect(parsed.instructions).toContain('short paragraphs separated by blank lines');
    expect(parsed.instructions).toContain('user-facing replies, diagnosis, and recommendedAction');
    expect(parsed.instructions).toContain('Put essential technical details in a separate paragraph');
    expect(parsed.instructions).toContain('whether edits are prepared, applied, or only recommended');
    expect(parsed.instructions).toContain('account.\n\nI prepared a fix');
  });

  it('reviser prepares supporting script repairs without requiring agent source changes', () => {
    const parsed = parseAgentContent(reviser(), 'changeset-reviser');
    expect(parsed.instructions).toContain('A supporting-script-only fix is a valid revision');
    expect(parsed.instructions).toContain('An unchanged target agent alone is not a reason for no-change');
    expect(parsed.instructions).toContain('the operator explicitly wants explanation only');
    expect(parsed.instructions).toContain('prepare the smallest supported fix for review');
    expect(parsed.instructions).toContain('Never execute the repaired outward action');
    expect(parsed.instructions).not.toContain('If the agent should not change');
  });

  it('reviser inlines the origin run transcript as the evidence to diagnose', () => {
    const parsed = parseAgentContent(
      reviser({ originSessionId: '01ORIGIN', originTranscript: '[error] INCOMPLETE: refresh policy missing' }),
      'changeset-reviser',
    );
    expect(parsed.config.description).toContain('01ORIGIN');
    expect(parsed.instructions).toContain('refresh policy missing');
    expect(parsed.instructions).toContain('Diagnose the latest execution attempt');
    expect(parsed.instructions).not.toContain('This agent has not run yet');
  });

  it('reviser refuses an origin session that comes without its transcript', () => {
    // A silent fallback here told the model "this agent has not run yet"
    // about the failed run the operator was asking about.
    expect(() => reviser({ originSessionId: '01ORIGIN' })).toThrow(/01ORIGIN/);
  });
});
