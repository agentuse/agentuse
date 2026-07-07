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
 */
export function stripToolBlocks(messages: ModelMessage[], ids: Set<string>): ModelMessage[] {
  if (ids.size === 0) return [...messages];
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if ((message.role === 'assistant' || message.role === 'tool') && Array.isArray(content)) {
      const kept = content.filter((part: any) => {
        if ((part?.type === 'tool-call' || part?.type === 'tool-result') && ids.has(part.toolCallId)) {
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
