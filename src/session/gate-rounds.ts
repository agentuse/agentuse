import type { Part } from './types';
/** A completed gate a person (not the runtime or judge) answered with a comment. */
export function isHumanCommentDecision(part: Part): boolean {
  if (part.type !== 'tool' || part.tool !== 'await_human' || part.state.status !== 'completed') return false;
  const output = part.state.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  if (status !== 'comment' && status !== 'commented') return false;
  const source = typeof record.source === 'string' ? record.source.toLowerCase() : undefined;
  if (source === 'pre-review' || source === 'gate-preflight') return false;
  const reviewer = record.reviewer && typeof record.reviewer === 'object' && !Array.isArray(record.reviewer)
    ? record.reviewer as Record<string, unknown>
    : {};
  const name = [reviewer.username, reviewer.name, reviewer.id].find((v): v is string => typeof v === 'string');
  return name !== 'verify-judge' && name !== 'agentuse-runtime';
}

/** Round number of the newest gate in `parts` (oldest first): one more than
 *  the human comment decisions on the gates before it. */
export function gateRound(parts: Part[]): number {
  const gates = parts.filter((part) => part.type === 'tool' && part.tool === 'await_human');
  return 1 + gates.slice(0, -1).filter(isHumanCommentDecision).length;
}
