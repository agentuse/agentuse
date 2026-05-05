import type { ModelMessage } from 'ai';
import type { SessionManager } from './manager';
import type { ToolPart } from './types';

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

export async function rehydrateMessages(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
): Promise<ModelMessage[]> {
  const message = await sessionManager.getPrimaryMessage(sessionID, agentId);
  if (!message) {
    throw new Error(`Session message not found: ${sessionID}`);
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

  return messages;
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
