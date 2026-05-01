import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { bindToolsToSnapshot, createToolsSnapshot } from '../src/runner/tool-snapshot';

describe('tools snapshot', () => {
  it('captures tool names and binds snapshot schemas to current implementations', () => {
    const current = {
      approve: {
        description: 'current description',
        inputSchema: z.object({
          prompt: z.string(),
          count: z.number().optional()
        }),
        execute: async () => 'ok'
      }
    } as any;

    const snapshot = createToolsSnapshot(current);
    expect(snapshot.tools[0]).toMatchObject({
      name: 'approve',
      description: 'current description'
    });
    expect(snapshot.tools[0].inputSchema).toMatchObject({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        count: { type: 'number' }
      },
      required: ['prompt']
    });

    const next = {
      approve: {
        description: 'edited implementation',
        inputSchema: z.object({ prompt: z.string(), extra: z.string() }),
        execute: async () => 'edited'
      },
      new_tool: {
        description: 'not visible to resumed run',
        inputSchema: z.object({}),
        execute: async () => 'new'
      }
    } as any;

    const bound = bindToolsToSnapshot(next, snapshot) as any;
    expect(Object.keys(bound)).toEqual(['approve']);
    expect(bound.approve.description).toBe('current description');
    expect(bound.approve.inputSchema).toEqual(snapshot.tools[0].inputSchema);
    expect(bound.approve.execute).toBe(next.approve.execute);
  });

  it('fails when a snapshotted tool is unavailable', () => {
    expect(() => bindToolsToSnapshot({} as any, {
      tools: [{ name: 'missing_tool' }]
    })).toThrow('TOOL_UNAVAILABLE: missing_tool');
  });
});
