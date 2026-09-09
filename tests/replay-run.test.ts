import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { createSessionAndMessage } from '../src/runner/session-helper';

let coreOptions: any;
let mode: 'proposal' | 'missing' | 'final' | 'incomplete' | 'error' = 'proposal';
mock.module('../src/runner/execution', () => ({
  executeAgentCore: async function* (_agent: unknown, tools: any, options: any) {
    coreOptions = options;
    if (mode === 'error') throw new Error('Provider failed');
    const input = { command: mode === 'missing' ? 'unrecorded' : 'read source', intent: 'new narration' };
    const output = await tools.tools__bash.execute(input);
    yield { type: 'tool-call', toolName: 'tools__bash', toolCallId: 'read-1', input };
    yield { type: 'tool-result', toolName: 'tools__bash', toolCallId: 'read-1', toolResultRaw: output, toolResult: JSON.stringify(output) };
    if (!options.replay.stopped() && mode !== 'final') {
      const name = mode === 'incomplete' ? 'report_incomplete' : 'await_human';
      const input = mode === 'incomplete' ? { reason: 'No suitable input' } : { prompt: 'Review?', changes: [{ content: 'publish NEW', displayContent: 'NEW DRAFT' }] };
      const output = await tools[name].execute(input);
      yield { type: 'tool-call', toolName: name, toolCallId: 'finish-1', input };
      yield { type: 'tool-result', toolName: name, toolCallId: 'finish-1', toolResultRaw: output, toolResult: JSON.stringify(output) };
    }
    if (mode === 'final') yield { type: 'text', text: 'NEW FINAL OUTPUT' };
    yield { type: 'finish', finishReason: mode === 'final' ? 'stop' : 'tool-calls', usage: { inputTokens: 10, outputTokens: 5 } };
  },
}));
let runReplay: typeof import('../src/replay/run').runReplay;
beforeAll(async () => { ({ runReplay } = await import('../src/replay/run')); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-replay-run-'));
  const oldXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, 'state');
  await initStorage(root);
  const manager = new SessionManager();
  const path = join(root, 'reply.agentuse');
  await writeFile(path, 'CURRENT INSTRUCTIONS');
  await writeFile(join(root, 'brief.md'), 'CURRENT WRITING BRIEF');
  const agent = { name: 'reply', instructions: 'CURRENT INSTRUCTIONS', config: { model: 'demo:test', skills: { auto: false }, tools: { filesystem: [{ path: './brief.md', permissions: ['read'] }] } } } as any;
  const context = { projectRoot: root, stateRoot: root, cwd: root };
  const source = await createSessionAndMessage({ sessionManager: manager, agent: { ...agent, instructions: 'OLD INSTRUCTIONS' }, agentFilePath: path,
    systemMessages: ['OLD SYSTEM'], task: 'OLD INSTRUCTIONS', userPrompt: 'FIXED USER REQUEST', projectContext: context, version: 'test', mock: false });
  await manager.writeToolsSnapshot(source.sessionID, 'reply', { tools: ['tools__bash', 'await_human', 'report_incomplete'].map(name => ({ name, inputSchema: { type: 'object', additionalProperties: true } })) });
  await manager.addPart(source.sessionID, 'reply', source.messageID, { type: 'tool', tool: 'tools__bash', callID: 'old-read', state: { status: 'completed', input: { command: 'read source' }, output: { source: 'FIXED SOURCE' }, time: { start: 1, end: 2 } } } as any);
  await manager.addPart(source.sessionID, 'reply', source.messageID, { type: 'tool', tool: 'await_human', callID: 'old-gate', state: { status: 'completed', input: { draft: 'OLD DRAFT' }, output: { status: 'rejected', comment: 'OLD HUMAN FEEDBACK' }, time: { start: 3, end: 4 } } } as any);
  await manager.updateSession(source.sessionID, 'reply', { status: 'completed' });
  const sourceFile = join(await manager.getSessionDirectory(source.sessionID, 'reply'), 'session.json');
  const before = await readFile(sourceFile, 'utf8');
  return { root, manager, agent, path, context, source, sourceFile, before, cleanup: async () => {
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg;
    await rm(root, { recursive: true, force: true });
  } };
}

describe('replay run persistence and result', () => {
  for (const runMode of ['proposal', 'missing', 'final', 'incomplete', 'error'] as const) {
    it(`records ${runMode} as an isolated test session without changing the source`, async () => {
      mode = runMode;
      const f = await fixture();
      try {
        const result = await runReplay({ agent: f.agent, agentFilePath: f.path, sourceSessionId: f.source.sessionID, sessionManager: f.manager, projectContext: f.context, timeoutSeconds: 10 });
        expect(result.status).toBe({ proposal: 'proposal', missing: 'mismatch', final: 'completed', incomplete: 'incomplete', error: 'error' }[runMode]);
        expect(result.success).toBe(runMode === 'proposal' || runMode === 'final');
        const current = await f.manager.findSession(result.sessionId);
        expect(current?.session.mock).toBe(true);
        expect(current?.session.config.replaySourceSessionId).toBe(f.source.sessionID);
        expect(current?.session.status).toBe(result.success ? 'completed' : 'error');
        expect(await readFile(f.sourceFile, 'utf8')).toBe(f.before);
        expect(JSON.parse(await readFile(result.reportPath, 'utf8')).sourceSessionId).toBe(f.source.sessionID);
        expect(coreOptions.userMessage).toContain('CURRENT INSTRUCTIONS');
        expect(coreOptions.userMessage).toContain('FIXED USER REQUEST');
        expect(coreOptions.userMessage).not.toContain('OLD INSTRUCTIONS');
        expect(JSON.stringify(coreOptions.systemMessages)).not.toContain('OLD DRAFT');
        expect(JSON.stringify(coreOptions.systemMessages)).not.toContain('OLD HUMAN FEEDBACK');
        if (runMode === 'proposal') expect((result.current.proposal as any).changes[0].displayContent).toBe('NEW DRAFT');
      } finally { await f.cleanup(); }
    });
  }
});
