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
 * (a real approval, `descendToLeafGate`) or at a descendant still preparing/running (the
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
  if (session.status === 'preparing' || session.status === 'running') return null;
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

/**
 * Whether an ended child left a durable result its parked parent can be
 * finished from. A `completed` child did; so did one that ended
 * `report_incomplete` (session status 'error' with code INCOMPLETE) — its
 * report is on disk and the live walk-up deliberately folds incomplete
 * children in rather than stopping (see resumeApprovalCascade). Any other
 * error, or a missing record, leaves nothing to fold in, so parents parked on
 * those stay CASCADE_ORPHANED.
 */
export function isFinishableStale(stale: { status: string; error?: { code?: string | undefined } | undefined }): boolean {
  return stale.status === 'completed' ||
    (stale.status === 'error' && stale.error?.code === 'INCOMPLETE');
}

/** Reader surface for rebuilding a child's result from storage: the cascade
 *  part-walk plus the session's final assistant text. SessionManager satisfies
 *  this structurally. */
export interface CascadeResultReader extends CascadeSessionReader {
  getLastAssistantText(sessionId: string, agentId: string): Promise<string | undefined>;
}

/** A child's contribution to its parent's parked `subagent__*` step, rebuilt
 *  from durable state. Field-compatible with the slice of a live runAgent
 *  result that completeSubagentBookmark consumes. */
export interface StoredSubagentResult {
  text: string;
  complete?: { headline: string; details?: string; artifacts?: string[] };
  incomplete?: { reason: string };
}

/**
 * Rebuild what a child's `subagent__*` step would have returned, from the
 * child's stored session alone: its final assistant text plus the outcome it
 * declared via report_complete / report_incomplete. This is what makes a
 * cascade whose worker died between the child ending and the parent's bookmark
 * completing finishable after the fact — nothing the walk-up needs exists only
 * in the dead worker's memory. Same precedence as classifyRunResult: a child
 * that declared a real blocker is incomplete, whichever call landed last.
 */
export async function loadStoredSubagentResult(
  reader: CascadeResultReader,
  sessionId: string,
  agentId: string
): Promise<StoredSubagentResult> {
  const parts = await loadSessionPartsFlat(reader, sessionId, agentId);
  const lastToolInput = (tool: string): any => {
    const part = [...parts].reverse().find((p: any) =>
      p?.type === 'tool' && p?.tool === tool && p?.state?.status === 'completed'
    ) as any;
    return part?.state?.input;
  };
  const text = (await reader.getLastAssistantText(sessionId, agentId)) ?? '';
  const incompleteInput = lastToolInput('report_incomplete');
  if (typeof incompleteInput?.reason === 'string') {
    return { text, incomplete: { reason: incompleteInput.reason } };
  }
  const completeInput = lastToolInput('report_complete');
  if (typeof completeInput?.headline === 'string') {
    return {
      text,
      complete: {
        headline: completeInput.headline,
        ...(typeof completeInput.details === 'string' && completeInput.details.trim() && { details: completeInput.details }),
        ...(Array.isArray(completeInput.artifacts) && completeInput.artifacts.length > 0 && { artifacts: completeInput.artifacts }),
      },
    };
  }
  return { text };
}

/** Human-facing explanation for a stranded parent: names the child, its outcome,
 *  and the way out. Single-sourced so the list, the session page, and any
 *  future surface say the same thing. A finishable strand must NOT advise
 *  re-running — the child's work (often an external side effect) is already
 *  done, and the daemon's next startup sweep finishes the chain from storage. */
export function describeStaleCascade(stale: StaleCascadeChild): string {
  const reason = stale.error?.message?.trim().replace(/\.+$/, '');
  const cause = stale.status === 'missing'
    ? `its session record is missing (${stale.sessionId})`
    : stale.status === 'error' && stale.error?.code === 'INCOMPLETE'
      ? `it ended incomplete${reason ? `: ${reason}` : ''}`
      : `it ended ${stale.status}${reason ? `: ${reason}` : ''}`;
  const wayOut = isFinishableStale(stale)
    ? 'Its result is saved; the serve daemon folds it into this run at its next startup sweep.'
    : 'This run can no longer be resumed; stop it and re-run the agent.';
  return `Waiting on delegated sub-agent "${stale.agentName}", but ${cause}. ${wayOut}`;
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
