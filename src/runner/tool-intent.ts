import { jsonSchema, type Tool } from 'ai';
import { z } from 'zod';

/**
 * Tool-call intent phrases (agentuse-lab: intent labels).
 *
 * Every tool schema gets an optional `intent` parameter injected as its FIRST
 * property: one short phrase from the model stating what this specific call is
 * trying to achieve ("Locating where approval URLs are generated"). The CLI and
 * web session views surface it as the call's activity label; the phrase also
 * lands in the recorded tool input, so it survives resume and is available to
 * the verify judge as a declared-intent-vs-args signal.
 *
 * First property on purpose: tool-call arguments stream in schema order, so the
 * intent arrives before the (possibly large) real args and the UI can label the
 * call while it is still running.
 *
 * The parameter is presentation-only: execute() strips it before dispatch, so
 * the real tool (bash, MCP server, ...) never sees it.
 */
export const INTENT_PARAM = 'intent';

const INTENT_DESCRIPTION =
  'One short phrase (under 12 words) stating what this specific call is trying to achieve, ' +
  'e.g. "Running runner tests to verify the resume fix". ' +
  'Shown to the user as the live activity label for this call. ' +
  'State the goal, not the mechanics.';

// Tools whose own schema already carries the human-facing story: await_human
// has `prompt`/`summary` (and a second headline would compete with the approval
// card), report_incomplete has `reason`. Subagent calls carry their task prompt.
const SKIP_TOOL_NAMES = new Set(['await_human', 'report_incomplete']);

function shouldSkip(name: string): boolean {
  return SKIP_TOOL_NAMES.has(name) || name.startsWith('subagent__');
}

/**
 * Extend a tool input schema with the intent property, or return undefined when
 * the schema cannot be extended safely (non-object, refined/branded Zod
 * wrappers, or an existing `intent` property the tool owns).
 */
function extendInputSchema(schema: unknown): unknown | undefined {
  // Builtin tools: plain Zod object. Duck-typed like tool-snapshot.ts so a
  // structurally-compatible Zod from another instance still matches. Merging
  // INTO a fresh object puts intent first while keeping the original's
  // unknownKeys policy and catchall (Zod's merge takes both from the argument).
  const def = (schema as { _def?: { typeName?: string } } | null | undefined)?._def;
  if (def?.typeName === 'ZodObject') {
    const zodObj = schema as z.ZodObject<z.ZodRawShape>;
    if (INTENT_PARAM in zodObj.shape) return undefined;
    return z.object({
      [INTENT_PARAM]: z.string().describe(INTENT_DESCRIPTION).optional(),
    }).merge(zodObj);
  }

  // MCP tools: AI SDK `jsonSchema()` wrapper around a plain JSON Schema. The
  // rebuilt wrapper carries no validate fn - the SDK's MCP client doesn't
  // attach one either, and the server revalidates the stripped args itself.
  const inner = (schema as { jsonSchema?: unknown } | null | undefined)?.jsonSchema;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    const innerObj = inner as Record<string, unknown> & { properties?: Record<string, unknown> };
    if (innerObj.type !== 'object') return undefined;
    if (innerObj.properties && INTENT_PARAM in innerObj.properties) return undefined;
    return jsonSchema({
      ...innerObj,
      properties: {
        [INTENT_PARAM]: { type: 'string', description: INTENT_DESCRIPTION },
        ...(innerObj.properties ?? {}),
      },
    });
  }

  // Refined/transformed Zod schemas (ZodEffects etc.), non-object schemas, and
  // anything else unrecognized: leave the tool untouched rather than risk
  // breaking its validation.
  return undefined;
}

function injectIntentParam(name: string, tool: Tool): Tool {
  if (shouldSkip(name)) return tool;
  const originalExecute = (tool as { execute?: (input: unknown, opts: unknown) => unknown }).execute;
  // Without an execute there is nothing to strip the parameter before, so the
  // real tool would receive it - skip.
  if (typeof originalExecute !== 'function') return tool;
  const extended = extendInputSchema((tool as { inputSchema?: unknown }).inputSchema);
  if (extended === undefined) return tool;

  return {
    ...tool,
    inputSchema: extended,
    execute: async (input: unknown, opts: unknown) => {
      if (input && typeof input === 'object' && !Array.isArray(input) && INTENT_PARAM in input) {
        const { [INTENT_PARAM]: _intent, ...rest } = input as Record<string, unknown>;
        return originalExecute.call(tool, rest, opts);
      }
      return originalExecute.call(tool, input, opts);
    },
  } as Tool;
}

/**
 * Wrap every tool in the set with intent injection. Applied at the tool merge
 * point (tools-loader), after mock wrapping, so the strip-execute always wraps
 * whatever execute actually runs.
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

/**
 * Tool input without the injected intent key. Used wherever args are compared
 * or displayed as "the real input": the doom-loop detector (a varying phrase
 * must not make identical calls look distinct) and the input dumps in the
 * session views (the phrase is already the row label).
 */
export function withoutToolIntent(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !(INTENT_PARAM in input)) {
    return input;
  }
  const { [INTENT_PARAM]: _intent, ...rest } = input as Record<string, unknown>;
  return rest;
}
