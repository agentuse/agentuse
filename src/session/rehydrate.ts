import type { ModelMessage } from 'ai';
import type { SessionManager } from './manager';
import type { Part, ToolPart } from './types';

function getPartOrder(part: Part): number {
  if (part.type === 'text') return part.time?.start ?? Number.MAX_SAFE_INTEGER;
  if (part.type === 'reasoning') return part.time.start;
  if (part.type === 'tool') {
    const state = part.state;
    if (state.status === 'pending') return state.suspendedAt ?? Number.MAX_SAFE_INTEGER;
    return state.time.start;
  }
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

// Heal context snapshots written before the prepareStep/stream-consumer race was
// fixed (see runner/execution.ts). Those snapshots can carry a tool-result whose
// `output` is a bare string instead of the AI SDK v5 `{ type, value }`
// ToolResultOutput form, and/or a duplicate tool-result for a toolCallId that
// already has one. Either makes the messages fail `modelMessageSchema` validation
// on resume. Normalize on read so existing sessions can still resume: wrap any
// bare-string output, and keep only the first tool-result per toolCallId.
function normalizeRehydratedMessages(messages: ModelMessage[]): ModelMessage[] {
  const seenResults = new Set<string>();
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role === 'tool' && Array.isArray(content)) {
      const kept = content.filter((part: any) => {
        if (part?.type !== 'tool-result') return true;
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
    const messages = snapshot.messages as ModelMessage[];
    const parts = await sessionManager.getMessageParts(sessionID, agentId, message.id);
    for (const part of parts.filter((part) => getPartOrder(part) > snapshot.updatedAt)) {
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

  if (state.status === 'completed') {
    messages.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: part.callID,
        toolName: part.tool,
        output: toToolResultOutput(state.output)
      }]
    } as unknown as ModelMessage);
  } else if (state.status === 'error') {
    messages.push({
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
    } as unknown as ModelMessage);
  }
}
