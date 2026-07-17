import { jsonSchema, type ToolSet } from 'ai';
import type { ToolsSnapshot } from '../session/types';
import { logger } from '../utils/logger';

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
    case 'ZodReadonly':
    case 'ZodCatch':
      return zodToJsonSchema(schema._def.innerType);
    // Wrappers that decorate an inner schema under a different key than
    // `innerType`. Without these, a tool whose inputSchema is refined /
    // transformed / branded / piped falls through to the `default` below,
    // returns undefined, and gets JSON.stringify'd into Zod internals with no
    // top-level "type" - so it snapshots to a permissive `{}` on suspend and
    // loses its real shape on resume. `record_metric`'s top-level `.refine()`
    // and `await_human`'s `.refine()`d url fields both hit this.
    case 'ZodEffects': // .refine() / .superRefine() / .transform() / .preprocess()
      return zodToJsonSchema(schema._def.schema);
    case 'ZodBranded': // .brand()
      return zodToJsonSchema(schema._def.type);
    case 'ZodPipeline': // .pipe() - the input side is what validates tool args
      return zodToJsonSchema(schema._def.in);
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

function unwrapJsonSchemaWrapper(schema: unknown): JsonSchema | undefined {
  // AI SDK `jsonSchema()` wrapper (how MCP tool schemas arrive): the real
  // JSON Schema lives under `.jsonSchema`. Serializing the wrapper itself
  // stores { jsonSchema: {...} }, which the Anthropic API rejects on resume
  // ("input_schema.type: Field required").
  const inner = (schema as { jsonSchema?: unknown } | null | undefined)?.jsonSchema;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as JsonSchema;
  }
  return undefined;
}

function serializeInputSchema(schema: unknown): unknown {
  const target = unwrapJsonSchemaWrapper(schema) ?? schema;

  const converted = zodToJsonSchema(target);
  if (converted) return converted;

  try {
    return JSON.parse(JSON.stringify(target));
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

function isUsableInputSchema(schema: unknown): boolean {
  // The Anthropic API requires input_schema to be an object with a top-level
  // "type"; anything else 400s the RESUMED request, i.e. after the human has
  // already spent their approval. Catch it at suspend time instead.
  return !!schema && typeof schema === 'object' && !Array.isArray(schema) &&
    typeof (schema as { type?: unknown }).type === 'string';
}

export function createToolsSnapshot(tools: ToolSet): ToolsSnapshot {
  return {
    tools: Object.entries(tools).map(([name, tool]: [string, any]) => {
      let inputSchema = serializeInputSchema(tool.inputSchema);
      if (!isUsableInputSchema(inputSchema)) {
        logger.warn(
          `Tool "${name}" snapshotted to an unusable input schema (no top-level "type"); ` +
          `substituting a permissive object schema so the session can still resume. ` +
          `serializeInputSchema does not understand this tool's schema shape.`
        );
        inputSchema = { type: 'object', additionalProperties: true };
      }
      return {
        name,
        ...(tool.description && { description: tool.description }),
        inputSchema
      };
    })
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
    // Unwrap here too: snapshots written before the serializer unwrapped the
    // AI SDK wrapper persisted { jsonSchema: {...} }; those sessions must
    // still resume.
    const snapSchema = unwrapJsonSchemaWrapper(snap.inputSchema) ?? snap.inputSchema;
    (bound as Record<string, any>)[snap.name] = {
      ...current,
      ...(snap.description !== undefined && { description: snap.description }),
      ...(snapSchema !== undefined && { inputSchema: jsonSchema(snapSchema as any) })
    };
  }

  return bound;
}
