import type { ModelMessage } from 'ai';
import type { SessionManager } from './manager';
import type { Part, ToolPart } from './types';
import { stripToolBlocks, hasReasoningParts, lastAssistantMessage } from './message-utils';

function getPartOrder(part: Part): number {
  if (part.type === 'text') return part.time?.start ?? Number.MAX_SAFE_INTEGER;
  if (part.type === 'reasoning') return part.time.start;
  if (part.type === 'tool') {
    const state = part.state;
    if (state.status === 'pending') return state.suspendedAt ?? Number.MAX_SAFE_INTEGER;
    return state.time.start;
  }
  if (part.type === 'verify') return part.time.start;
  return Number.MAX_SAFE_INTEGER;
}

function toToolResultOutput(value: unknown): { type: 'text'; value: string } | { type: 'json'; value: unknown } {
  if (typeof value === 'string') {
    return { type: 'text', value };
  }

  if (value === undefined) {
    return { type: 'json', value: null };
  }

  try {
    return { type: 'json', value: JSON.parse(JSON.stringify(value)) };
  } catch {
    return { type: 'text', value: String(value) };
  }
}

function isToolResultOutput(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && typeof (value as { type?: unknown }).type === 'string'
    && 'value' in (value as object);
}

function assistantTurnTexts(message: ModelMessage): Set<string> {
  if (message.role !== 'assistant') return new Set();
  const content = (message as { content?: unknown }).content;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  if (typeof content === 'string') return new Set([normalize(content)]);
  if (!Array.isArray(content)) return new Set();
  return new Set(content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => normalize(part.text))
    .filter(Boolean));
}

// Heal context snapshots written before the prepareStep/stream-consumer race was
// fixed (see runner/execution.ts). Those snapshots can carry a tool-result whose
// `output` is a bare string instead of the AI SDK v5 `{ type, value }`
// ToolResultOutput form, a duplicate tool-result for a toolCallId that already
// has one, or an ORPHANED tool-result whose tool-call was dropped from the
// history (a gate sibling that was denied/journaled while its tool_use never
// made it into the signed turn - see appendToolResult). Any of these makes the
// messages fail validation on resume; the orphan specifically triggers the
// provider HTTP 400 "unexpected tool_use_id ... must have a corresponding
// tool_use block in the previous message". Normalize on read so existing
// sessions can still resume: wrap any bare-string output, keep only the first
// tool-result per toolCallId, and drop any tool-result with no matching
// tool-call. This is the symmetric counterpart to backfillMissingToolResults
// (which heals the inverse: a tool-call with no result).
function normalizeRehydratedMessages(messages: ModelMessage[]): ModelMessage[] {
  const calledIds = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role === 'assistant' && Array.isArray(content)) {
      for (const part of content as any[]) {
        if (part?.type === 'tool-call') calledIds.add(part.toolCallId);
      }
    }
  }

  const seenResults = new Set<string>();
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role === 'tool' && Array.isArray(content)) {
      const kept = content.filter((part: any) => {
        if (part?.type !== 'tool-result') return true;
        // Orphan: its tool-call was dropped from history. Anthropic rejects a
        // tool_result with no matching tool_use, so drop it. Safe: such a
        // sibling was denied/aborted, never executed, so nothing is lost.
        if (!calledIds.has(part.toolCallId)) return false;
        if (seenResults.has(part.toolCallId)) return false;
        seenResults.add(part.toolCallId);
        return true;
      }).map((part: any) => {
        if (part?.type === 'tool-result' && !isToolResultOutput(part.output)) {
          return { ...part, output: toToolResultOutput(part.output) };
        }
        return part;
      });
      if (kept.length === 0) continue; // dropped the whole (now-empty) tool message
      out.push({ ...(message as object), content: kept } as ModelMessage);
    } else {
      out.push(message);
    }
  }
  return out;
}

export async function rehydrateMessages(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
): Promise<ModelMessage[]> {
  const message = await sessionManager.getPrimaryMessage(sessionID, agentId);
  if (!message) {
    throw new Error(`Session message not found: ${sessionID}`);
  }

  const snapshot = await sessionManager.readContextSnapshot(sessionID, agentId);
  if (snapshot?.version === 1 && Array.isArray(snapshot.messages)) {
    const parts = await sessionManager.getMessageParts(sessionID, agentId, message.id);
    const fresh = parts.filter((part) => getPartOrder(part) > snapshot.updatedAt);

    // A suspended gate (e.g. `await_human`) is already captured in the snapshot:
    // the AI SDK records the thrown SuspendSignal as a synthetic tool-result
    // ("Agent execution suspended"), and the snapshot's `updatedAt` marks the
    // model step's START — earlier than the gate part's own timestamp (its
    // `suspendedAt`). So the resolved gate part below satisfies
    // `getPartOrder > updatedAt` and gets re-appended, duplicating the tool-call.
    // That leaves the snapshot's copy dangling on the provider (no result
    // immediately after it) AND makes normalizeRehydratedMessages keep the STALE
    // "suspended" result over the real approval decision. Purge any tool blocks
    // from the snapshot whose part we are about to re-append, so the resolved
    // part is the single source of truth for that call. Heals sessions already
    // suspended before this fix, so they can resume on upgrade.
    const reappendedToolIds = new Set(
      fresh.filter((part): part is ToolPart => part.type === 'tool').map((part) => part.callID)
    );
    const snapshotMessages = snapshot.messages as ModelMessage[];

    // Reasoning-safe resume. If the trailing assistant turn carries signed
    // Anthropic thinking blocks, it must be replayed byte-for-byte: keep every
    // tool-CALL block in place (re-appending a second tool-call for the same id
    // would both duplicate the call and force a rewrite of the signed turn, which
    // Anthropic rejects with `thinking blocks cannot be modified`). Strip only
    // the stale tool-RESULTS for the ids we are re-appending, then attach exactly
    // one real result per call after the intact turn.
    const signedTurn = lastAssistantMessage(snapshotMessages);
    if (signedTurn && hasReasoningParts(signedTurn)) {
      const messages = stripToolBlocks(snapshotMessages, reappendedToolIds, { resultsOnly: true });
      const signedTexts = assistantTurnTexts(signedTurn);
      // Result-only append assumes the part's tool-CALL survives in the
      // snapshot — but the suspended step's output is only folded into the
      // active context when the prepareStep race wins. When it lost, the gate
      // call is absent from the snapshot entirely; appending its result alone
      // creates an orphan that normalizeRehydratedMessages drops, silently
      // losing the reviewer's decision (the resumed model then re-gates the
      // stale draft as if it never asked). Split fresh tool parts by whether
      // their call exists in the snapshot: known calls get the result appended
      // in place, unknown calls get the full call+result pair re-appended as a
      // new turn AFTER the signed turn is fully resolved, so the signed content
      // is never rewritten and no tool_use is left dangling in between.
      const snapshotCallIds = new Set<string>();
      for (const message of messages) {
        const content = (message as { content?: unknown }).content;
        if (message.role === 'assistant' && Array.isArray(content)) {
          for (const part of content as any[]) {
            if (part?.type === 'tool-call') snapshotCallIds.add(part.toolCallId);
          }
        }
      }
      const uncapturedToolParts: ToolPart[] = [];
      for (const part of fresh) {
        if (part.type === 'tool') {
          if (snapshotCallIds.has(part.callID)) {
            appendToolResult(messages, part);
          } else {
            uncapturedToolParts.push(part);
          }
        } else if (
          part.type === 'text'
          && part.role !== 'user'
          && signedTexts.has(part.text.replace(/\s+/g, ' ').trim())
        ) {
          // The durable stream consumer persists free assistant text from the
          // gate turn as TextParts. Signed snapshots already contain those
          // bytes in the same assistant turn; appending the TextPart again
          // duplicates the model's statement after the approval exchange.
          continue;
        } else {
          appendPartMessages(messages, part);
        }
      }
      // A tool-call left without any result would dangle (Anthropic rejects a
      // tool_use with no matching tool_result). Backfill a benign error result
      // for any call in the signed turn that neither the snapshot nor a fresh
      // part resolved.
      backfillMissingToolResults(messages, signedTurn);
      for (const part of uncapturedToolParts) {
        // Only settled parts: a pending part has no result yet and would
        // itself dangle.
        if (part.state.status === 'completed' || part.state.status === 'error') {
          appendToolMessages(messages, part);
        }
      }
      return normalizeRehydratedMessages(messages);
    }

    const messages = stripToolBlocks(snapshotMessages, reappendedToolIds);
    for (const part of fresh) {
      appendPartMessages(messages, part);
    }
    return normalizeRehydratedMessages(messages);
  }

  const messages: ModelMessage[] = [];
  for (const content of message.assistant.system) {
    messages.push({ role: 'system', content } as ModelMessage);
  }

  const userContent = message.user.prompt.user
    ? `${message.user.prompt.task}\n\n${message.user.prompt.user}`
    : message.user.prompt.task;
  messages.push({ role: 'user', content: userContent } as ModelMessage);

  const parts = await sessionManager.getMessageParts(sessionID, agentId, message.id);

  for (const part of parts) {
    appendPartMessages(messages, part);
  }

  return normalizeRehydratedMessages(messages);
}

function appendPartMessages(messages: ModelMessage[], part: Part): void {
  switch (part.type) {
    case 'text':
      if (part.text) {
        messages.push({
          role: part.role === 'user' ? 'user' : 'assistant',
          content: part.text
        } as ModelMessage);
      }
      break;
    case 'tool':
      appendToolMessages(messages, part);
      break;
    default:
      break;
  }
}

function toolResultMessage(part: ToolPart): ModelMessage | undefined {
  const state = part.state;
  if (state.status === 'completed') {
    return {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: part.callID,
        toolName: part.tool,
        output: toToolResultOutput(state.output)
      }]
    } as unknown as ModelMessage;
  }
  if (state.status === 'error') {
    return {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: part.callID,
        toolName: part.tool,
        output: toToolResultOutput({
          success: false,
          error: state.error
        })
      }]
    } as unknown as ModelMessage;
  }
  return undefined; // pending/other: no result yet
}

function appendToolMessages(messages: ModelMessage[], part: ToolPart): void {
  const state = part.state;
  const input = 'input' in state ? state.input : undefined;

  messages.push({
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: part.callID,
      toolName: part.tool,
      input
    }]
  } as unknown as ModelMessage);

  const result = toolResultMessage(part);
  if (result) messages.push(result);
}

/**
 * Append only the resolved `tool-result` for `part` (no tool-call). Used on the
 * reasoning-safe resume path where the tool-CALL already lives in the intact,
 * signed assistant turn and must not be re-emitted.
 */
function appendToolResult(messages: ModelMessage[], part: ToolPart): void {
  const result = toolResultMessage(part);
  if (result) messages.push(result);
}

/**
 * Ensure every `tool-call` in the signed `assistantTurn` has a matching
 * `tool-result` somewhere in `messages`; synthesize a benign error result for
 * any that don't. A tool_use with no matching tool_result is rejected by
 * Anthropic, so this guards against a sibling call the journaling never
 * resolved.
 */
function backfillMissingToolResults(messages: ModelMessage[], assistantTurn: ModelMessage): void {
  const content = (assistantTurn as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  const resolved = new Set<string>();
  for (const message of messages) {
    const mc = (message as { content?: unknown }).content;
    if (message.role === 'tool' && Array.isArray(mc)) {
      for (const part of mc as any[]) {
        if (part?.type === 'tool-result') resolved.add(part.toolCallId);
      }
    }
  }
  for (const part of content as any[]) {
    if (part?.type !== 'tool-call' || resolved.has(part.toolCallId)) continue;
    messages.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: toToolResultOutput({
          success: false,
          error: 'Tool call was not resolved before resume.'
        })
      }]
    } as unknown as ModelMessage);
    resolved.add(part.toolCallId);
  }
}
