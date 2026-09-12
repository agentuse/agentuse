import type { Tool } from 'ai';
import { asSchema } from 'ai';
import { createHash } from 'crypto';

/**
 * Marks an AgentUse-owned output contract as safe to expose inside Code Mode.
 *
 * Remote MCP schemas are useful for provider calls but are not trusted runtime
 * declarations. Keeping trust as explicit tool metadata prevents an external
 * schema from teaching guest code an invented result shape.
 */
export const TRUSTED_TOOL_OUTPUT_SCHEMA = Symbol.for('agentuse.tool.trusted-output-schema');

/**
 * Optional narrowed signatures for Code Mode declarations.
 *
 * A tool whose result shape depends on its input (a `countOnly` flag that
 * swaps rows for totals, a `mode` that changes the payload) is honest as a
 * plain union, but guest code then has to guard every variant before it can
 * touch a field, and the TypeScript preflight rejects the obvious first draft.
 * Overloads let the tool say "this input shape yields this output shape" so
 * the compiler resolves the call site instead of the model retrying.
 *
 * Overloads are declaration-only: the dispatcher still validates results
 * against the tool's full `outputSchema`, which stays the source of truth.
 * The full signature is always emitted last as the fallback, so an input the
 * overloads do not cover keeps the honest union.
 */
export const CODE_MODE_OVERLOADS = Symbol.for('agentuse.tool.code-mode-overloads');
/** Stable author-supplied compatibility identity for a tool whose input schema
 * transforms provider JSON before an approved execution is resumed. */
export const APPROVAL_TOOL_CONTRACT = Symbol.for('agentuse.tool.approval-contract');
/** Runtime schema retained privately when resume binds a provider-facing
 * snapshot schema. Approval compatibility must follow current execution
 * semantics, while the provider still receives the historical transport shape. */
export const APPROVAL_RUNTIME_INPUT_SCHEMA = Symbol.for('agentuse.tool.approval-runtime-input-schema');
/** Optional idempotent cleanup applied before provider-facing structural
 * validation. This is reserved for host-owned normalizers that remove values
 * which are semantically equivalent to omission; arbitrary schema transforms
 * remain dispatcher-owned and run exactly once after plugin preflight. */
export const TRANSPORT_INPUT_NORMALIZER = Symbol.for('agentuse.tool.transport-input-normalizer');

/** A tool is executable but cannot safely create or resume a durable approval. */
export class ApprovalToolContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalToolContractError';
  }
}

const TOOL_DISPATCH_EXECUTION = Symbol('agentuse.tool.dispatch-execution');
const PREVALIDATED_TRUSTED_OUTPUT = Symbol('agentuse.tool.prevalidated-trusted-output');

export interface CodeModeOverload {
  inputSchema: Tool['inputSchema'];
  outputSchema: NonNullable<Tool['outputSchema']>;
}

type ToolWithTrustedOutput = Tool & {
  [TRUSTED_TOOL_OUTPUT_SCHEMA]?: true;
  [CODE_MODE_OVERLOADS]?: readonly CodeModeOverload[];
  [APPROVAL_TOOL_CONTRACT]?: string;
  [APPROVAL_RUNTIME_INPUT_SCHEMA]?: unknown;
  [TRANSPORT_INPUT_NORMALIZER]?: (input: unknown) => unknown;
};

export interface TrustedOutputOptions {
  overloads?: readonly CodeModeOverload[];
}

/** Attach a trusted output schema marker while preserving the Tool type. */
export function trustedOutputTool<T extends Tool>(tool: T, options: TrustedOutputOptions = {}): T {
  (tool as ToolWithTrustedOutput)[TRUSTED_TOOL_OUTPUT_SCHEMA] = true;
  if (options.overloads && options.overloads.length > 0) {
    (tool as ToolWithTrustedOutput)[CODE_MODE_OVERLOADS] = options.overloads;
  }
  return tool;
}

/** Whether Code Mode may promote and enforce this tool's output schema. */
export function hasTrustedOutputSchema(tool: Tool): boolean {
  return (tool as ToolWithTrustedOutput)[TRUSTED_TOOL_OUTPUT_SCHEMA] === true
    && tool.outputSchema !== undefined;
}

/** Narrowed Code Mode signatures, only meaningful on a trusted tool. */
export function codeModeOverloads(tool: Tool): readonly CodeModeOverload[] {
  if (!hasTrustedOutputSchema(tool)) return [];
  return (tool as ToolWithTrustedOutput)[CODE_MODE_OVERLOADS] ?? [];
}

const APPROVAL_SCHEMA_MAX_CHARS = 128 * 1024;
const APPROVAL_SCHEMA_MAX_NODES = 10_000;

/**
 * Build the compatibility identity for a persisted approval input. This is
 * intentionally async because AI SDK schemas may be deferred. There is no
 * runtime-wide fallback: approving a call creates a durable promise about a
 * specific tool revision and exact input schema.
 */
export async function approvalToolContract(
  tool: unknown,
  toolName: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = tool && typeof tool === 'object'
    ? (tool as ToolWithTrustedOutput)[APPROVAL_TOOL_CONTRACT]
    : undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApprovalToolContractError(`Tool '${toolName}' requires an explicit stable approval contract version`);
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Tool approval aborted');
  let schema: unknown = tool && typeof tool === 'object'
    ? (tool as ToolWithTrustedOutput)[APPROVAL_RUNTIME_INPUT_SCHEMA] ?? (tool as Tool).inputSchema
    : undefined;
  // Some adapters provide the schema lazily. Await it under the caller's abort
  // signal rather than racing an unbounded promise during approval/resume.
  const awaitAbortable = async <T>(value: PromiseLike<T> | T): Promise<T> => {
    if (signal?.aborted) throw signal.reason ?? new Error('Tool approval aborted');
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error('Tool approval aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(value).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
  };
  if (schema && typeof (schema as any).then === 'function') {
    schema = await awaitAbortable(schema as PromiseLike<unknown>);
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Tool approval aborted');
  let nodes = 0;
  const stable = (candidate: any, seen = new Set<object>()): string => {
    if (++nodes > APPROVAL_SCHEMA_MAX_NODES) throw new ApprovalToolContractError(`Tool '${toolName}' approval schema is too complex`);
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return JSON.stringify(candidate);
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? JSON.stringify(candidate) : JSON.stringify(String(candidate));
    if (typeof candidate !== 'object') throw new ApprovalToolContractError(`Tool '${toolName}' approval schema is not JSON-compatible`);
    if (seen.has(candidate)) throw new ApprovalToolContractError(`Tool '${toolName}' approval schema contains a cycle`);
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) return `[${candidate.map(item => stable(item, seen)).join(',')}]`;
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      return `{${Object.keys(descriptors).sort().map(key => {
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor)) throw new ApprovalToolContractError(`Tool '${toolName}' approval schema contains an accessor`);
        return `${JSON.stringify(key)}:${stable(descriptor.value, seen)}`;
      }).join(',')}}`;
    } finally { seen.delete(candidate); }
  };
  // `jsonSchema` itself is allowed to be deferred by the AI SDK. Resolve it
  // under the same abort boundary before hashing, otherwise every Promise
  // looks like `{}` and a stopped resume can leave a pending schema forever.
  const jsonSchema = await awaitAbortable(asSchema(schema as any).jsonSchema as any);
  const schemaText = stable(jsonSchema);
  if (Buffer.byteLength(schemaText) > APPROVAL_SCHEMA_MAX_CHARS) {
    throw new ApprovalToolContractError(`Tool '${toolName}' approval schema exceeds ${APPROVAL_SCHEMA_MAX_CHARS} bytes`);
  }
  const schemaHash = createHash('sha256').update(schemaText).digest('hex').slice(0, 16);
  return `${value.trim()}:tool-${createHash('sha256').update(toolName).digest('hex').slice(0, 16)}:schema-${schemaHash}`;
}

export function setApprovalToolContract<T extends Tool>(tool: T, version: string): T {
  if (!version.trim()) throw new Error('Approval tool contract version must not be blank');
  (tool as ToolWithTrustedOutput)[APPROVAL_TOOL_CONTRACT] = version;
  return tool;
}

export function setTransportInputNormalizer<T extends Tool>(
  tool: T,
  normalizer: (input: unknown) => unknown,
): T {
  (tool as ToolWithTrustedOutput)[TRANSPORT_INPUT_NORMALIZER] = normalizer;
  return tool;
}

export function transportInputNormalizer(tool: Tool): ((input: unknown) => unknown) | undefined {
  return (tool as ToolWithTrustedOutput)[TRANSPORT_INPUT_NORMALIZER];
}

/** Mark an internal wrapper that validates its trusted result before return. */
export function markToolDispatchExecution<T extends Record<PropertyKey, unknown>>(options: T): T {
  Object.defineProperty(options, TOOL_DISPATCH_EXECUTION, { value: true });
  return options;
}

export function isToolDispatchExecution(options: unknown): boolean {
  return Boolean(options && typeof options === 'object' && (options as Record<PropertyKey, unknown>)[TOOL_DISPATCH_EXECUTION] === true);
}

/**
 * Carry a mock's already-validated raw and normalized result only across the
 * private dispatcher boundary. It supports primitive outputs without placing
 * a marker on the output itself.
 */
export function prevalidatedTrustedOutput(
  raw: unknown,
  value: unknown,
  schema: unknown,
): object {
  return { [PREVALIDATED_TRUSTED_OUTPUT]: { raw, value, schema } };
}

export function readPrevalidatedTrustedOutput(value: unknown):
  | { raw: unknown; value: unknown; schema: unknown }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<PropertyKey, unknown>)[PREVALIDATED_TRUSTED_OUTPUT] as
    | { raw: unknown; value: unknown; schema: unknown }
    | undefined;
}
