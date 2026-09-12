import * as aiSdk from 'ai';
import type { Tool } from 'ai';
import { codeModeOverloads, hasTrustedOutputSchema } from '../tools/tool-contract';

const MAX_DECLARATION_CHARS = 32_768;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_QUICK_INDEX_CHARS = 8_000;
const MAX_QUICK_INPUT_CHARS = 300;
const MAX_QUICK_OUTPUT_CHARS = 800;
const MAX_TOOL_DESCRIPTION_CHARS = 1_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface RenderState {
  nodes: number;
}

export interface CodeModeSignature {
  input: string;
  output: string;
}

export interface CodeModeToolContract {
  name: string;
  description?: string;
  input: string;
  output: string;
  outputKnown: boolean;
  /**
   * Narrowed signatures emitted ahead of the full one, so the compiler can
   * resolve input-dependent result shapes at the call site (see
   * CODE_MODE_OVERLOADS). Only present when the full output is known.
   */
  overloads?: CodeModeSignature[];
}

function boundedDescription(tool: Tool | undefined): string | undefined {
  const description = typeof tool?.description === 'string' ? tool.description.trim() : '';
  if (!description) return undefined;
  return description.length <= MAX_TOOL_DESCRIPTION_CHARS
    ? description
    : `${description.slice(0, MAX_TOOL_DESCRIPTION_CHARS)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function literal(value: unknown): string | undefined {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  return undefined;
}

function renderUnion(values: unknown, depth: number, state: RenderState): string | undefined {
  if (!Array.isArray(values) || values.length === 0 || values.length > 256) return undefined;
  const rendered = values.map(value => renderSchema(value, depth + 1, state));
  if (rendered.some(value => value === undefined)) return undefined;
  return [...new Set(rendered as string[])].join(' | ');
}

function renderObject(
  schema: Record<string, unknown>,
  depth: number,
  state: RenderState
): string | undefined {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredValues = Array.isArray(schema.required) ? schema.required : [];
  if (!requiredValues.every(value => typeof value === 'string')) return undefined;
  const required = new Set(requiredValues as string[]);
  const keys = [...new Set([...Object.keys(properties), ...required])].sort();
  if (keys.length > MAX_SCHEMA_PROPERTIES) return undefined;

  const fields: string[] = [];
  for (const key of keys) {
    if (!(key in properties)) return undefined;
    const rendered = renderSchema(properties[key], depth + 1, state) ?? 'unknown';
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    fields.push(`${name}${required.has(key) ? '' : '?'}: ${rendered}`);
  }

  if (schema.additionalProperties !== false) {
    const additional = schema.additionalProperties === true || schema.additionalProperties === undefined
      ? 'unknown'
      : renderSchema(schema.additionalProperties, depth + 1, state) ?? 'unknown';
    if (fields.length === 0) return `Record<string, ${additional}>`;
    fields.push('[key: string]: unknown');
  }

  return fields.length === 0 ? 'Record<string, never>' : `{ ${fields.join('; ')} }`;
}

function renderSchema(schema: unknown, depth = 0, state: RenderState = { nodes: 0 }): string | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH || !isRecord(schema)) {
    return undefined;
  }
  if ('$ref' in schema || 'allOf' in schema || 'not' in schema) return undefined;
  if (Object.keys(schema).every(key => key === '$schema' || key === 'description' || key === 'title')) {
    return 'unknown';
  }

  const constant = literal(schema.const);
  if (constant !== undefined) return constant;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.map(literal);
    if (values.length > 0 && values.length <= 256 && values.every(value => value !== undefined)) {
      return [...new Set(values as string[])].join(' | ');
    }
    return undefined;
  }

  const union = 'anyOf' in schema
    ? renderUnion(schema.anyOf, depth, state)
    : 'oneOf' in schema
      ? renderUnion(schema.oneOf, depth, state)
      : undefined;
  if (union !== undefined) return union;

  if (Array.isArray(schema.type)) {
    const variants = schema.type.map(type => renderSchema({ ...schema, type }, depth + 1, state));
    if (variants.some(value => value === undefined)) return undefined;
    return [...new Set(variants as string[])].join(' | ');
  }

  switch (schema.type) {
    case 'object':
      return renderObject(schema, depth, state);
    case 'array': {
      const item = renderSchema(schema.items ?? {}, depth + 1, state) ?? 'unknown';
      return `Array<${item}>`;
    }
    case 'integer':
    case 'number':
      return 'number';
    case 'string':
    case 'boolean':
    case 'null':
      return schema.type;
    default:
      return undefined;
  }
}

async function jsonSchemaFor(schema: Tool['inputSchema'] | Tool['outputSchema']): Promise<unknown> {
  return await aiSdk.asSchema(schema).jsonSchema;
}

function jsonSchemaForSync(
  schema: Tool['inputSchema'] | Tool['outputSchema']
): unknown | undefined {
  const value = aiSdk.asSchema(schema).jsonSchema;
  if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
    // This is a best-effort synchronous index. Deferred schemas are rendered
    // asynchronously for execution, but their rejection must still be
    // observed here so a malformed lazy schema cannot become an unhandled
    // rejection while constructing the prompt.
    void Promise.resolve(value).catch(() => undefined);
    return undefined;
  }
  return value;
}

function boundedDeclaration(schema: unknown): string {
  const rendered = renderSchema(schema);
  return rendered && rendered.length <= MAX_DECLARATION_CHARS ? rendered : 'unknown';
}

/** Build one run-scoped contract from the effective AI SDK tool schemas. */
export async function buildCodeModeToolContracts(
  tools: Record<string, Tool>,
  names: readonly string[]
): Promise<CodeModeToolContract[]> {
  const contracts: CodeModeToolContract[] = [];
  for (const name of names) {
    const tool = tools[name];
    if (!tool) {
      contracts.push({ name, input: 'unknown', output: 'unknown', outputKnown: false });
      continue;
    }
    let input = 'unknown';
    try {
      input = boundedDeclaration(await jsonSchemaFor(tool.inputSchema));
    } catch {
      // A deferred or unsupported schema remains callable but untyped.
    }
    let output = 'unknown';
    let outputKnown = false;
    if (hasTrustedOutputSchema(tool)) {
      try {
        output = boundedDeclaration(await jsonSchemaFor(tool.outputSchema));
        outputKnown = output !== 'unknown';
      } catch {
        // Invalid contracts are rejected by ToolDispatcher before execution.
      }
    }
    const overloads: CodeModeSignature[] = [];
    if (outputKnown) {
      for (const overload of codeModeOverloads(tool)) {
        try {
          if (!aiSdk.asSchema(overload.inputSchema).validate || !aiSdk.asSchema(overload.outputSchema).validate) continue;
          const signature = {
            input: boundedDeclaration(await jsonSchemaFor(overload.inputSchema)),
            output: boundedDeclaration(await jsonSchemaFor(overload.outputSchema)),
          };
          if (signature.input !== 'unknown' && signature.output !== 'unknown') overloads.push(signature);
        } catch {
          // An overload that cannot be rendered is dropped; the full signature still applies.
        }
      }
    }
    const description = boundedDescription(tool);
    contracts.push({
      name,
      ...(description && { description }),
      input,
      output,
      outputKnown,
      ...(overloads.length > 0 ? { overloads } : {}),
    });
  }
  return contracts;
}

/** Synchronous best-effort contracts for the model-facing tool description. */
export function buildCodeModeToolContractsSync(
  tools: Record<string, Tool>,
  names: readonly string[]
): CodeModeToolContract[] {
  return names.map(name => {
    const tool = tools[name];
    if (!tool) return { name, input: 'unknown', output: 'unknown', outputKnown: false };
    let input = 'unknown';
    try {
      input = boundedDeclaration(jsonSchemaForSync(tool.inputSchema));
    } catch {
      // Deferred and unsupported contracts remain unknown in the prompt index.
    }
    let output = 'unknown';
    let outputKnown = false;
    if (hasTrustedOutputSchema(tool)) {
      try {
        output = boundedDeclaration(jsonSchemaForSync(tool.outputSchema));
        outputKnown = output !== 'unknown';
      } catch {
        // Runtime validation owns malformed trusted contracts.
      }
    }
    const overloads: CodeModeSignature[] = [];
    if (outputKnown) {
      for (const overload of codeModeOverloads(tool)) {
        try {
          if (!aiSdk.asSchema(overload.inputSchema).validate || !aiSdk.asSchema(overload.outputSchema).validate) continue;
          const signature = {
            input: boundedDeclaration(jsonSchemaForSync(overload.inputSchema)),
            output: boundedDeclaration(jsonSchemaForSync(overload.outputSchema)),
          };
          if (signature.input !== 'unknown' && signature.output !== 'unknown') overloads.push(signature);
        } catch {
          // Prompt index tolerates a missing overload; the full signature still applies.
        }
      }
    }
    const description = boundedDescription(tool);
    return {
      name,
      ...(description && { description }),
      input,
      output,
      outputKnown,
      ...(overloads.length > 0 ? { overloads } : {}),
    };
  });
}

function codeModeToolSignatures(contract: CodeModeToolContract): CodeModeSignature[] {
  return [
    ...(contract.overloads ?? []),
    { input: contract.input, output: contract.output },
  ];
}

/** One exact virtual declaration returned by API.read inside the guest. */
export function codeModeVirtualDeclaration(contract: CodeModeToolContract): string {
  const signatures = codeModeToolSignatures(contract)
    .map(signature => `  (input: ${signature.input}): Promise<${signature.output}>;`)
    .join('\n');
  const safeName = contract.name.replaceAll('*/', '* /').replace(/[\r\n]+/g, ' ');
  return `/** AgentUse tool: ${safeName} */\ndeclare const tool: {\n${signatures}\n};`;
}

/** Full declarations used by the in-memory TypeScript compiler. */
export function codeModeDeclarations(contracts: readonly CodeModeToolContract[]): string {
  const fields = contracts.map(contract => {
    const name = JSON.stringify(contract.name);
    // Overloads resolve in declaration order, so the narrowed signatures go
    // first and the full union stays as the catch-all. TypeScript only applies
    // overload resolution to call signatures, hence the method form here.
    return codeModeToolSignatures(contract)
      .map(signature => `  ${name}(input: ${signature.input}): Promise<${signature.output}>;`)
      .join('\n');
  });
  return `type CodeModeOutput = { type: "text"; text: string } | { type: "json"; value: unknown };\n` +
    `type CodeModeToolMetadata = { name: string; description: string; input: string; output?: string };\n` +
    `type CodeModeToolDescription = CodeModeToolMetadata & { declaration: string };\n` +
    `interface CodeModeToolHandle {\n` +
    `  (input?: Record<string, unknown>): Promise<unknown>;\n` +
    `  readonly name: string;\n` +
    `  readonly description: string;\n` +
    `  readonly input: string;\n` +
    `  readonly output?: string;\n` +
    `  describe(): Promise<CodeModeToolDescription>;\n` +
    `  toJSON(): CodeModeToolMetadata;\n` +
    `}\n` +
    `declare const catalog: {\n` +
    `  search(query: string, options?: { limit?: number }): Promise<readonly CodeModeToolHandle[]>;\n` +
    `  all(): readonly CodeModeToolHandle[];\n` +
    `};\n` +
    `declare const API: {\n` +
    `  list(scope: "tools"): string[];\n` +
    `  read(path: string): string | undefined;\n` +
    `};\n` +
    `declare function text(value: unknown): void;\n` +
    `declare function json(value: unknown): void;\n` +
    `declare const console: {\n` +
    `  log(...values: unknown[]): void;\n` +
    `  info(...values: unknown[]): void;\n` +
    `  warn(...values: unknown[]): void;\n` +
    `  error(...values: unknown[]): void;\n` +
    `  debug(...values: unknown[]): void;\n` +
    `};\n` +
    `declare const tools: {\n${fields.join('\n')}\n};`;
}

/** Bounded model-facing index. Unknown outputs stay explicit instead of inviting field guesses. */
export function codeModeQuickIndex(contracts: readonly CodeModeToolContract[]): string {
  const heading = [
    'Available nested tools (`name input -> output`; `-> ?` means unknown output):',
  ];
  const lines = contracts.map(contract => {
    const input = contract.input.length <= MAX_QUICK_INPUT_CHARS ? contract.input : 'unknown';
    const output = contract.outputKnown && contract.output.length <= MAX_QUICK_OUTPUT_CHARS
      ? contract.output
      : '?';
    return `- ${contract.name} ${input} -> ${output}`;
  });
  const included: string[] = [];
  for (const line of lines) {
    const candidate = [...heading, ...included, line].join('\n');
    if (candidate.length <= MAX_QUICK_INDEX_CHARS) included.push(line);
  }
  const omitted = lines.length - included.length;
  return [...heading, ...included, ...(omitted > 0 ? [`- ${omitted} additional tools omitted.`] : [])].join('\n');
}
