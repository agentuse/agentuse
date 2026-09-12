import type { Tool } from 'ai';

/**
 * Marks an AgentUse-owned output contract as safe to expose inside Code Mode.
 *
 * Remote MCP schemas are useful for provider calls but are not trusted runtime
 * declarations. Keeping trust as explicit tool metadata prevents an external
 * schema from teaching guest code an invented result shape.
 */
export const TRUSTED_TOOL_OUTPUT_SCHEMA = Symbol.for('agentuse.tool.trusted-output-schema');

type ToolWithTrustedOutput = Tool & {
  [TRUSTED_TOOL_OUTPUT_SCHEMA]?: true;
};

/** Attach a trusted output schema marker while preserving the Tool type. */
export function trustedOutputTool<T extends Tool>(tool: T): T {
  (tool as ToolWithTrustedOutput)[TRUSTED_TOOL_OUTPUT_SCHEMA] = true;
  return tool;
}

/** Whether Code Mode may promote and enforce this tool's output schema. */
export function hasTrustedOutputSchema(tool: Tool): boolean {
  return (tool as ToolWithTrustedOutput)[TRUSTED_TOOL_OUTPUT_SCHEMA] === true
    && tool.outputSchema !== undefined;
}
