import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReplayDispatcher, replayCallKey, selectReplayRecording, snapshotReplayReferences, loadReplayRecording, type ReplayRecording } from '../src/replay/recording';

const schema = { type: 'object', additionalProperties: true };
const toolPart = (id: string, tool: string, input: unknown, output: unknown): any => ({
  id, type: 'tool', callID: id, state: { status: 'completed', input, output, time: { start: 1, end: 2 } }, tool,
});
function recording(calls: any[] = []): ReplayRecording {
  return { sessionId: 'source', model: 'demo:old', createdAt: 1000, cwd: '/project', calls,
    original: { text: 'OLD DRAFT MUST NOT BE IN MODEL INPUT', proposal: { draft: 'OLD' } },
    tools: { tools: ['tools__bash', 'await_human', 'report_complete', 'report_incomplete', 'subagent__research', 'tools__filesystem_read']
      .map(name => ({ name, inputSchema: schema })) } };
}

describe('recorded-input replay', () => {
  it('uses only calls before the first gate, not revisions or continuation', () => {
    const first = toolPart('1', 'tools__bash', { command: 'read source' }, 'source');
    const gate = toolPart('2', 'await_human', { draft: 'FIRST' }, { status: 'rejected' });
    const selected = selectReplayRecording({ sessionId: 'source', model: 'demo:old', createdAt: 1, cwd: '/project',
      tools: recording().tools, message: { user: { prompt: { task: 'OLD INSTRUCTIONS', user: 'Original user request' } } } as any,
      parts: [first, { type: 'text', text: 'old output' } as any, gate,
        toolPart('3', 'tools__bash', { command: 'read after gate' }, 'must not be replayed'),
        toolPart('4', 'await_human', { draft: 'REVISED' }, {})] });
    expect(selected.calls).toEqual([first]);
    expect(selected.userPrompt).toBe('Original user request');
    expect(selected.original.proposal).toEqual({ draft: 'FIRST' });
    expect(JSON.stringify(selected)).not.toContain('OLD INSTRUCTIONS');
  });

  it('does not incorporate a later follow-up into an initially ungated run', () => {
    const selected = selectReplayRecording({ sessionId: 'source', model: 'demo:old', createdAt: 1, cwd: '/project',
      tools: recording().tools, message: { user: { prompt: { task: 'old' } } } as any,
      parts: [{ type: 'text', text: 'first output' } as any, { type: 'text', role: 'user', text: 'follow-up' } as any,
        toolPart('2', 'await_human', { draft: 'later' }, {})] });
    expect(selected.original).toEqual({ text: 'first output' });
  });

  it('normalizes key order, intent, and read path spelling but not substantive inputs', () => {
    expect(replayCallKey('tools__bash', { command: 'read A', intent: 'new' }, '/project'))
      .toBe(replayCallKey('tools__bash', { intent: 'old', command: 'read A' }, '/project'));
    expect(replayCallKey('tools__filesystem_read', { file_path: './brief.md' }, '/project'))
      .toBe(replayCallKey('tools__filesystem_read', { file_path: '/project/brief.md' }, '/project'));
    expect(replayCallKey('tools__bash', { command: 'read B' }, '/project'))
      .not.toBe(replayCallKey('tools__bash', { command: 'read A' }, '/project'));
  });

  it('consumes repeated recordings in order and clones structured output', () => {
    const source = recording([toolPart('1', 'tools__bash', { command: 'read' }, { content: [{ type: 'text', text: 'first' }] }),
      toolPart('2', 'tools__bash', { command: 'read' }, 'second')]);
    const replay = new ReplayDispatcher(source, [], '/project');
    const output = replay.execute('tools__bash', { command: 'read', intent: 'different' }) as any;
    output.content[0].text = 'mutated';
    expect((source.calls[0]!.state as any).output.content[0].text).toBe('first');
    expect(replay.execute('tools__bash', { command: 'read' })).toBe('second');
    replay.execute('tools__bash', { command: 'read' });
    expect(replay.stop?.kind).toBe('missing');
  });

  it('stops when recorded media cannot be reproduced as text/JSON', () => {
    for (const output of [{ _media: [] }, { __mediaCacheRef: 'cached-image' },
      { content: [{ type: 'image', data: 'bytes' }] }]) {
      const replay = new ReplayDispatcher(recording([toolPart('media', 'tools__bash', { command: 'capture' }, output)]), [], '/project');
      expect(replay.execute('tools__bash', { command: 'capture' })).toMatchObject({ error: 'REPLAY_INPUT_MISSING' });
      expect(replay.stop?.kind).toBe('missing');
      expect(replay.trace[0]?.partId).toBe('media');
    }
  });

  it('projects recorded store rows without losing metadata or inventing fields', () => {
    const source = () => recording([toolPart('list', 'store_list', { type: 'draft', limit: 28, fields: ['target', 'absent'] },
      { success: true, count: 1, total: 1, items: [{ id: 'old', title: 'Recorded', data: { target: 'real' }, missingFields: ['absent'] }] })]);
    const replay = new ReplayDispatcher(source(), [], '/project');
    expect(replay.execute('store_list', { type: 'draft', limit: 28, fields: ['id', 'title', 'target', 'absent'] })).toMatchObject({
      items: [{ id: 'old', title: 'Recorded', data: { target: 'real' }, missingFields: ['absent'] }] });
    expect(replay.trace[0]?.source).toBe('store-projection');
    for (const input of [
      { type: 'draft', limit: 28, fields: ['uncaptured'] },
      { type: 'other', limit: 28, fields: ['target'] },
      { type: 'draft', limit: 28, includeData: true },
    ]) {
      const missing = new ReplayDispatcher(source(), [], '/project');
      missing.execute('store_list', input);
      expect(missing.stop?.kind).toBe('missing');
    }
  });

  it('serves smaller pages only within the recorded window', () => {
    const source = () => recording([toolPart('list', 'store_list', { type: 'draft', limit: 3 },
      { success: true, total: 10, count: 3, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })]);
    const replay = new ReplayDispatcher(source(), [], '/project');
    expect(replay.execute('store_list', { type: 'draft', offset: 1, limit: 2, fields: ['id'] })).toMatchObject({ count: 2, total: 10, items: [{ id: 'b' }, { id: 'c' }] });
    const missing = new ReplayDispatcher(source(), [], '/project');
    missing.execute('store_list', { type: 'draft', offset: 2, limit: 2 });
    expect(missing.stop?.kind).toBe('missing');
  });

  it('keeps fresh drafts isolated and supports read, update and delete', () => {
    const replay = new ReplayDispatcher(recording(), [], '/project');
    const created = replay.execute('store_create', { type: 'draft', data: { text: 'NEW' } }) as any;
    expect(created.id).toStartWith('replay-');
    expect(created.item.data).toBeUndefined();
    replay.execute('store_update', { id: created.id, data: { selected: true } });
    expect(replay.execute('store_get', { id: created.id })).toMatchObject({ item: { data: { text: 'NEW', selected: true } } });
    expect(replay.execute('store_get', { id: created.id, fields: ['selected'] })).toMatchObject({ item: { data: { selected: true } } });
    expect(replay.execute('store_delete', { id: created.id })).toMatchObject({ deleted: true });
    replay.execute('store_get', { id: created.id });
    expect(replay.stop?.kind).toBe('missing');
    expect(new ReplayDispatcher(recording(), [], '/project').execute('store_get', { id: created.id })).toMatchObject({ error: 'REPLAY_INPUT_MISSING' });
  });

  it('never returns a stale recorded list after a temporary draft write', () => {
    const replay = new ReplayDispatcher(recording([toolPart('list', 'store_list', { type: 'draft' }, { success: true, items: [] })]), [], '/project');
    replay.execute('store_create', { type: 'draft', data: { text: 'new' } });
    replay.execute('store_list', { type: 'draft' });
    expect(replay.stop?.kind).toBe('missing');
  });

  it('preserves recorded errors without inventing a success', () => {
    const part = toolPart('1', 'tools__bash', { command: 'read' }, null);
    part.state = { status: 'error', input: { command: 'read' }, error: 'recorded failure', time: { start: 1, end: 2 } };
    const replay = new ReplayDispatcher(recording([part]), [], '/project');
    expect(() => replay.execute('tools__bash', { command: 'read' })).toThrow('recorded failure');
    expect(replay.stop).toBeUndefined();
  });

  it('stops on missing input, then refuses all sibling calls', () => {
    const replay = new ReplayDispatcher(recording([toolPart('1', 'tools__bash', { command: 'publish' }, 'old success')]), [], '/project');
    replay.execute('tools__bash', { command: 'new read' });
    const stopped = replay.stop;
    expect(replay.execute('tools__bash', { command: 'publish' })).toEqual({ replay: true, stopped: true });
    expect(replay.execute('await_human', { draft: 'later' })).toEqual({ replay: true, stopped: true });
    expect(replay.stop).toBe(stopped);
    expect(replay.trace.map(t => t.source)).toEqual(['missing', 'stopped', 'stopped']);
  });

  it('captures a fresh proposal without returning the old proposal or approval', async () => {
    const replay = new ReplayDispatcher(recording(), [], '/project');
    const tools = replay.tools();
    const result = await (tools.await_human as any).execute({ draft: 'NEW', changes: [{ content: 'publish NEW' }] });
    expect(result).toEqual({ replay: true, captured: true, approved: false });
    expect(replay.stop).toEqual({ kind: 'proposal', proposal: { draft: 'NEW', changes: [{ content: 'publish NEW' }] } });
    expect(JSON.stringify(tools)).not.toContain('OLD DRAFT');
  });

  it('returns a recorded child-agent result without delegating', () => {
    const replay = new ReplayDispatcher(recording([toolPart('1', 'subagent__research', { prompt: 'Check claim' }, { text: 'Recorded evidence' })]), [], '/project');
    expect(replay.execute('subagent__research', { prompt: 'Check claim' })).toEqual({ text: 'Recorded evidence' });
  });

  it('captures completion and incomplete reports locally', () => {
    for (const [tool, kind] of [['report_complete', 'complete'], ['report_incomplete', 'incomplete']]) {
      const replay = new ReplayDispatcher(recording(), [], '/project');
      replay.execute(tool!, { headline: 'done', reason: 'no source' });
      expect(replay.stop?.kind).toBe(kind);
    }
  });

  it('refreshes only explicit read-only files and snapshots bytes before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-replay-refs-'));
    try {
      await mkdir(join(root, 'data'));
      await writeFile(join(root, 'brief.md'), 'CURRENT BRIEF');
      await writeFile(join(root, 'draft.txt'), 'MUTABLE DRAFT');
      const agent = { config: { tools: { filesystem: [
        { path: './brief.md', permissions: ['read'] },
        { path: './data', permissions: ['read'] },
        { path: './draft.txt', permissions: ['read', 'write'] },
      ] } } } as any;
      const refs = await snapshotReplayReferences(agent, root, join(root, 'a.agentuse'));
      expect(refs.map(r => r.path)).toEqual([join(root, 'brief.md')]);
      await writeFile(join(root, 'brief.md'), 'CHANGED DURING RUN');
      const replay = new ReplayDispatcher(recording([toolPart('1', 'tools__filesystem_read', { file_path: join(root, 'brief.md') }, 'OLD BRIEF')]), refs, root);
      expect(JSON.stringify(replay.execute('tools__filesystem_read', { file_path: './brief.md' }))).toContain('CURRENT BRIEF');
      expect(replay.trace[0]?.source).toBe('current-reference');
      replay.execute('tools__filesystem_read', { file_path: './data/new-source.txt' });
      expect(replay.stop?.kind).toBe('missing');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects mock recordings rather than treating auto-approval as human data', async () => {
    await expect(loadReplayRecording({ findSession: async () => ({ session: { mock: true } }) } as any, 'id')).rejects.toThrow('real source session');
  });
});
