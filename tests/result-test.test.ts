import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { createSessionAndMessage } from '../src/runner/session-helper';

let mode = 'generated';
let requests: Array<{ tools: unknown; options: any }> = [];
mock.module('../src/runner/execution', () => ({
  executeAgentCore: async function* (_agent: unknown, tools: unknown, options: any) {
    requests.push({ tools, options });
    const prompt = JSON.parse(options.userMessage);
    let text: string;
    if (prompt.records) {
      if (mode === 'selector-error') throw new Error('Selector unavailable');
      text = JSON.stringify({ decisions: prompt.records.map((r: any) => ({ partId: r.partId,
        classification: 'source-input', reason: 'External evidence', excerpts: [mode === 'invalid-evidence' ? 'invented' : r.content] })), limitations: [] });
    } else if (prompt.candidate) {
      if (mode === 'judge-error') throw new Error('Judge unavailable');
      text = JSON.stringify({ pass: mode !== 'failed', understanding: 'Must be grounded', critique: mode === 'failed' ? 'Missing detail' : '' });
    } else {
      if (mode === 'provider-error') throw new Error('Provider unavailable');
      text = mode === 'malformed' ? 'not json' : JSON.stringify({ status: mode === 'incomplete' ? 'incomplete' : 'generated', output: 'NEW RESULT' });
    }
    yield { type: 'text', text };
    yield { type: 'finish', finishReason: mode === 'truncated' ? 'length' : 'stop', usage: { inputTokens: 10, outputTokens: 10 } };
  },
}));
let runResultTest: typeof import('../src/testing/result').runResultTest;
beforeAll(async () => { ({ runResultTest } = await import('../src/testing/result')); });

async function fixture(options: { sourceTask?: string; userPrompt?: string } = { userPrompt: 'ORIGINAL TASK' }) {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-result-'));
  const oldXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, 'state');
  await initStorage(root);
  const manager = new SessionManager();
  const path = join(root, 'reply.agentuse');
  await writeFile(path, 'CURRENT INSTRUCTIONS');
  await writeFile(join(root, 'brief.md'), 'CURRENT BRIEF');
  const judgePath = join(root, 'judge.agentuse');
  await writeFile(judgePath, '---\nmodel: demo:test\n---\nRequire source grounding.');
  const agent = { name: 'reply', instructions: 'CURRENT INSTRUCTIONS', config: { model: 'demo:test', skills: { auto: false }, tools: { filesystem: [{ path: './brief.md', permissions: ['read'] }] } } } as any;
  const context = { projectRoot: root, stateRoot: root, cwd: root };
  const source = await createSessionAndMessage({ sessionManager: manager, agent, agentFilePath: path,
    systemMessages: ['OLD SYSTEM'], task: options.sourceTask ?? 'OLD INSTRUCTIONS',
    ...(options.userPrompt && { userPrompt: options.userPrompt }), projectContext: context, version: 'test', mock: false });
  await manager.writeToolsSnapshot(source.sessionID, 'reply', { tools: [{ name: 'tools__bash', inputSchema: { type: 'object' } }] });
  await manager.addPart(source.sessionID, 'reply', source.messageID, { type: 'tool', tool: 'tools__bash', callID: 'read', state: { status: 'completed', input: { command: 'read source' }, output: 'REAL EVIDENCE', time: { start: 1, end: 2 } } } as any);
  await manager.addPart(source.sessionID, 'reply', source.messageID, { type: 'tool', tool: 'await_human', callID: 'gate', state: { status: 'completed', input: { draft: 'OLD DRAFT' }, output: { comment: 'OLD FEEDBACK' }, time: { start: 3, end: 4 } } } as any);
  await manager.updateSession(source.sessionID, 'reply', { status: 'completed' });
  const sourceFile = join(await manager.getSessionDirectory(source.sessionID, 'reply'), 'session.json');
  const before = await readFile(sourceFile, 'utf8');
  requests = []; mode = 'generated';
  return { root, manager, agent, path, context, source, sourceFile, before, judgePath,
    run: (judge = false) => runResultTest({ agent, agentFilePath: path, sourceSessionId: source.sessionID,
      sessionManager: manager, projectContext: context, timeoutSeconds: 10, ...(judge && { judgePath }) }),
    cleanup: async () => { if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg; await rm(root, { recursive: true, force: true }); } };
}
describe('result tests', () => {
  it('uses current instructions and references, freezes evidence, withholds baseline, and isolates the session', async () => {
    const f = await fixture();
    try {
      const first = await f.run();
      expect(first.status).toBe('generated'); expect(first.success).toBe(true);
      expect(first.judgment).toBeUndefined(); expect(first.evidenceReused).toBe(false);
      expect(requests).toHaveLength(2);
      for (const r of requests) { expect(r.tools).toEqual({}); expect(JSON.stringify(r.options)).not.toContain('OLD DRAFT'); expect(JSON.stringify(r.options)).not.toContain('OLD FEEDBACK'); }
      expect(requests[1]!.options.userMessage).toContain('CURRENT BRIEF');
      expect(requests[1]!.options.userMessage).toContain('ORIGINAL TASK');
      expect(requests[1]!.options.userMessage).toContain('REAL EVIDENCE');
      expect(first.original.proposal).toEqual({ draft: 'OLD DRAFT' });
      await writeFile(join(f.root, 'brief.md'), 'REVISED BRIEF');
      f.agent.instructions = 'REVISED INSTRUCTIONS';
      const second = await f.run();
      expect(second.evidenceReused).toBe(true); expect(second.evidenceSha256).toBe(first.evidenceSha256);
      expect(requests).toHaveLength(3);
      expect(requests[2]!.options.userMessage).toContain('REVISED INSTRUCTIONS');
      expect(requests[2]!.options.userMessage).toContain('REVISED BRIEF');
      const session = await f.manager.findSession(second.sessionId);
      expect(session?.session.mock).toBe(true);
      expect(session?.session.config.resultSourceSessionId).toBe(f.source.sessionID);
      expect(session?.session.status).toBe('completed');
      const { prepareAgentExecution } = await import('../src/runner/preparation');
      await expect(prepareAgentExecution({ agent: f.agent, agentFilePath: f.path, sessionManager: f.manager,
        projectContext: f.context, existingSessionId: second.sessionId })).rejects.toThrow('cannot be resumed as live');
      expect(await readFile(f.sourceFile, 'utf8')).toBe(f.before);
      expect(JSON.parse(await readFile(second.reportPath, 'utf8')).status).toBe('generated');
    } finally { await f.cleanup(); }
  });
  it('gives the selector the source task when the run had no additional prompt', async () => {
    const f = await fixture({ sourceTask: 'SOURCE TASK WITHOUT EXTRA PROMPT' });
    try {
      const result = await f.run();
      expect(result.status).toBe('generated');
      expect(requests).toHaveLength(2);
      const selectorPrompt = JSON.parse(requests[0]!.options.userMessage);
      expect(selectorPrompt.sourceTask).toBe('SOURCE TASK WITHOUT EXTRA PROMPT');
      expect(selectorPrompt.originalUserPrompt).toBeUndefined();
      const writerPrompt = JSON.parse(requests[1]!.options.userMessage);
      expect(writerPrompt.currentInstructions).toContain('CURRENT INSTRUCTIONS');
      expect(writerPrompt.originalTask).toBe('');
      expect(requests[1]!.options.userMessage).not.toContain('SOURCE TASK WITHOUT EXTRA PROMPT');
    } finally { await f.cleanup(); }
  });
  for (const state of ['passed', 'failed', 'incomplete', 'provider-error', 'selector-error', 'invalid-evidence', 'malformed', 'truncated', 'judge-error']) {
    it(`reports ${state} without claiming unearned success`, async () => {
      const f = await fixture(); mode = state;
      try {
        const r = await f.run(true);
        const expected = ['passed', 'failed', 'incomplete'].includes(state) ? state : 'error';
        expect(r.status).toBe(expected); expect(r.success).toBe(state === 'passed');
        expect((await f.manager.findSession(r.sessionId))?.session.status).not.toBe('running');
        for (const request of requests) expect(request.tools).toEqual({});
        if (state === 'incomplete') expect(requests).toHaveLength(2);
      } finally { await f.cleanup(); }
    });
  }
  it('rejects stale or corrupted saved evidence rather than silently reselecting', async () => {
    const f = await fixture();
    try {
      const first = await f.run();
      const saved = JSON.parse(await readFile(first.evidencePath, 'utf8')); saved.sourceHash = 'stale';
      await writeFile(first.evidencePath, JSON.stringify(saved));
      const next = await f.run(); expect(next.status).toBe('error'); expect(next.error).toContain('no longer matches'); expect(requests).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
  it('concurrent first runs publish and reuse one evidence selection', async () => {
    const f = await fixture();
    try {
      const [a, b] = await Promise.all([f.run(), f.run()]);
      expect(a.status).toBe('generated'); expect(b.status).toBe('generated');
      expect(a.evidenceSha256).toBe(b.evidenceSha256);
      expect([a.evidenceReused, b.evidenceReused].sort()).toEqual([false, true]);
    } finally { await f.cleanup(); }
  });
  it('cancels before model calls', async () => {
    const f = await fixture();
    try {
      await expect(runResultTest({ agent: f.agent, agentFilePath: f.path, sourceSessionId: f.source.sessionID, sessionManager: f.manager,
        projectContext: f.context, timeoutSeconds: 10, abortSignal: AbortSignal.abort(new Error('Cancelled')) })).rejects.toThrow('Cancelled');
      expect(requests).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
});
