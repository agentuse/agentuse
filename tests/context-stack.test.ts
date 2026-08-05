import { describe, expect, it } from 'bun:test';
import { buildSessionContextPayload } from '../src/cli/serve/context-stack';
import type { Message, SessionInfo, ToolsSnapshot } from '../src/session/types';

const session = {
  id: '01TESTSESSION',
  model: 'anthropic:claude-opus-5',
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  agent: {
    id: 'agents/reporter',
    name: 'reporter',
    filePath: '/repo/agents/reporter.agentuse',
  },
} as unknown as SessionInfo;

function message(overrides: {
  system?: string[];
  task?: string;
  user?: string;
  tokens?: Message['assistant']['tokens'];
  context?: Message['assistant']['context'];
}): Message {
  return {
    id: 'msg_1',
    sessionID: session.id,
    time: { created: 1_700_000_000_000 },
    user: {
      prompt: {
        task: overrides.task ?? 'Do the thing.',
        ...(overrides.user !== undefined ? { user: overrides.user } : {}),
      },
    },
    assistant: {
      system: overrides.system ?? [],
      modelID: 'claude-opus-5',
      providerID: 'anthropic',
      mode: 'build',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: overrides.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(overrides.context ? { context: overrides.context } : {}),
    },
  } as Message;
}

describe('session context stack', () => {
  it('names each system message by its opening', () => {
    const payload = buildSessionContextPayload({
      session,
      message: message({
        system: [
          "You are Claude Code, Anthropic's official CLI for Claude.",
          'You are an autonomous AI agent outputting to CLI/terminal. When given a task:',
          'You are a team manager agent. Your job is to coordinate work.',
          '## Sandbox Environment\n\nYou are running with a Docker sandbox.',
          'Something the runtime does not emit today.',
        ],
      }),
      tools: null,
    });

    expect(payload.layers.filter((l) => l.kind === 'system').map((l) => l.label)).toEqual([
      'Anthropic identity',
      'AgentUse core instructions',
      'Manager instructions',
      'Sandbox environment',
      'System message 5',
    ]);
  });

  it('splits the resolved instructions into agent body, approval, skills and corrections', () => {
    const task = [
      '# Reporter\n\nSummarise the inbox.',
      '## Approval Gate\n\nApproval is enabled in frontmatter.',
      '## Skills (shared defaults — your agent instructions and any captured corrections override these on conflict)',
      [
        '## Skill: slack-formatting\n\n**Base directory**: /repo/.agentuse/skills/slack-formatting\n\nUse mrkdwn.',
        '## Skill: fastmail\n\n**Base directory**: /repo/.agentuse/skills/fastmail\n\nUse the fm CLI.',
      ].join('\n\n'),
      '## Recent Corrections (override skill defaults on conflict)\n\n- [tone] Be terse.',
    ].join('\n\n');

    const payload = buildSessionContextPayload({ session, message: message({ task }), tools: null });

    expect(payload.layers.map((l) => [l.kind, l.label])).toEqual([
      ['instructions', 'Agent instructions'],
      ['approval', 'Approval gate instructions'],
      ['skills', 'Skill: slack-formatting'],
      ['skills', 'Skill: fastmail'],
      ['learnings', 'Recent corrections'],
    ]);

    const body = payload.layers[0]!;
    expect(body.text).toBe('# Reporter\n\nSummarise the inbox.');
    expect(body.source).toBe('/repo/agents/reporter.agentuse');

    // The skill layers name the SKILL.md each block was read from - the whole
    // point of the page is answering "which file got loaded".
    expect(payload.layers[2]!.source).toBe('/repo/.agentuse/skills/slack-formatting/SKILL.md');
    expect(payload.layers[3]!.source).toBe('/repo/.agentuse/skills/fastmail/SKILL.md');
    expect(payload.layers[3]!.text).toContain('Use the fm CLI.');
  });

  it('attributes an appended block to the runtime, not to a same-named heading in the agent body', () => {
    const task = [
      '# Reporter\n\nMy own notes on the ## Approval Gate heading style.',
      '## Approval Gate\n\nApproval is enabled in frontmatter.',
    ].join('\n\n');

    const payload = buildSessionContextPayload({ session, message: message({ task }), tools: null });
    const approval = payload.layers.find((l) => l.kind === 'approval');

    expect(approval?.text).toBe('## Approval Gate\n\nApproval is enabled in frontmatter.');
    expect(payload.layers[0]!.text).toContain('My own notes');
  });

  it('leaves instructions whole when no runtime block was appended', () => {
    const payload = buildSessionContextPayload({
      session,
      message: message({ task: '# Reporter\n\nJust the body.' }),
      tools: null,
    });

    expect(payload.layers.map((l) => l.kind)).toEqual(['instructions']);
    expect(payload.layers[0]!.text).toBe('# Reporter\n\nJust the body.');
  });

  it('summarises the tool catalog as one layer and itemises it separately', () => {
    const tools: ToolsSnapshot = {
      tools: [
        { name: 'bash', description: 'Run a command', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } } },
        { name: 'read', inputSchema: { type: 'object' } },
      ],
    } as ToolsSnapshot;

    const payload = buildSessionContextPayload({ session, message: message({}), tools });
    const toolLayer = payload.layers.find((l) => l.kind === 'tools');

    expect(toolLayer?.label).toBe('Tool definitions (2)');
    // No text: the weight is itemised in `tools`, so the page has nothing to expand.
    expect(toolLayer?.text).toBeUndefined();
    expect(payload.tools.map((t) => t.name)).toEqual(['bash', 'read']);
    expect(payload.tools[0]!.schema).toContain('"cmd"');
    expect(payload.tools[0]!.chars).toBeGreaterThan(payload.tools[1]!.chars);
  });

  it('carries provider-reported usage through and flags a compacted run', () => {
    const payload = buildSessionContextPayload({
      session,
      message: message({
        tokens: { input: 1000, output: 200, reasoning: 5, cache: { read: 800, write: 100 } },
        context: { activeTokens: 5000, contextLimit: 200_000, usagePercentage: 2.5, compacted: true, compactions: 2, updatedAt: 1 },
      }),
      tools: null,
    });

    expect(payload.measured).toMatchObject({ input: 1000, output: 200, cacheRead: 800, cacheWrite: 100 });
    expect(payload.measured?.context?.compactions).toBe(2);
    expect(payload.compacted).toBe(true);
  });

  it('returns an empty stack for a run that never reached its first model call', () => {
    const payload = buildSessionContextPayload({ session, message: null, tools: null });

    expect(payload.layers).toEqual([]);
    expect(payload.tools).toEqual([]);
    expect(payload.totals).toEqual({ chars: 0, estTokens: 0 });
    expect(payload.measured).toBeUndefined();
    expect(payload.agent.filePath).toBe('/repo/agents/reporter.agentuse');
  });
});
