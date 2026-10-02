import { LeaseStore, deriveLeaseEntries } from './approval-lease';
import { GateSealStore } from './gate-seal';

/**
 * Durable side effects of a reviewer decision on an `await_human` gate, shared
 * by the real resume path (resume.ts) and the mocked-approval path
 * (execution.ts, `--mock-approval`):
 *
 * - approve: derive a lease from the gate's `changes[]` and grant it,
 *   REPLACING any prior lease (the latest approved plan is the only active
 *   grant). An approve with no derivable entries revokes instead: approval of
 *   a plan without verbatim commands authorizes nothing.
 * - comment: revoke. This is the revise-and-re-gate path; nothing gated may
 *   run until a fresh plan is approved. Deliberately does NOT seal.
 * - reject: revoke AND seal the gate. Reject is terminal for the run: it may
 *   still finish its own cleanup, but it can never re-ask the human.
 *
 * Decision payloads carry either spelling depending on surface: the CLI sends
 * 'approve'/'reject', Slack/serve send 'approved'/'rejected'. Both must apply
 * identically.
 */
export function applyGateDecisionEffects(options: {
  leaseStore: LeaseStore;
  gateSealStore: GateSealStore;
  status: unknown;
  choice?: unknown;
  gateInput: unknown;
  now: number;
  sealReason: string;
}): void {
  const { leaseStore, gateSealStore, status, choice, gateInput, now, sealReason } = options;
  if (status === 'approved' || status === 'approve') {
    const entries = deriveLeaseEntries(gateInput, choice);
    if (entries.length > 0) {
      leaseStore.grant({ version: 1, grantedAt: now, entries });
    } else {
      leaseStore.revoke();
    }
    return;
  }
  leaseStore.revoke();
  if (status === 'rejected' || status === 'reject') {
    gateSealStore.seal(sealReason, now);
  }
}

/** What a reviewer decision is checked against: the gate's kind, its
 * selectable options, and whether strict review escalated it. */
export interface GateDecisionTarget {
  approvalKind?: 'await_human' | 'tool_approval' | undefined;
  options?: ReadonlyArray<{ id: string }> | undefined;
  reviewEscalation?: unknown;
}

export interface GateDecisionError {
  code: string;
  message: string;
}

const GATE_DECISION_STATUSES = new Set(['approve', 'approved', 'reject', 'rejected', 'comment', 'commented']);

/**
 * The one validity check for a reviewer decision, shared by every surface that
 * can resolve a gate: the serve routes call it for an early 4xx, and core
 * resume (applyResumeToolResult) calls it for every await_human decision, so
 * the CLI, the legacy resume route, the worker and the cascade cannot accept a
 * decision serve would refuse. The mocked reviewer is held to it too.
 *
 * Both spellings ('approve' and 'approved') are an approval and must validate
 * identically. A strict-review escalation can be commented on or rejected,
 * never approved. A choice is only valid with an approve and must name one of
 * the gate's options; an approve on an option gate must carry one, or the
 * lease would cover every option's commands.
 */
export function validateGateDecision(
  gate: GateDecisionTarget,
  decision: { status: unknown; choice?: unknown },
): GateDecisionError | null {
  const { status, choice } = decision;
  if (gate.approvalKind === 'tool_approval') {
    const supported = status === 'approve' || status === 'approved'
      || status === 'reject' || status === 'rejected';
    if (!supported) {
      return { code: 'TOOL_APPROVAL_DECISION_INVALID', message: 'Generic tool approvals support only approve or reject' };
    }
    if (choice !== undefined) {
      return { code: 'CHOICE_INVALID', message: 'Generic tool approvals do not accept option choices' };
    }
    return null;
  }
  if (typeof status !== 'string' || !GATE_DECISION_STATUSES.has(status)) {
    return { code: 'DECISION_INVALID', message: 'Approval decisions must be approve, reject, or comment' };
  }
  const isApprove = status === 'approve' || status === 'approved';
  if (isApprove && gate.reviewEscalation) {
    return {
      code: 'REVIEW_REVISION_REQUIRED',
      message: 'This draft did not pass strict automated review. Send revision guidance or reject it; it cannot be approved in its current form.',
    };
  }
  if (choice !== undefined) {
    if (!isApprove) {
      return { code: 'CHOICE_REQUIRES_APPROVE', message: 'A choice can only be submitted with an approve decision' };
    }
    if (!gate.options?.some((option) => option.id === choice)) {
      return { code: 'CHOICE_INVALID', message: `Choice "${String(choice)}" is not one of this gate's options` };
    }
    return null;
  }
  if (isApprove && gate.options && gate.options.length > 0) {
    return { code: 'CHOICE_REQUIRED', message: 'This gate offers options; approve decisions must include a choice (option id)' };
  }
  return null;
}

/** The decision target of an await_human gate from its own input: its option
 * ids, and the strict-review escalation recorded when it suspended (if any). */
export function awaitHumanDecisionTarget(gateInput: unknown, reviewEscalation: unknown): GateDecisionTarget {
  const rawOptions = gateInput && typeof gateInput === 'object'
    ? (gateInput as { options?: unknown }).options
    : undefined;
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap((option) => {
        const id = option && typeof option === 'object' ? (option as { id?: unknown }).id : undefined;
        return typeof id === 'string' && id.trim() ? [{ id: id.trim() }] : [];
      })
    : [];
  return {
    approvalKind: 'await_human',
    ...(options.length > 0 && { options }),
    ...(reviewEscalation && typeof reviewEscalation === 'object' ? { reviewEscalation } : {}),
  };
}
