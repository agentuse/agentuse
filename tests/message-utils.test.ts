import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { stripToolBlocks } from '../src/session/message-utils';

describe('stripToolBlocks', () => {
  it('returns a copy unchanged when the id set is empty', () => {
    const messages = [{ role: 'user', content: 'hi' }] as ModelMessage[];
    const out = stripToolBlocks(messages, new Set());
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages);
  });

  it('removes the gate call + synthetic suspend result while preserving sibling text', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Now the approval gate.' },
        { type: 'tool-call', toolCallId: 'gate', toolName: 'await_human', input: { prompt: 'ok?' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'gate', toolName: 'await_human', output: { type: 'error-text', value: 'Agent execution suspended' } },
      ] },
    ] as any as ModelMessage[];

    const out = stripToolBlocks(messages, new Set(['gate']));

    // The sibling text survives; the gate tool-call is gone.
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Now the approval gate.' }] } as any);
    // No tool-call/tool-result blocks remain, and no synthetic suspend result.
    const toolBlocks = out.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool-call' || b.type === 'tool-result') : []
    );
    expect(toolBlocks).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain('Agent execution suspended');
  });

  it('leaves other tool calls untouched and only strips the targeted id', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'keep', toolName: 'store_get', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'keep', toolName: 'store_get', output: { type: 'json', value: 1 } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'drop', toolName: 'await_human', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'drop', toolName: 'await_human', output: { type: 'error-text', value: 'Agent execution suspended' } }] },
    ] as any as ModelMessage[];

    const out = stripToolBlocks(messages, new Set(['drop']));

    // The kept tool-call/result pair remains; the emptied drop messages are gone.
    expect(out).toHaveLength(2);
    const ids = out.flatMap((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.toolCallId) : []);
    expect(ids).toEqual(['keep', 'keep']);
  });
});
