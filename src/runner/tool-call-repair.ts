import { InvalidToolInputError, type NoSuchToolError } from 'ai';
import type { LanguageModelV4ToolCall } from '@ai-sdk/provider';

/**
 * Long, markdown-heavy tool inputs occasionally trigger a known Claude failure
 * mode: mid-call the model drifts from JSON tool-use into its legacy XML tool
 * syntax, leaving `</parameter>\n<parameter name="changes">…` embedded inside
 * string values and closing with `</invoke>`. The neighboring fields it meant
 * to send get smuggled into the preceding string instead of becoming JSON
 * properties.
 *
 * Two pieces defend against this:
 *  - Human-facing tool schemas (await_human) reject inputs carrying the markup
 *    via `findXmlToolMarkup`, turning silent garbling into an
 *    InvalidToolInputError.
 *  - `repairSmuggledXmlToolCall` is wired into streamText's `repairToolCall`:
 *    on any tool's input-validation failure it deterministically re-splits the
 *    smuggled fragments back into real JSON properties, so the call proceeds
 *    without burning a model round-trip. Anything it cannot fix falls through
 *    to the normal tool-error retry path.
 */
export const XML_TOOL_MARKUP = /<\/?(?:antml:)?(?:parameter|invoke|function_calls)\b/;

export function findXmlToolMarkup(value: unknown): boolean {
  if (typeof value === 'string') return XML_TOOL_MARKUP.test(value);
  if (Array.isArray(value)) return value.some(findXmlToolMarkup);
  if (value && typeof value === 'object') return Object.values(value).some(findXmlToolMarkup);
  return false;
}

const PARAM_FRAGMENT =
  /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?=<(?:antml:)?parameter\s+name="|<\/(?:antml:)?(?:parameter|invoke|function_calls)>|$)/g;

/** Strip trailing/leading XML tool-syntax remnants from an extracted value. */
function cleanFragment(value: string): string {
  return value
    .replace(/<\/(?:antml:)?(?:parameter|invoke|function_calls)>/g, '')
    .trim();
}

/** Parse a smuggled value: JSON when it looks like JSON, else the raw string. */
function parseFragmentValue(raw: string): unknown {
  const cleaned = cleanFragment(raw);
  if (/^[[{]/.test(cleaned)) {
    try {
      return JSON.parse(cleaned);
    } catch {
      // fall through: keep the string
    }
  }
  return cleaned;
}

/**
 * Rebuild a tool input whose top-level string values carry smuggled
 * `<parameter name="x">…` fragments. Returns the repaired object, or null when
 * there is nothing recognizable to repair (no markup, or markup in a shape we
 * do not understand, e.g. buried in nested values).
 */
export function unsmuggleXmlParams(input: Record<string, unknown>): Record<string, unknown> | null {
  let repairedAnything = false;
  const repaired: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !XML_TOOL_MARKUP.test(value)) {
      // Markup hiding below the top level is a shape we have not seen from
      // real drift; bail so the model gets the descriptive error instead of a
      // half-repaired call.
      if (findXmlToolMarkup(value)) return null;
      repaired[key] = value;
      continue;
    }

    const markupStart = value.search(XML_TOOL_MARKUP);
    const ownValue = cleanFragment(value.slice(0, markupStart));
    if (ownValue.length > 0) repaired[key] = ownValue;

    const tail = value.slice(markupStart);
    PARAM_FRAGMENT.lastIndex = 0;
    for (const match of tail.matchAll(PARAM_FRAGMENT)) {
      const [, name, raw] = match;
      if (name === undefined || raw === undefined) continue;
      // First writer wins: never clobber a field the model sent properly.
      if (name in repaired || (name in input && name !== key)) continue;
      repaired[name] = parseFragmentValue(raw);
    }
    repairedAnything = true;
  }

  return repairedAnything ? repaired : null;
}

/**
 * The same drift in its structural form: instead of landing inside a string
 * value (where the JSON still parses), the markup replaces the syntax that
 * OPENS a nested value, so the payload is not JSON at all:
 *
 *   "reference": \n<parameter name="label">Replying to, "author": "Ilya", …}
 *
 * The model meant `"reference": {"label": "Replying to", "author": "Ilya", …}`.
 * It spent the object's opening brace on the XML tag, so the matching closing
 * brace at the end closes the nested object and the outer one is never closed.
 *
 * This runs on the raw text, before parsing, and is deliberately narrow:
 *  - the tag must sit in value position (right after `"key":`);
 *  - the smuggled scalar must be a single line with no quotes, terminated by
 *    the next `, "key":` boundary - prose that merely contains a comma cannot
 *    be mistaken for the boundary;
 *  - only unclosed braces/brackets are appended, never removed;
 *  - the result is returned ONLY if it parses and carries no leftover markup.
 * Anything else returns null and takes the normal retry path.
 */
const VALUE_POSITION_PARAM =
  /("[^"]+"\s*:\s*)<(?:antml:)?parameter\s+name="([^"]+)"\s*>([^"\n]*?)(?=,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:)/g;

const MAX_APPENDED_CLOSERS = 4;

export function unsmuggleXmlStructure(raw: string): string | null {
  if (!XML_TOOL_MARKUP.test(raw)) return null;

  let repaired = raw.replace(
    VALUE_POSITION_PARAM,
    (_m, keyPrefix: string, name: string, scalar: string) =>
      `${keyPrefix}{"${name}": "${scalar.trim()}"`
  );
  if (repaired === raw) return null;

  // Drop any residual closing tags the drift left behind.
  repaired = repaired.replace(/<\/(?:antml:)?(?:parameter|invoke|function_calls)>/g, '');
  if (XML_TOOL_MARKUP.test(repaired)) return null;

  for (let extra = 0; extra <= MAX_APPENDED_CLOSERS; extra++) {
    const candidate = repaired + '}'.repeat(extra);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return candidate;
    } catch {
      // try one more closer
    }
  }
  return null;
}

/**
 * streamText `repairToolCall` hook. Deterministic only: fixes the known
 * XML-smuggling drift and nothing else. Returning null hands the original
 * validation error back to the model as a tool error, which is the normal
 * self-retry path.
 */
export async function repairSmuggledXmlToolCall({ toolCall, error }: {
  toolCall: LanguageModelV4ToolCall;
  error: NoSuchToolError | InvalidToolInputError;
}): Promise<LanguageModelV4ToolCall | null> {
  if (!InvalidToolInputError.isInstance(error)) return null;

  let parsed: unknown;
  let structurallyRepaired = false;
  try {
    parsed = JSON.parse(toolCall.input);
  } catch {
    // Not JSON at all: the drift may have eaten structural syntax rather than
    // hidden inside a string. Try the structural repair before giving up.
    const rebuilt = unsmuggleXmlStructure(toolCall.input);
    if (!rebuilt) return null;
    parsed = JSON.parse(rebuilt);
    structurallyRepaired = true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Both shapes can co-occur, so still run the in-string pass. If it finds
  // nothing, only a completed structural repair counts as a repair - otherwise
  // we would hand back an unchanged input and mask the normal retry path.
  const repaired = unsmuggleXmlParams(parsed as Record<string, unknown>)
    ?? (structurallyRepaired ? (parsed as Record<string, unknown>) : null);
  if (!repaired || findXmlToolMarkup(repaired)) return null;

  return { ...toolCall, input: JSON.stringify(repaired) };
}
