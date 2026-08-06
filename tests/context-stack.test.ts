import { describe, expect, it } from 'bun:test';
import { buildSessionContextPayload } from '../src/cli/serve/context-stack';
import type { Message, Part, SessionInfo, ToolsSnapshot } from '../src/session/types';

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
  it('names each system message by its opening, with identity folded away', () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
    const core = 'You are an autonomous AI agent outputting to CLI/terminal. When given a task:';
    const payload = buildSessionContextPayload({
      session,
      message: message({
        system: [
          identity,
          core,
          'You are a team manager agent. Your job is to coordinate work.',
          '## Sandbox Environment\n\nYou are running with a Docker sandbox.',
          'Something the runtime does not emit today.',
        ],
      }),
      tools: null,
    });

    const system = payload.layers.filter((l) => l.kind === 'system');
    expect(system.map((l) => l.label)).toEqual([
      'AgentUse system prompt',
      'Manager instructions',
      'Sandbox environment',
      'System message 4',
    ]);
    // Identity gets no row of its own, but its weight is not lost.
    expect(system[0]!.chars).toBe(core.length + identity.length);
  });

  it('does not ship system prompt bodies, only their weight', () => {
    const payload = buildSessionContextPayload({
      session,
      message: message({ system: ['You are an autonomous AI agent outputting to CLI/terminal.'] }),
      tools: null,
    });

    const system = payload.layers.find((l) => l.kind === 'system');
    expect(system?.text).toBeUndefined();
    expect(system?.estTokens).toBeGreaterThan(0);
  });

  it('still accounts for an identity line that has nothing to fold into', () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
    const payload = buildSessionContextPayload({
      session,
      message: message({ system: [identity] }),
      tools: null,
    });

    expect(payload.layers.filter((l) => l.kind === 'system')).toHaveLength(1);
    expect(payload.layers[0]!.chars).toBe(identity.length);
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
    expect(payload.fileReads).toEqual([]);
    expect(payload.totals).toEqual({ chars: 0, estTokens: 0, withFileReadsEstTokens: 0 });
    expect(payload.toolCalls).toEqual([]);
    expect(payload.measured).toBeUndefined();
    expect(payload.agent.filePath).toBe('/repo/agents/reporter.agentuse');
  });
});

function readPart(tool: string, input: unknown, output: string, extra: { metadata?: unknown; start?: number } = {}) {
  return {
    id: `prt_${Math.random().toString(36).slice(2)}`,
    messageID: 'msg_1',
    sessionID: session.id,
    type: 'tool',
    callID: 'call_1',
    tool,
    state: {
      status: 'completed',
      input,
      output: { output },
      time: { start: extra.start ?? 1, end: 2 },
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    },
  } as unknown as Part;
}

describe('mid-run file reads', () => {
  it('collects files pulled in by each read tool, heaviest first', () => {
    const parts = [
      readPart('tools__filesystem_read', { file_path: '/repo/docs/spec.md' }, 'x'.repeat(4000)),
      readPart('tools__skill_read', { skill: 'fastmail', path: 'reference/fm.md' }, 'y'.repeat(400)),
      readPart('tools__skill_load', { name: 'slack-formatting' }, 'z'.repeat(800)),
      // Not a read tool: its output is not a file entering the context.
      readPart('tools__bash', { command: 'ls' }, 'w'.repeat(9000)),
    ];

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });

    expect(payload.fileReads.map((f) => [f.path, f.chars])).toEqual([
      ['/repo/docs/spec.md', 4000],
      ['slack-formatting/SKILL.md', 800],
      ['fastmail/reference/fm.md', 400],
    ]);
    expect(payload.fileReads[0]!.estTokens).toBe(1000);
  });

  it('normalises traversal segments so one file does not split into several rows', () => {
    const parts = [
      readPart('tools__filesystem_read', { file_path: '/repo/agents/../../repo/data.json' }, 'a'.repeat(100)),
      readPart('tools__filesystem_read', { file_path: '/repo/data.json' }, 'a'.repeat(100)),
      readPart('tools__filesystem_read', { file_path: './docs/./notes.md' }, 'b'.repeat(40)),
    ];

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });

    expect(payload.fileReads.map((f) => f.path)).toEqual(['/repo/data.json', './docs/notes.md']);
    expect(payload.fileReads[0]!.reads).toBe(2);
  });

  it('merges repeat reads of one file and charges each read', () => {
    const parts = [
      readPart('tools__filesystem_read', { file_path: '/repo/notes.md' }, 'a'.repeat(1000), { start: 10 }),
      readPart('tools__filesystem_read', { file_path: '/repo/notes.md' }, 'a'.repeat(1000), { start: 20 }),
      readPart('tools__filesystem_read', { file_path: '/repo/notes.md' }, 'a'.repeat(1000), { start: 30 }),
    ];

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });

    expect(payload.fileReads).toHaveLength(1);
    expect(payload.fileReads[0]).toMatchObject({ reads: 3, chars: 3000, estTokens: 750, firstReadAt: 10 });
  });

  it('ships the text the model received, one entry per read', () => {
    const parts = [
      readPart('tools__filesystem_read', { file_path: '/repo/notes.md' }, 'first slice'),
      readPart('tools__filesystem_read', { file_path: '/repo/notes.md' }, 'second slice'),
    ];

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });
    const file = payload.fileReads[0]!;

    expect(file.reads).toBe(2);
    expect(file.content?.map((c) => c.text)).toEqual(['first slice', 'second slice']);
    expect(file.content?.every((c) => !c.truncated)).toBe(true);
  });

  it('caps a long preview without distorting the weight it reports', () => {
    const big = 'x'.repeat(50_000);
    const payload = buildSessionContextPayload({
      session,
      message: message({}),
      tools: null,
      parts: [readPart('tools__filesystem_read', { file_path: '/repo/big.md' }, big)],
    });
    const file = payload.fileReads[0]!;

    // The preview is cut, but the accounting still reflects the real cost.
    expect(file.content?.[0]!.text.length).toBe(20_000);
    expect(file.content?.[0]!.truncated).toBe(true);
    expect(file.content?.[0]!.chars).toBe(50_000);
    expect(file.chars).toBe(50_000);
    expect(file.estTokens).toBe(12_500);
  });

  it('stops shipping text once the payload budget is spent, keeping the heaviest files', () => {
    // 40 files of 20k chars each = 800k, well past the 500k transport budget.
    const parts = Array.from({ length: 40 }, (_, i) =>
      readPart('tools__filesystem_read', { file_path: `/repo/f${i}.md` }, 'y'.repeat(20_000))
    );

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });
    const shipped = payload.fileReads.filter((f) => f.content?.length);

    expect(payload.fileReads).toHaveLength(40);
    expect(shipped.length).toBeLessThan(40);
    const totalText = payload.fileReads.reduce(
      (sum, f) => sum + (f.content ?? []).reduce((s, c) => s + c.text.length, 0),
      0
    );
    expect(totalText).toBeLessThanOrEqual(500_000);
    // Every row still reports its true weight, shipped preview or not.
    expect(payload.fileReads.every((f) => f.chars === 20_000)).toBe(true);
  });

  it('limits how many reads of one file carry text', () => {
    const parts = Array.from({ length: 9 }, () =>
      readPart('tools__filesystem_read', { file_path: '/repo/hot.md' }, 'z'.repeat(100))
    );

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });
    const file = payload.fileReads[0]!;

    expect(file.reads).toBe(9);
    expect(file.content).toHaveLength(5);
    expect(file.chars).toBe(900);
  });

  it('reports the pre-truncation size when the runtime spilled the output', () => {
    const parts = [
      readPart('tools__filesystem_read', { file_path: '/repo/huge.md' }, 'a'.repeat(500), {
        metadata: { fullOutputArtifact: { originalChars: 90_000 } },
      }),
    ];

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });

    expect(payload.fileReads[0]).toMatchObject({ chars: 500, truncatedFrom: 90_000 });
  });

  it('skips failed reads and adds file reads to the combined total', () => {
    const failed = {
      id: 'prt_err', messageID: 'msg_1', sessionID: session.id, type: 'tool', callID: 'c', tool: 'tools__filesystem_read',
      state: { status: 'error', input: { file_path: '/repo/missing.md' }, error: 'ENOENT', time: { start: 1, end: 2 } },
    } as unknown as Part;

    const payload = buildSessionContextPayload({
      session,
      message: message({ task: 'b'.repeat(400) }),
      tools: null,
      parts: [failed, readPart('tools__filesystem_read', { file_path: '/repo/ok.md' }, 'c'.repeat(800))],
    });

    expect(payload.fileReads.map((f) => f.path)).toEqual(['/repo/ok.md']);
    expect(payload.totals.estTokens).toBe(100);
    expect(payload.totals.withFileReadsEstTokens).toBe(300);
  });
});

describe('tool call tallies', () => {
  it('counts every tool part, not just the reads, and ranks by call count', () => {
    const parts = [
      readPart('tools__bash', { command: 'ls' }, 'a'),
      readPart('tools__bash', { command: 'pwd' }, 'b'),
      readPart('tools__bash', { command: 'date' }, 'c'),
      readPart('tools__filesystem_read', { file_path: '/repo/x.md' }, 'd'),
      readPart('mcp__slack__post', {}, 'e'),
    ];

    const payload = buildSessionContextPayload({ session, message: message({}), tools: null, parts });

    expect(payload.toolCalls).toEqual([
      { tool: 'tools__bash', count: 3, failed: 0 },
      { tool: 'mcp__slack__post', count: 1, failed: 0 },
      { tool: 'tools__filesystem_read', count: 1, failed: 0 },
    ]);
  });

  it('counts failures separately', () => {
    const errored = {
      id: 'p', messageID: 'msg_1', sessionID: session.id, type: 'tool', callID: 'c', tool: 'tools__bash',
      state: { status: 'error', input: {}, error: 'boom', time: { start: 1, end: 2 } },
    } as unknown as Part;

    const payload = buildSessionContextPayload({
      session, message: message({}), tools: null,
      parts: [readPart('tools__bash', { command: 'ok' }, 'x'), errored],
    });

    expect(payload.toolCalls).toEqual([{ tool: 'tools__bash', count: 2, failed: 1 }]);
  });
});
