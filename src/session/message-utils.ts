import type { ModelMessage } from 'ai';

/**
 * Remove every `tool-call` / `tool-result` block whose `toolCallId` is in `ids`,
 * dropping any message left empty. Non-tool blocks (e.g. assistant text that
 * shares a message with a stripped tool-call) are preserved.
 *
 * Used on both sides of the suspend/resume boundary to keep a suspended gate's
 * resolved part as the single source of truth:
 * - write side (execution.buildContextSnapshot): trim the gate we are suspending
 *   on out of the snapshot, so a racing prepareStep's synthetic "Agent execution
 *   suspended" tool-result never gets persisted as if the gate were settled.
 * - read side (rehydrate): evict any gate blocks the snapshot still carries
 *   before re-appending the resolved part, healing snapshots written before the
 *   write-side trim existed.
 *
 * `opts.resultsOnly` keeps every `tool-call` block and drops only matching
 * `tool-result` blocks. This is the reasoning-safe mode: when the suspended
 * assistant turn carries signed Anthropic thinking blocks, its content array
 * must not be rewritten (see `hasReasoningParts`), so the tool-CALL stays put and
 * only the stale tool-RESULT is removed.
 */
export function stripToolBlocks(
  messages: ModelMessage[],
  ids: Set<string>,
  opts: { resultsOnly?: boolean } = {},
): ModelMessage[] {
  if (ids.size === 0) return [...messages];
  const resultsOnly = opts.resultsOnly ?? false;
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if ((message.role === 'assistant' || message.role === 'tool') && Array.isArray(content)) {
      const kept = content.filter((part: any) => {
        const isCall = part?.type === 'tool-call';
        const isResult = part?.type === 'tool-result';
        if ((isCall || isResult) && ids.has(part.toolCallId)) {
          // In results-only mode, keep tool-CALL blocks (they live in a signed
          // thinking turn that must survive verbatim); drop only the tool-result.
          if (resultsOnly && isCall) return true;
          return false;
        }
        return true;
      });
      if (kept.length === 0) continue; // whole message was the stripped tool block
      out.push({ ...(message as object), content: kept } as ModelMessage);
    } else {
      out.push(message);
    }
  }
  return out;
}

/**
 * True if this assistant message carries Anthropic extended-thinking output
 * (AI SDK `reasoning` parts). Those blocks are cryptographically signed by the
 * provider and must be replayed byte-for-byte: any edit to the content array of
 * a thinking-bearing turn invalidates the signature, and Anthropic rejects the
 * whole request with `thinking ... blocks cannot be modified`. Callers use this
 * to take a reasoning-safe suspend/resume path that never rewrites the signed
 * turn (only appends tool-results after it).
 */
export function hasReasoningParts(message: ModelMessage): boolean {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some((part: any) => part?.type === 'reasoning');
}

/** The last `assistant` message in order, or undefined if there is none. */
export function lastAssistantMessage(messages: ModelMessage[]): ModelMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return undefined;
}

/** Injected when a resumed history would otherwise end on an assistant turn. */
export const RESUME_CONTINUATION_PROMPT =
  'Resuming the run. Continue from the state above and finish the task.';

/**
 * Guarantee a resumed history ends on a user turn.
 *
 * A trailing assistant message is an assistant-prefill request: Anthropic
 * reasoning models reject it outright ("This model does not support assistant
 * message prefill. The conversation must end with a user message.", HTTP 400),
 * and models that do accept it silently ask the model to continue its own last
 * sentence instead of taking a new turn. Neither is ever what a resume wants.
 * Appending a neutral continuation turn is the only repair that keeps the
 * history intact — dropping the trailing message would lose the model's own
 * words and can strand a tool-call.
 *
 * Returns the array unchanged when it already ends on `user` or `tool` (a
 * tool-result IS the user turn as far as the provider is concerned).
 */
export function ensureTrailingUserTurn(messages: ModelMessage[]): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return messages;
  return [...messages, { role: 'user', content: RESUME_CONTINUATION_PROMPT } as ModelMessage];
}
