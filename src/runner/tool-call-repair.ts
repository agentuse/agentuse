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
  try {
    parsed = JSON.parse(toolCall.input);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const repaired = unsmuggleXmlParams(parsed as Record<string, unknown>);
  if (!repaired) return null;

  return { ...toolCall, input: JSON.stringify(repaired) };
}
