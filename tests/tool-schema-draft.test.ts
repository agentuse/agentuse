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

  it('validates draft-04 schemas with boolean exclusiveMinimum (older MCP servers)', async () => {
    const draft04 = {
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: { count: { type: 'number', minimum: 0, exclusiveMinimum: true } },
    };
    expect((await validate(draft04, { count: 1 })).success).toBe(true);
    expect((await validate(draft04, { count: 0 })).success).toBe(false);
  });

  it('validates draft-06 and 2019-09 schemas', async () => {
    const body = { type: 'object', required: ['q'], properties: { q: { type: 'string' } } };
    for (const $schema of ['http://json-schema.org/draft-06/schema#', 'https://json-schema.org/draft/2019-09/schema']) {
      expect((await validate({ $schema, ...body }, { q: 'x' })).success).toBe(true);
      expect((await validate({ $schema, ...body }, {})).success).toBe(false);
    }
  });

  it('validates a schema that declares an unknown future draft as 2020-12', async () => {
    const future = { ...draft2020, $schema: 'https://json-schema.org/draft/2030-01/schema', newKeyword: true };
    expect((await validate(future, { intent: 'check' })).success).toBe(true);
    expect((await validate(future, { extra: 1 })).success).toBe(false);
  });

  it('keeps draft-07 tuple items working for schemas that declare no draft', async () => {
    const tuple = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };
    expect((await validate(tuple, ['a', 1])).success).toBe(true);
    expect((await validate(tuple, [1, 'a'])).success).toBe(false);
  });
});
