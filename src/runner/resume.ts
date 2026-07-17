import type { SessionManager } from '../session';
import type { ToolState } from '../session/types';
import { isProcessRefAlive } from '../utils/process-info';
import { LeaseStore, deriveLeaseEntries } from './approval-lease';
import { logger } from '../utils/logger';

export interface ResumeToolRollback {
  sessionId: string;
  agentId: string;
  messageId: string;
  partId: string;
  state: ToolState;
}

export async function applyResumeToolResult(options: {
  sessionManager: SessionManager;
  sessionId: string;
  toolResult: unknown;
  resumeToken?: string;
  skipTokenValidation?: boolean;
}): Promise<{ agentId: string; agentFilePath?: string; rollback?: ResumeToolRollback }> {
  const { sessionManager, sessionId, toolResult, resumeToken, skipTokenValidation } = options;
  const found = await sessionManager.findSession(sessionId);
  if (!found) {
    throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
  }
  if (found.session.status !== 'suspended') {
    throw new Error(`SESSION_NOT_SUSPENDED: ${found.session.status}`);
  }

  const pending = await sessionManager.findPendingTool(sessionId, found.agentId);
  if (!pending) {
    throw new Error(`PENDING_TOOL_NOT_FOUND: ${sessionId}`);
  }

  const expectedToken = pending.part.state.status === 'pending'
    ? pending.part.state.resumePayload?.resumeToken
    : undefined;
  if (!skipTokenValidation && expectedToken && expectedToken !== resumeToken) {
    throw new Error('RESUME_TOKEN_INVALID');
  }

  if (pending.part.state.status === 'completed') {
    return {
      agentId: found.agentId,
      ...(found.session.agent.filePath && { agentFilePath: found.session.agent.filePath })
    };
  }

  const rollback: ResumeToolRollback = {
    sessionId,
    agentId: found.agentId,
    messageId: pending.message.id,
    partId: pending.part.id,
    state: pending.part.state
  };
  const input = 'input' in pending.part.state ? pending.part.state.input : undefined;
  const resumePayload = pending.part.state.status === 'pending'
    ? pending.part.state.resumePayload
    : undefined;
  const now = Date.now();
  const start = pending.part.state.status === 'running'
    ? pending.part.state.time.start
    : pending.part.state.status === 'pending'
      ? (pending.part.state.suspendedAt ?? now)
      : now;
  await sessionManager.updatePart(sessionId, found.agentId, pending.message.id, pending.part.id, {
    state: {
      status: 'completed',
      input: input ?? {},
      output: toolResult,
      ...(resumePayload && { metadata: { resumePayload } }),
      time: {
        start,
        end: now
      }
    }
  } as any);

  // Lease lifecycle (agentuse-lab#165, Phase 2): an APPROVE derives a
  // machine-readable lease from the gate's changes[] - the only grant that
  // lets `effects:`-declared commands run. Any other decision (reject,
  // comment) revokes: nothing effectful may run until a fresh plan is
  // approved. Best-effort: a lease failure must not block the resume, it just
  // means effectful commands stay denied.
  try {
    const sessionDir = await sessionManager.getSessionDirectory(sessionId, found.agentId);
    const leaseStore = new LeaseStore(sessionDir);
    const decisionStatus = toolResult && typeof toolResult === 'object'
      ? (toolResult as { status?: unknown }).status
      : undefined;
    if (decisionStatus === 'approved') {
      const entries = deriveLeaseEntries(input);
      if (entries.length > 0) {
        leaseStore.grant({ version: 1, grantedAt: now, entries });
      } else {
        leaseStore.revoke();
      }
    } else {
      leaseStore.revoke();
    }
  } catch (error) {
    logger.debug(`[Lease] resume lease update failed: ${(error as Error).message}`);
  }

  await sessionManager.setSessionRunning(sessionId, found.agentId);

  return {
    agentId: found.agentId,
    ...(found.session.agent.filePath && { agentFilePath: found.session.agent.filePath }),
    rollback
  };
}

export async function restoreResumeToolResult(options: {
  sessionManager: SessionManager;
  rollback?: ResumeToolRollback | undefined;
}): Promise<void> {
  const { sessionManager, rollback } = options;
  if (!rollback) return;

  await sessionManager.updatePart(
    rollback.sessionId,
    rollback.agentId,
    rollback.messageId,
    rollback.partId,
    { state: rollback.state } as any
  );
  await sessionManager.setSessionSuspended(rollback.sessionId, rollback.agentId);
}

export type ReopenGateResult =
  | { ok: true; agentId: string }
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'SESSION_RUNNING' | 'ALREADY_SUSPENDED' | 'NO_REOPENABLE_GATE'; message: string };

/**
 * Decide whether a tool part is a resolved `await_human` gate that can be
 * reopened: it must be a completed/errored gate (i.e. a resume already consumed
 * it) that still carries the original `resumePayload` so we can rebuild the
 * suspended state. `subagent_wait` cascade bookmarks are excluded.
 */
function reopenableGate(part: any): { input: unknown; start: number; resumePayload: Record<string, unknown> } | null {
  if (part?.type !== 'tool') return null;
  const state = part.state ?? {};
  if (state.status !== 'completed' && state.status !== 'error') return null;
  const resumePayload = state.metadata?.resumePayload;
  if (!resumePayload || resumePayload.kind !== 'await_human') return null;
  return {
    input: 'input' in state ? state.input : undefined,
    start: typeof state.time?.start === 'number' ? state.time.start : Date.now(),
    resumePayload,
  };
}

/**
 * Manually roll an ended (error/completed) session back to its suspended approval
 * gate so a reviewer can retry a resume that failed downstream. This is the
 * user-initiated counterpart to the automatic preflight rollback
 * (restoreResumeToolResult): the worker deliberately keeps a decision durable
 * once a run has started (to avoid duplicate external actions), so recovering
 * from a mid/post-run failure is an explicit choice surfaced in the UI.
 *
 * Reconstructs the gate's `pending` state from the resolved part's persisted
 * `resumePayload` + `input` (the in-memory rollback token is long gone by now),
 * clears the session error, and re-suspends. The original gate `resumeToken`
 * is preserved, so the normal approval/decision → resume flow takes over.
 */
export async function reopenSuspendedGate(options: {
  sessionManager: SessionManager;
  sessionId: string;
}): Promise<ReopenGateResult> {
  const { sessionManager, sessionId } = options;
  const found = await sessionManager.findSession(sessionId);
  if (!found) {
    return { ok: false, code: 'SESSION_NOT_FOUND', message: `Session not found: ${sessionId}` };
  }
  if (found.session.status === 'running') {
    return { ok: false, code: 'SESSION_RUNNING', message: `Session ${sessionId} is still running` };
  }
  if (found.session.status === 'suspended') {
    return { ok: false, code: 'ALREADY_SUSPENDED', message: `Session ${sessionId} is already suspended` };
  }

  const message = await sessionManager.getPrimaryMessage(sessionId, found.agentId);
  if (!message) {
    return { ok: false, code: 'NO_REOPENABLE_GATE', message: `Session ${sessionId} has no resolved approval gate` };
  }
  const parts = await sessionManager.getMessageParts(sessionId, found.agentId, message.id);

  // Most recent resolved gate wins (a session may have passed several gates).
  let target: { part: any; gate: NonNullable<ReturnType<typeof reopenableGate>> } | undefined;
  for (const part of parts) {
    const gate = reopenableGate(part);
    if (gate && (!target || gate.start > target.gate.start)) {
      target = { part, gate };
    }
  }
  if (!target) {
    return { ok: false, code: 'NO_REOPENABLE_GATE', message: `Session ${sessionId} has no resolved approval gate to reopen` };
  }

  // Drop a possibly-stale expiry so the reopened gate is actionable; preserve
  // the original resumeToken and the rest of the payload.
  const { expiresAt: _expiresAt, ...resumePayload } = target.gate.resumePayload as Record<string, unknown>;
  const pendingState = {
    status: 'pending' as const,
    ...(target.gate.input !== undefined && { input: target.gate.input }),
    suspendedAt: target.gate.start,
    resumePayload,
  };

  await sessionManager.updatePart(sessionId, found.agentId, message.id, target.part.id, { state: pendingState } as any);
  // setSessionSuspended only flips status; clear the lingering error too so the
  // page renders a clean suspended approval rather than an errored one. The
  // `undefined` is dropped on JSON write, removing the key. Cast around
  // exactOptionalPropertyTypes, which forbids an explicit `undefined` here.
  await sessionManager.updateSession(sessionId, found.agentId, { status: 'suspended', error: undefined } as any);

  return { ok: true, agentId: found.agentId };
}

export interface ReconciledOrphan {
  sessionId: string;
  agentId: string;
  agentName: string;
}

/**
 * Recover sessions a dead worker left stuck as 'running' with no live process.
 *
 * A hard kill (daemon restart or crash — SIGINT/SIGTERM/SIGKILL) terminates the
 * worker child without running any JS, so the run's own terminal-status write
 * (and the resume preflight rollback) never fires and the session lies 'running'
 * forever. In that state every recovery lever refuses it: reopenSuspendedGate,
 * `sessions resume`, and the reopen endpoint all guard against 'running'.
 *
 * Call this the moment a project's worker (re)spawns. There is one worker per
 * project, so a freshly (re)spawned worker owns no executions yet: any 'running'
 * session last touched BEFORE it became ready (`time.updated < cutoff`) whose
 * recorded owner process is gone is orphaned. The owner probe matters because
 * the storage is shared by every process serving the project (a terminal
 * `agentuse run`, a second daemon with a different data dir) and a live run
 * rewrites its session file only on status changes — a stale header alone does
 * not prove the run is dead. Flip each orphan to a terminal
 * WORKER_INTERRUPTED error so reopenSuspendedGate becomes reachable. It never
 * auto-replays the run — a mutation agent could double-fire an external side
 * effect — so recovery stays an explicit, human-reviewed reopen.
 */
export async function reconcileOrphanedSessions(options: {
  sessionManager: SessionManager;
  cutoff: number;
  lookbackMs?: number;
}): Promise<ReconciledOrphan[]> {
  const { sessionManager, cutoff } = options;
  const lookbackMs = options.lookbackMs ?? 30 * 24 * 60 * 60 * 1000;
  const sessions = await sessionManager.listSessionsCreatedAfter(Date.now() - lookbackMs, { includeSubagents: true });
  const reconciled: ReconciledOrphan[] = [];
  for (const { session, agentId } of sessions) {
    if (session.status !== 'running') continue;
    if (session.time.updated >= cutoff) continue; // owned by the current live worker
    // Sessions run by a process that is still alive (a terminal `agentuse run`,
    // another daemon's worker) are not orphans, however stale their header.
    // Sessions from older versions carry no owner and keep the cutoff-only rule.
    if (session.owner && isProcessRefAlive(session.owner)) continue;
    await sessionManager.setSessionError(session.id, agentId, {
      code: 'WORKER_INTERRUPTED',
      message: 'Run was interrupted when its serve worker restarted, leaving no live process. If it was waiting on approval, reopen the gate to retry.'
    }).catch(() => {});
    reconciled.push({ sessionId: session.id, agentId, agentName: session.agent.name || session.agent.id });
  }
  return reconciled;
}
