import { LeaseStore, deriveLeaseEntries } from './approval-lease';
import { GateSealStore } from './gate-seal';

/**
 * Durable side effects of a reviewer decision on an `await_human` gate, shared
 * by the real resume path (resume.ts) and the mocked-approval path
 * (execution.ts, `--mock-approval`):
 *
 * - approve: derive a lease from the gate's `changes[]` and grant it,
 *   REPLACING any prior lease (the latest approved plan is the only active
 *   grant). An approve with no derivable entries revokes instead — approval of
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
  gateInput: unknown;
  now: number;
  sealReason: string;
}): void {
  const { leaseStore, gateSealStore, status, gateInput, now, sealReason } = options;
  if (status === 'approved' || status === 'approve') {
    const entries = deriveLeaseEntries(gateInput);
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
