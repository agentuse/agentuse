import type { SessionManager } from '../session';
import type { SessionInfo, ToolState } from '../session/types';
import { isProcessRefAliveAsync } from '../utils/process-info';
import { LeaseStore, type ApprovalLease } from './approval-lease';
import { GateSealStore, type GateSealSnapshot } from './gate-seal';
import { applyGateDecisionEffects } from './gate-decision';
import {
  loadSessionPartsFlat,
  findPendingSubagentWaitChildId,
  findStaleCascadeChild,
  describeStaleCascade,
  isFinishableStale,
  CASCADE_ORPHANED_CODE,
} from './subagent-cascade';
import { logger } from '../utils/logger';
import { join } from 'node:path';
import { withOwnershipLock } from '../utils/ownership-lock';

export interface ResumeToolRollback {
  sessionId: string;
  agentId: string;
  messageId: string;
  partId: string;
  state: ToolState;
  decisionEffects?: {
    sessionDir: string;
    lease?: ApprovalLease;
    seal: GateSealSnapshot;
  };
}

export async function applyResumeToolResult(options: {
  sessionManager: SessionManager;
  sessionId: string;
  toolResult: unknown;
  resumeToken?: string;
  skipTokenValidation?: boolean;
}): Promise<{ agentId: string; agentFilePath?: string; rollback?: ResumeToolRollback }> {
  const initial = await options.sessionManager.findSession(options.sessionId);
  if (!initial) {
    throw new Error(`SESSION_NOT_FOUND: ${options.sessionId}`);
  }

  // The durable lock is inside the resolved session directory, so every serve
  // worker/CLI process contends on the same claim. Keep support for narrow unit
  // doubles that implement only the methods exercised by the state transition;
  // every real SessionManager exposes getSessionDirectory.
  const getSessionDirectory = (options.sessionManager as SessionManager & {
    getSessionDirectory?: (sessionId: string, agentId: string) => Promise<string>;
  }).getSessionDirectory;
  if (!getSessionDirectory) {
    return applyClaimedResumeToolResult(options);
  }
  const sessionDir = await getSessionDirectory.call(
    options.sessionManager,
    options.sessionId,
    initial.agentId
  );
  return withOwnershipLock(
    join(sessionDir, '.resume-claim'),
    () => applyClaimedResumeToolResult(options),
    {
      staleMs: 30_000,
      retryMs: 10,
      maxWaitMs: 35_000,
      label: `resume:${options.sessionId}`,
    }
  );
}

async function applyClaimedResumeToolResult(options: {
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

  // A `subagent_wait` bookmark is a manager's parked `subagent__*` step, not a human
  // gate: it carries no resumeToken, so token validation below would wave the write
  // through and stamp the reviewer's decision object in as the SUB-AGENT'S OUTPUT,
  // then resume the manager on that garbage. The only legitimate way to complete one
  // is the cascade's completeSubagentBookmark (with the child's real result), so
  // anything reaching here is a broken chain — the child ended without its ancestors
  // being resumed. Fail loud with a diagnosable code instead.
  if (
    pending.part.state.status === 'pending' &&
    pending.part.state.resumePayload?.kind === 'subagent_wait'
  ) {
    throw new Error(
      `CASCADE_GATE_UNRESOLVABLE: session ${sessionId} is parked on delegated sub-agent ` +
      `${pending.part.state.resumePayload.childSessionID ?? '(unknown)'}, which is no longer ` +
      `holding a live approval gate. There is nothing left to decide on this run; stop it and re-run the agent.`
    );
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

  // Verify the decision actually landed before the run proceeds. A write that
  // silently missed (wrong resolved path for a nested session) leaves the gate
  // pending in the resumed message history — the model then sees a dangling
  // tool call and the AI SDK throws MissingToolResultError AFTER the reviewer
  // already spent their decision. Failing here instead keeps the gate intact
  // and surfaces a diagnosable error to the approval surface.
  const applied = await sessionManager.getPart(sessionId, found.agentId, pending.message.id, pending.part.id);
  if (!applied || (applied as { state?: { status?: string } }).state?.status !== 'completed') {
    throw new Error(`DECISION_NOT_PERSISTED: approval decision for session ${sessionId} did not persist to the gate part (${pending.part.id}); resume aborted before the run`);
  }

  // Lease lifecycle (agentuse-lab#165, Phase 2): an APPROVE derives a
  // machine-readable lease from the gate's changes[] - the only grant that
  // lets `tools.bash.gated`-declared commands run. Any other decision (reject,
  // comment) revokes, and reject additionally seals the gate - see
  // applyGateDecisionEffects for the full lifecycle. Only a human reject
  // reaches here: the verify pre-review rejection is returned inline without
  // suspending, so it never resumes. Best-effort: a lease failure must not
  // block the resume, it just means gated commands stay denied.
  try {
    const sessionDir = await sessionManager.getSessionDirectory(sessionId, found.agentId);
    const leaseStore = new LeaseStore(sessionDir);
    const gateSealStore = new GateSealStore(sessionDir);
    const priorLease = leaseStore.read();
    const priorSeal = gateSealStore.snapshot();
    rollback.decisionEffects = { sessionDir, seal: priorSeal };
    if (priorLease) rollback.decisionEffects.lease = priorLease;
    const decisionStatus = toolResult && typeof toolResult === 'object'
      ? (toolResult as { status?: unknown }).status
      : undefined;
    const decisionChoice = toolResult && typeof toolResult === 'object'
      ? (toolResult as { choice?: unknown }).choice
      : undefined;
    applyGateDecisionEffects({
      leaseStore,
      gateSealStore,
      status: decisionStatus,
      choice: decisionChoice,
      gateInput: input,
      now,
      sealReason: 'human reviewer rejected an await_human gate',
    });
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

  // Restore authorization state before making the approval pending again. A
  // pending gate must never be visible with the reject seal or approval lease
  // from the failed preflight attempt still in force.
  if (rollback.decisionEffects) {
    const leaseStore = new LeaseStore(rollback.decisionEffects.sessionDir);
    const leaseRestored = rollback.decisionEffects.lease
      ? leaseStore.grant(rollback.decisionEffects.lease)
      : leaseStore.revoke();
    const sealRestored = new GateSealStore(rollback.decisionEffects.sessionDir)
      .restoreSnapshot(rollback.decisionEffects.seal);
    if (!leaseRestored || !sealRestored) {
      throw new Error('Failed to restore approval authorization state; gate remains resolved');
    }
  }

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
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'SESSION_PREPARING' | 'SESSION_RUNNING' | 'ALREADY_SUSPENDED' | 'NO_REOPENABLE_GATE'; message: string };

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
 *
 * Rewinding the gate part alone is not enough: everything the abandoned attempt
 * recorded AFTER the gate (its tool calls and its closing report) is still in
 * the part log, and the context snapshot is the pre-gate one, so `rehydrate`
 * would replay that whole tail and hand the provider a history ending on the
 * assistant's final message — an accidental prefill, which Anthropic rejects
 * outright on models that disallow it (HTTP 400 "does not support assistant
 * message prefill"), and which asks the model to continue its own sign-off on
 * models that allow it. So mark the tail `superseded`: it stays visible in the
 * session log, but the retry replays from the gate.
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
  if (found.session.status === 'preparing' || found.session.status === 'running') {
    return {
      ok: false,
      code: found.session.status === 'preparing' ? 'SESSION_PREPARING' : 'SESSION_RUNNING',
      message: `Session ${sessionId} is still ${found.session.status}`,
    };
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

  // Retire the abandoned attempt's tail. `parts` is ordered (getPartOrder, then
  // ULID), so everything after the gate's index is what the resumed run
  // produced. Only text/tool parts feed the model history (rehydrate ignores
  // the rest), so only those need the flag.
  const gateIndex = parts.findIndex((part) => part.id === target.part.id);
  for (const part of parts.slice(gateIndex + 1)) {
    if (part.type !== 'text' && part.type !== 'tool') continue;
    if (part.superseded) continue;
    // Deliberately not best-effort: a half-rewound tail is exactly the broken
    // history this function exists to prevent, so surface the failure.
    await sessionManager.updatePart(sessionId, found.agentId, message.id, part.id, { superseded: true });
  }

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
  /** 'interrupted': killed mid-run. 'stranded': parked on a child that ended
   *  with nothing to fold in (error/missing) — marked terminal. 'finishable':
   *  parked on a child whose durable result can still complete the chain — NOT
   *  marked; the caller drives a finish-cascade run instead. */
  reason: 'interrupted' | 'stranded' | 'finishable';
}

/** Bounds the probe cache below; entries are tiny, and a daemon serving more
 *  parked sessions than this simply falls back to re-walking the overflow. */
const PENDING_CHILD_CACHE_LIMIT = 5_000;
const pendingChildCache = new Map<string, { updated: number; childId: string | null }>();

/**
 * The child a suspended session is parked on, or null when it isn't parked on
 * one. Walking every message and part of the session is the expensive half of
 * the cascade sweep, and it runs on every parked session every pass — so the
 * answer is memoized against `time.updated`: a parked session writes nothing, so
 * an unchanged stamp means the parts are byte-identical to the last walk.
 */
async function pendingSubagentWaitChildId(
  sessionManager: SessionManager,
  session: SessionInfo,
  agentId: string
): Promise<string | null> {
  const cached = pendingChildCache.get(session.id);
  if (cached && cached.updated === session.time.updated) return cached.childId;

  const parts = await loadSessionPartsFlat(sessionManager, session.id, agentId);
  const childId = findPendingSubagentWaitChildId(parts) ?? null;

  if (!cached && pendingChildCache.size >= PENDING_CHILD_CACHE_LIMIT) {
    const oldest = pendingChildCache.keys().next();
    if (!oldest.done) pendingChildCache.delete(oldest.value);
  }
  pendingChildCache.set(session.id, { updated: session.time.updated, childId });
  return childId;
}

/**
 * Recover sessions a dead worker left stuck as 'running' with no live process,
 * then the ancestors those deaths stranded.
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
 * recorded owner process is gone is orphaned. The same rule terminates a
 * `preparing` shell whose host died before it could dispatch model execution.
 * The owner probe matters because
 * the storage is shared by every process serving the project (a terminal
 * `agentuse run`, a second daemon with a different data dir) and a live run
 * rewrites its session file only on status changes — a stale header alone does
 * not prove the run is dead. Flip each orphan to a terminal
 * WORKER_INTERRUPTED error so reopenSuspendedGate becomes reachable. It never
 * auto-replays the run — a mutation agent could double-fire an external side
 * effect — so recovery stays an explicit, human-reviewed reopen.
 *
 * A manager that delegated to that leaf is collateral damage: it parked its
 * `subagent__*` step on the child and stays `suspended`, and only the child's
 * own resume can ever complete that bookmark. Killing the child therefore
 * strands the whole chain above it, silently — so the second pass sweeps the
 * ancestors the first pass just widowed (plus any stranded earlier, e.g. by a
 * leaf that ended on report_incomplete before that path was fixed) and marks
 * them CASCADE_ORPHANED. Same doctrine as above: mark terminal, never replay.
 */
export async function reconcileOrphanedSessions(options: {
  sessionManager: SessionManager;
  cutoff: number;
  lookbackMs?: number;
  /** Report what would be reconciled without writing anything. */
  dryRun?: boolean;
}): Promise<ReconciledOrphan[]> {
  const { sessionManager, cutoff, dryRun = false } = options;
  const lookbackMs = options.lookbackMs ?? 30 * 24 * 60 * 60 * 1000;
  const sessions = await sessionManager.listReconcileCandidatesCreatedAfter(Date.now() - lookbackMs);
  const reconciled: ReconciledOrphan[] = [];
  // Pass 1: runs killed mid-flight.
  for (const { session, agentId } of sessions) {
    if (session.status === 'preparing') {
      if (session.time.updated >= cutoff) continue;
      if (session.owner && await isProcessRefAliveAsync(session.owner)) continue;
      if (!dryRun) {
        await sessionManager.setSessionError(session.id, agentId, {
          code: 'PREPARATION_INTERRUPTED',
          message: 'Session preparation was interrupted before model execution started.'
        }).catch(() => {});
      }
      reconciled.push({ sessionId: session.id, agentId, agentName: session.agent.name || session.agent.id, reason: 'interrupted' });
      continue;
    }
    if (session.status !== 'running') continue;
    if (session.time.updated >= cutoff) continue; // owned by the current live worker
    // Sessions run by a process that is still alive (a terminal `agentuse run`,
    // another daemon's worker) are not orphans, however stale their header.
    // Sessions from older versions carry no owner and keep the cutoff-only rule.
    if (session.owner && await isProcessRefAliveAsync(session.owner)) continue;
    if (!dryRun) {
      await sessionManager.setSessionError(session.id, agentId, {
        code: 'WORKER_INTERRUPTED',
        message: 'Run was interrupted when its serve worker restarted, leaving no live process. If it was waiting on approval, reopen the gate to retry.'
      }).catch(() => {});
    }
    reconciled.push({ sessionId: session.id, agentId, agentName: session.agent.name || session.agent.id, reason: 'interrupted' });
  }

  // Pass 2: ancestors left holding a bookmark on a child that has ended. Runs
  // after pass 1 so a leaf just marked WORKER_INTERRUPTED already reads
  // terminal. findStaleCascadeChild re-reads each child, so the stale statuses
  // in the snapshot above don't matter — and it returns null while a descendant
  // is still running or a live gate is waiting, which is what keeps a healthy
  // mid-flight manager (or one genuinely parked on a human) untouched.
  for (const { session, agentId } of sessions) {
    if (session.status !== 'suspended') continue;
    // A live process may be mid-cascade right now: between the child ending and
    // the parent's bookmark being completed, a healthy chain looks exactly like
    // a stranded one. Its owner being alive is the only distinguishing signal.
    if (session.owner && await isProcessRefAliveAsync(session.owner)) continue;
    let stale: Awaited<ReturnType<typeof findStaleCascadeChild>> = null;
    try {
      const childId = await pendingSubagentWaitChildId(sessionManager, session, agentId);
      if (!childId) continue;
      stale = await findStaleCascadeChild(sessionManager, childId);
    } catch (error) {
      logger.debug(`[Reconcile] Cascade probe failed for ${session.id}: ${(error as Error).message}`);
      continue;
    }
    if (!stale) continue;
    // A child that ended holding a durable result is not a dead end: the
    // parent's bookmark can be completed from storage and the chain resumed
    // (issue #199). Report it WITHOUT stamping a terminal error so the caller
    // can drive a finish-cascade run. Only the topmost stranded ancestor is
    // reported — the walk-up it triggers resumes every level below it, so
    // reporting intermediates too would double-drive the same chain.
    if (isFinishableStale(stale)) {
      const parentId = (session as { parentSessionID?: string }).parentSessionID;
      if (typeof parentId === 'string' && parentId.length > 0) continue;
      reconciled.push({ sessionId: session.id, agentId, agentName: session.agent.name || session.agent.id, reason: 'finishable' });
      continue;
    }
    if (!dryRun) {
      await sessionManager.setSessionError(session.id, agentId, {
        code: CASCADE_ORPHANED_CODE,
        message: describeStaleCascade(stale),
      }).catch(() => {});
    }
    reconciled.push({ sessionId: session.id, agentId, agentName: session.agent.name || session.agent.id, reason: 'stranded' });
  }
  return reconciled;
}
