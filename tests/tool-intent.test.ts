import { describe, expect, it } from 'bun:test';
import { jsonSchema } from 'ai';
import { z } from 'zod';
import {
  INTENT_PARAM,
  extractToolIntent,
  withIntentParam,
  withoutToolIntent,
} from '../src/runner/tool-intent';
import { createToolsSnapshot } from '../src/runner/tool-snapshot';

const zodTool = (execute: (input: unknown, opts?: unknown) => unknown) => ({
  description: 'zod tool',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
  }),
  execute,
}) as any;

describe('withIntentParam', () => {
  it('extends a Zod object schema with intent as the FIRST property', () => {
    const tools = withIntentParam({ tools__bash: zodTool(async () => 'ok') });
    const schema = (tools.tools__bash as any).inputSchema;
    // Serialize through the same converter the session snapshot uses, so the
    // assertion covers what actually reaches the provider on resume too.
    const snapshot = createToolsSnapshot(tools as any);
    const serialized = snapshot.tools[0].inputSchema as any;
    expect(Object.keys(serialized.properties)).toEqual([INTENT_PARAM, 'command', 'timeout']);
    expect(serialized.required).toEqual(['command']);
    expect(serialized.properties[INTENT_PARAM].type).toBe('string');
    expect(serialized.properties[INTENT_PARAM].description).toContain('trying to achieve');
    // The extended schema still validates real args.
    expect(schema.parse({ command: 'ls', intent: 'listing files' })).toEqual({
      command: 'ls',
      intent: 'listing files',
    });
  });

  it('preserves a strict Zod object policy (unknown keys still rejected)', () => {
    const strictTool = {
      inputSchema: z.object({ a: z.string() }).strict(),
      execute: async () => 'ok',
    } as any;
    const tools = withIntentParam({ t: strictTool });
    const schema = (tools.t as any).inputSchema;
    expect(schema.parse({ a: 'x', intent: 'doing x' })).toEqual({ a: 'x', intent: 'doing x' });
    expect(() => schema.parse({ a: 'x', bogus: 1 })).toThrow();
  });

  it('strips intent from args before the real execute runs', async () => {
    let seen: unknown;
    const tools = withIntentParam({
      tools__bash: zodTool(async (input: unknown) => { seen = input; return 'ok'; }),
    });
    await (tools.tools__bash as any).execute({ command: 'ls', intent: 'listing files' }, {});
    expect(seen).toEqual({ command: 'ls' });
  });

  it('passes args through untouched when the model omitted intent', async () => {
    let seen: unknown;
    const tools = withIntentParam({
      tools__bash: zodTool(async (input: unknown) => { seen = input; return 'ok'; }),
    });
    await (tools.tools__bash as any).execute({ command: 'ls' }, {});
    expect(seen).toEqual({ command: 'ls' });
  });

  it('extends a jsonSchema-wrapped (MCP) tool with intent first, required untouched', async () => {
    let seen: unknown;
    const mcpTool = {
      description: 'mcp tool',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async (input: unknown) => { seen = input; return 'ok'; },
    } as any;
    const tools = withIntentParam({ mcp__ctx__search: mcpTool });
    const wrapped = (tools.mcp__ctx__search as any).inputSchema;
    expect(Object.keys(wrapped.jsonSchema.properties)).toEqual([INTENT_PARAM, 'query']);
    expect(wrapped.jsonSchema.required).toEqual(['query']);
    expect(wrapped.jsonSchema.additionalProperties).toBe(false);
    await (tools.mcp__ctx__search as any).execute({ query: 'x', intent: 'searching docs' }, {});
    expect(seen).toEqual({ query: 'x' });
  });

  it('leaves a tool that already declares its own intent param untouched', async () => {
    let seen: unknown;
    const tool = {
      inputSchema: z.object({ intent: z.string(), other: z.string() }),
      execute: async (input: unknown) => { seen = input; return 'ok'; },
    } as any;
    const tools = withIntentParam({ custom: tool });
    expect((tools.custom as any).inputSchema).toBe(tool.inputSchema);
    await (tools.custom as any).execute({ intent: 'domain value', other: 'x' }, {});
    // The tool owns the param; its value must reach execute unstripped.
    expect(seen).toEqual({ intent: 'domain value', other: 'x' });
  });

  it('skips await_human, report_incomplete, and subagent tools', () => {
    const mk = () => zodTool(async () => 'ok');
    const input = { await_human: mk(), report_incomplete: mk(), subagent__helper: mk() };
    const tools = withIntentParam(input);
    for (const name of Object.keys(input)) {
      expect((tools as any)[name].inputSchema).toBe((input as any)[name].inputSchema);
    }
  });

  it('skips refined Zod schemas and tools without execute', () => {
    const refined = {
      inputSchema: z.object({ a: z.string() }).refine(() => true),
      execute: async () => 'ok',
    } as any;
    const noExecute = { inputSchema: z.object({ a: z.string() }) } as any;
    const tools = withIntentParam({ refined, noExecute });
    expect((tools.refined as any).inputSchema).toBe(refined.inputSchema);
    expect((tools.noExecute as any).inputSchema).toBe(noExecute.inputSchema);
  });
});

describe('extractToolIntent / withoutToolIntent', () => {
  it('extracts a trimmed phrase and ignores empty/non-string values', () => {
    expect(extractToolIntent({ intent: '  reading config  ', a: 1 })).toBe('reading config');
    expect(extractToolIntent({ intent: '   ' })).toBeUndefined();
    expect(extractToolIntent({ intent: 42 })).toBeUndefined();
    expect(extractToolIntent({ a: 1 })).toBeUndefined();
    expect(extractToolIntent(undefined)).toBeUndefined();
    expect(extractToolIntent('string input')).toBeUndefined();
  });

  it('strips the key whenever present, so varied phrasing cannot defeat doom-loop comparison', () => {
    expect(withoutToolIntent({ intent: 'first wording', command: 'ls' }))
      .toEqual(withoutToolIntent({ intent: 'second wording', command: 'ls' }));
    expect(withoutToolIntent({ intent: '', command: 'ls' })).toEqual({ command: 'ls' });
    const untouched = { command: 'ls' };
    expect(withoutToolIntent(untouched)).toBe(untouched);
    expect(withoutToolIntent(null)).toBeNull();
  });
});
