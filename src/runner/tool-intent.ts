import { jsonSchema, type Tool } from 'ai';
import { z } from 'zod';
import { CODE_MODE_OVERLOADS, type CodeModeOverload } from '../tools/tool-contract';

/**
 * Tool-call intent phrases (agentuse-lab: intent labels).
 *
 * Every tool schema gets an optional `intent` parameter injected as its FIRST
 * property: one short phrase from the model stating what this specific call is
 * trying to achieve ("Locating where approval URLs are generated"). An optional
 * `recovers` parameter can identify an earlier failed tool-call id when this
 * call is an explicit recovery attempt. The CLI and web session views surface
 * both fields, and the values survive resume in the recorded tool input.
 *
 * First property on purpose: tool-call arguments stream in schema order, so the
 * intent arrives before the (possibly large) real args and the UI can label the
 * call while it is still running.
 *
 * Both parameters are runtime-only metadata: execute() strips them before
 * dispatch, so the real tool (bash, MCP server, ...) never sees them.
 */
export const INTENT_PARAM = 'intent';
export const RECOVERS_PARAM = 'recovers';

const INTENT_DESCRIPTION =
  'One short phrase (under 12 words) stating what this specific call is trying to achieve, ' +
  'e.g. "Running runner tests to verify the resume fix". ' +
  'Shown to the user as the live activity label for this call. ' +
  'State the goal, not the mechanics.';

const RECOVERS_DESCRIPTION =
  'Earlier failed tool-call ID this call is intended to recover. Omit otherwise.';

// Tools whose own schema already carries the human-facing story: await_human
// has `prompt`/`summary` (and a second headline would compete with the approval
// card), report_incomplete has `reason`. Subagent calls carry their task prompt.
const SKIP_TOOL_NAMES = new Set(['await_human', 'report_incomplete', 'submit_agent_source', 'submit_agent_revision', 'submit_changes']);

function shouldSkip(name: string): boolean {
  return SKIP_TOOL_NAMES.has(name) || name.startsWith('subagent__');
}

/**
 * Extend a tool input schema with the runtime metadata, or return undefined when
 * the schema cannot be extended safely (non-object, refined/branded Zod
 * wrappers, or a same-named property the tool owns).
 */
function extendInputSchema(schema: unknown): unknown | undefined {
  // Builtin tools: plain Zod object. Duck-typed like tool-snapshot.ts so a
  // structurally-compatible Zod from another instance still matches. Merging
  // INTO a fresh object puts intent first while keeping the original's
  // unknownKeys policy and catchall (Zod's merge takes both from the argument).
  const def = (schema as { _def?: { typeName?: string } } | null | undefined)?._def;
  if (def?.typeName === 'ZodObject') {
    const zodObj = schema as z.ZodObject<z.ZodRawShape>;
    if (INTENT_PARAM in zodObj.shape || RECOVERS_PARAM in zodObj.shape) return undefined;
    return z.object({
      [INTENT_PARAM]: z.string().describe(INTENT_DESCRIPTION).optional(),
      [RECOVERS_PARAM]: z.string().describe(RECOVERS_DESCRIPTION).optional(),
    }).merge(zodObj);
  }

  // MCP tools: AI SDK `jsonSchema()` wrapper around a plain JSON Schema. The
  // rebuilt wrapper carries no validate fn - the SDK's MCP client doesn't
  // attach one either, and the server revalidates the stripped args itself.
  const inner = (schema as { jsonSchema?: unknown } | null | undefined)?.jsonSchema;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    const innerObj = inner as Record<string, unknown> & { properties?: Record<string, unknown> };
    if (innerObj.type !== 'object') return undefined;
    if (innerObj.properties && (INTENT_PARAM in innerObj.properties || RECOVERS_PARAM in innerObj.properties)) return undefined;
    return jsonSchema({
      ...innerObj,
      properties: {
        [INTENT_PARAM]: { type: 'string', description: INTENT_DESCRIPTION },
        [RECOVERS_PARAM]: { type: 'string', description: RECOVERS_DESCRIPTION },
        ...(innerObj.properties ?? {}),
      },
    });
  }

  // Refined/transformed Zod schemas (ZodEffects etc.), non-object schemas, and
  // anything else unrecognized: leave the tool untouched rather than risk
  // breaking its validation.
  return undefined;
}

/**
 * Add runtime metadata to one tool registered after the loader ran (the
 * runtime code_exec tool), so it is labelled in the session views like the
 * rest of the catalog. The function name is retained for compatibility.
 */
export function injectIntentParam(name: string, tool: Tool): Tool {
  if (shouldSkip(name)) return tool;
  const originalExecute = (tool as { execute?: (input: unknown, opts: unknown) => unknown }).execute;
  // Without an execute there is nothing to strip the parameter before, so the
  // real tool would receive it - skip.
  if (typeof originalExecute !== 'function') return tool;
  const extended = extendInputSchema((tool as { inputSchema?: unknown }).inputSchema);
  if (extended === undefined) return tool;

  // Code Mode overloads describe the same call surface, so they must accept
  // the runtime keys too or a labelled nested call would miss every narrowed
  // signature and fall through to the full union.
  const overloads = (tool as { [CODE_MODE_OVERLOADS]?: readonly CodeModeOverload[] })[CODE_MODE_OVERLOADS];
  const extendedOverloads = overloads?.map(overload => {
    const input = extendInputSchema(overload.inputSchema);
    return input === undefined ? overload : { ...overload, inputSchema: input as CodeModeOverload['inputSchema'] };
  });

  return {
    ...tool,
    ...(extendedOverloads && { [CODE_MODE_OVERLOADS]: extendedOverloads }),
    inputSchema: extended,
    execute: async (input: unknown, opts: unknown) =>
      originalExecute.call(tool, withoutToolIntent(input), opts),
  } as Tool;
}

/**
 * Wrap every tool in the set with runtime metadata injection. Applied at the
 * tool merge point (tools-loader), after mock wrapping, so the strip-execute
 * always wraps whatever execute actually runs.
 */
export function withIntentParam(tools: Record<string, Tool>): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = injectIntentParam(name, tool);
  }
  return out;
}

/** The intent phrase from recorded tool input, if the model provided one. */
export function extractToolIntent(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[INTENT_PARAM];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Failed tool-call id this call declared it was intended to recover. */
export function extractToolRecovery(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[RECOVERS_PARAM];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Tool input without runtime-owned presentation metadata. Used wherever args
 * are dispatched, compared, or displayed as "the real input": neither a
 * varying intent nor a recovery link may alter the underlying tool call.
 *
 * The established name is retained for compatibility even though this now
 * strips both injected keys.
 */
export function withoutToolIntent(input: unknown): unknown {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (!(INTENT_PARAM in input) && !(RECOVERS_PARAM in input))
  ) {
    return input;
  }
  const {
    [INTENT_PARAM]: _intent,
    [RECOVERS_PARAM]: _recovers,
    ...rest
  } = input as Record<string, unknown>;
  return rest;
}
