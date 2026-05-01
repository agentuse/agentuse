import type { ToolSet } from 'ai';
import type { ToolsSnapshot } from '../session/types';

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: any): JsonSchema | undefined {
  if (!schema?._def?.typeName) return undefined;

  const description = schema.description ?? schema._def.description;
  const withDescription = (base: JsonSchema): JsonSchema =>
    description ? { ...base, description } : base;

  switch (schema._def.typeName) {
    case 'ZodString':
      return withDescription({ type: 'string' });
    case 'ZodNumber':
      return withDescription({ type: 'number' });
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' });
    case 'ZodLiteral':
      return withDescription({ const: schema._def.value });
    case 'ZodEnum':
      return withDescription({ type: 'string', enum: schema._def.values });
    case 'ZodArray': {
      const items = zodToJsonSchema(schema._def.type) ?? {};
      return withDescription({ type: 'array', items });
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return zodToJsonSchema(schema._def.innerType);
    case 'ZodRecord':
      return withDescription({ type: 'object', additionalProperties: true });
    case 'ZodUnknown':
    case 'ZodAny':
      return withDescription({});
    case 'ZodObject': {
      const shape = typeof schema._def.shape === 'function'
        ? schema._def.shape()
        : schema._def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape ?? {})) {
        const child: any = value;
        properties[key] = zodToJsonSchema(child) ?? {};
        if (child?._def?.typeName !== 'ZodOptional' && child?._def?.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }

      return withDescription({
        type: 'object',
        properties,
        ...(required.length > 0 && { required }),
        additionalProperties: false
      });
    }
    case 'ZodUnion': {
      const options = schema._def.options
        ?.map((option: unknown) => zodToJsonSchema(option))
        .filter(Boolean);
      return withDescription({ anyOf: options?.length ? options : [{}] });
    }
    default:
      return undefined;
  }
}

function serializeInputSchema(schema: unknown): unknown {
  const converted = zodToJsonSchema(schema);
  if (converted) return converted;

  try {
    return JSON.parse(JSON.stringify(schema));
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

export function createToolsSnapshot(tools: ToolSet): ToolsSnapshot {
  return {
    tools: Object.entries(tools).map(([name, tool]: [string, any]) => ({
      name,
      ...(tool.description && { description: tool.description }),
      inputSchema: serializeInputSchema(tool.inputSchema)
    }))
  };
}

export function bindToolsToSnapshot(currentTools: ToolSet, snapshot: ToolsSnapshot): ToolSet {
  const missing = snapshot.tools
    .map(tool => tool.name)
    .filter(name => !(name in currentTools));

  if (missing.length > 0) {
    throw new Error(`TOOL_UNAVAILABLE: ${missing.join(', ')}`);
  }

  const bound: ToolSet = {};
  for (const snap of snapshot.tools) {
    const current = (currentTools as Record<string, any>)[snap.name];
    (bound as Record<string, any>)[snap.name] = {
      ...current,
      ...(snap.description !== undefined && { description: snap.description }),
      ...(snap.inputSchema !== undefined && { inputSchema: snap.inputSchema })
    };
  }

  return bound;
}
