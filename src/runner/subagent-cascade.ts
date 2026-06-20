import type { SessionInfo } from '../session/types';

/**
 * Read-side helpers for the delegated sub-agent approval cascade.
 *
 * A delegated leaf's approval gate suspends the child, parks the parent's
 * `subagent__*` step pending (`resumePayload.kind === 'subagent_wait'`), and bubbles
 * up to suspend the root. These helpers resolve that chain so a single gate can be
 * surfaced and acted on once at the root session. They take only a minimal session
 * reader so they can be unit-tested with a lightweight stub.
 */

/** Minimal session-store surface the cascade read helpers need. The real
 *  SessionManager satisfies this structurally; tests pass a small stub. */
export interface CascadeSessionReader {
  findSession(sessionId: string): Promise<{ session: SessionInfo; agentId: string } | null>;
  getSessionMessages(sessionId: string, agentId: string): Promise<Array<{ id: string }>>;
  getMessageParts(sessionId: string, agentId: string, messageId: string): Promise<unknown[]>;
}

export interface LeafGate {
  session: SessionInfo;
  agentId: string;
  parts: any[];
  approvalPart: any;
}

/** Depth cap shared by every cascade walk (descend to leaf, ascend to root, and the
 *  resume-path chain builder). Bounds against cyclic/corrupt parent/child links. */
export const MAX_CASCADE_DEPTH = 16;

/** The childSessionID a session is parked on, if it holds a pending subagent_wait. */
export function findPendingSubagentWaitChildId(parts: any[]): string | undefined {
  const part = [...parts].reverse().find((p: any) =>
    p?.type === 'tool' &&
    p?.state?.status === 'pending' &&
    p?.state?.resumePayload?.kind === 'subagent_wait'
  );
  const childId = part?.state?.resumePayload?.childSessionID;
  return typeof childId === 'string' && childId.length > 0 ? childId : undefined;
}

/** The session's pending await_human gate part (the real human gate), if any. */
export function findPendingAwaitHumanPart(parts: any[]): any | undefined {
  return [...parts].reverse().find((p: any) =>
    p?.type === 'tool' && p?.tool === 'await_human' && p?.state?.status === 'pending' &&
    p?.state?.resumePayload?.kind === 'await_human'
  );
}

export async function loadSessionPartsFlat(
  reader: CascadeSessionReader,
  sessionId: string,
  agentId: string
): Promise<any[]> {
  const messages = await reader.getSessionMessages(sessionId, agentId);
  return (await Promise.all(
    messages.map((m) => reader.getMessageParts(sessionId, agentId, m.id))
  )).flat() as any[];
}

/**
 * Follow pending subagent_wait bookmarks down to the leaf session holding the real
 * await_human gate. Returns the leaf + its pending approval part, or null when the
 * chain is stale (a child is no longer suspended or holds no live gate). Bounded
 * against cycles by a depth cap.
 */
export async function descendToLeafGate(
  reader: CascadeSessionReader,
  childSessionId: string,
  depth = 0
): Promise<LeafGate | null> {
  if (depth > MAX_CASCADE_DEPTH) return null;
  const found = await reader.findSession(childSessionId);
  if (!found || found.session.status !== 'suspended') return null;
  const parts = await loadSessionPartsFlat(reader, childSessionId, found.agentId);
  const pendingAwaitHuman = findPendingAwaitHumanPart(parts);
  if (pendingAwaitHuman) {
    return { session: found.session, agentId: found.agentId, parts, approvalPart: pendingAwaitHuman };
  }
  const nextChildId = findPendingSubagentWaitChildId(parts);
  if (nextChildId) return descendToLeafGate(reader, nextChildId, depth + 1);
  return null;
}

/** Walk parentSessionID up to the topmost ancestor (the cascade root where approval
 *  happens). Used to point a delegated child's view-only page back at the root. */
export async function findRootSessionId(
  reader: CascadeSessionReader,
  sessionId: string
): Promise<string> {
  let currentId = sessionId;
  for (let i = 0; i < MAX_CASCADE_DEPTH; i++) {
    const f = await reader.findSession(currentId);
    const parent = (f?.session as { parentSessionID?: string } | undefined)?.parentSessionID;
    if (typeof parent !== 'string' || parent.length === 0) break;
    currentId = parent;
  }
  return currentId;
}
