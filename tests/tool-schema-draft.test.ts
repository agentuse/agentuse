import { describe, expect, it } from 'bun:test';
import { asSchema, jsonSchema, type Tool } from 'ai';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';

async function validate(schema: Record<string, unknown>, value: unknown) {
  const tool = { inputSchema: jsonSchema(schema), execute: async () => 'ok' } as Tool;
  const model = new ToolDispatcher({ probe: tool }).modelTools().probe as Tool;
  return asSchema(model.inputSchema).validate!(value);
}

describe('tool input schema drafts', () => {
  const draft2020 = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { intent: { type: 'string' } },
    additionalProperties: false,
  };

  it('validates a schema that declares JSON Schema 2020-12 (MCP servers send these)', async () => {
    expect((await validate(draft2020, { intent: 'check' })).success).toBe(true);
    expect((await validate(draft2020, { extra: 1 })).success).toBe(false);
  });

  it('keeps draft-07 tuple items working for schemas that declare no draft', async () => {
    const tuple = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };
    expect((await validate(tuple, ['a', 1])).success).toBe(true);
    expect((await validate(tuple, [1, 'a'])).success).toBe(false);
  });
});
