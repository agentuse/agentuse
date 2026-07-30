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

/** The broken link in a cascade chain that no longer leads to a live human gate. */
export interface StaleCascadeChild {
  sessionId: string;
  agentName: string;
  /** The child's raw session status at the break ('missing' when the id resolves to nothing). */
  status: string;
  error?: { code?: string; message?: string } | undefined;
}

/**
 * Diagnose a pending `subagent_wait` bookmark whose chain no longer ends in a live
 * gate, and report the child it broke at.
 *
 * A healthy chain ends either at a suspended leaf holding a pending `await_human`
 * (a real approval, `descendToLeafGate`) or at a descendant still `running` (the
 * manager is simply waiting out delegated work). Anything else is a stranded
 * ancestor: the child ended terminally, or is suspended with nothing pending, and
 * the parent will sit `suspended` forever because only the child's own resume can
 * complete its bookmark. Returns null while the chain is healthy so callers can
 * treat non-null as "this parked session is unresolvable and needs surfacing".
 */
export async function findStaleCascadeChild(
  reader: CascadeSessionReader,
  childSessionId: string,
  depth = 0
): Promise<StaleCascadeChild | null> {
  if (depth > MAX_CASCADE_DEPTH) return null;
  const found = await reader.findSession(childSessionId);
  if (!found) {
    return { sessionId: childSessionId, agentName: childSessionId, status: 'missing' };
  }
  const { session } = found;
  // Still working: the parent is progressing, not stranded.
  if (session.status === 'running') return null;
  const describe = (): StaleCascadeChild => ({
    sessionId: childSessionId,
    agentName: session.agent.name || session.agent.id,
    status: session.status,
    ...(session.error && { error: session.error }),
  });
  if (session.status !== 'suspended') return describe();

  const parts = await loadSessionPartsFlat(reader, childSessionId, found.agentId);
  if (findPendingAwaitHumanPart(parts)) return null; // live gate: healthy
  const nextChildId = findPendingSubagentWaitChildId(parts);
  if (nextChildId) return findStaleCascadeChild(reader, nextChildId, depth + 1);
  // Suspended with neither a gate nor a bookmark: nothing will ever resume it.
  return describe();
}

/** Error code stamped on a parent stranded by a dead cascade chain. */
export const CASCADE_ORPHANED_CODE = 'CASCADE_ORPHANED';

/** Human-facing explanation for a stranded parent: names the child, its outcome,
 *  and the only way out. Single-sourced so the list, the session page, and any
 *  future surface say the same thing. */
export function describeStaleCascade(stale: StaleCascadeChild): string {
  const reason = stale.error?.message?.trim().replace(/\.+$/, '');
  const cause = stale.status === 'missing'
    ? `its session record is missing (${stale.sessionId})`
    : `it ended ${stale.status}${reason ? `: ${reason}` : ''}`;
  return `Waiting on delegated sub-agent "${stale.agentName}", but ${cause}. `
    + 'This run can no longer be resumed; stop it and re-run the agent.';
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
