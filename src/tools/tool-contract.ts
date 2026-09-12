import type { Tool } from 'ai';

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

export interface CodeModeOverload {
  inputSchema: Tool['inputSchema'];
  outputSchema: NonNullable<Tool['outputSchema']>;
}

type ToolWithTrustedOutput = Tool & {
  [TRUSTED_TOOL_OUTPUT_SCHEMA]?: true;
  [CODE_MODE_OVERLOADS]?: readonly CodeModeOverload[];
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
