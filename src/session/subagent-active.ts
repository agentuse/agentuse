/**
 * Shared derivation for the "running · subagent" display state.
 *
 * A manager that delegates a gate-bearing move to a leaf suspends on a
 * `subagent_wait` bookmark and stays raw-status `suspended` for the whole time
 * the leaf runs (see runner/subagent-cascade.ts). Its own status never flips to
 * `running` — only the leaf's does — so every list surface would otherwise show
 * the manager as `suspended`, indistinguishable from a run genuinely parked on a
 * human approval gate.
 *
 * A suspended session is "subagent-active" when a running descendant exists: the
 * run is progressing, the work is just happening in a child. We derive it by
 * walking up from every running session and flagging each suspended ancestor,
 * which stays correct under nested delegation (manager -> mid -> leaf) and needs
 * no part reads — only each row's id/parent/status. A child parked at its OWN
 * gate is `suspended`, not `running`, so it never marks its ancestors: that case
 * stays "awaiting approval" until the gate is decided and the child flips to
 * `running`, at which point the ancestor becomes subagent-active automatically.
 */
export interface SubagentActiveRow {
  sessionId: string;
  parentSessionId?: string;
  status: string;
}

// Bounds the ancestor walk against cyclic/corrupt parent links; matches the
// runner cascade's own MAX_CASCADE_DEPTH.
const MAX_ANCESTOR_DEPTH = 16;

/**
 * Ids of suspended sessions that have a running descendant. Pass the FULL set
 * (parents + subagents); a caller that has already filtered subagents out cannot
 * compute this, since the running leaf is exactly the row that got filtered.
 */
export function computeSubagentActiveIds(rows: SubagentActiveRow[]): Set<string> {
  const byId = new Map<string, SubagentActiveRow>();
  for (const row of rows) byId.set(row.sessionId, row);

  const active = new Set<string>();
  for (const row of rows) {
    if (row.status !== 'running') continue;
    let parentId = row.parentSessionId;
    for (let depth = 0; parentId && depth < MAX_ANCESTOR_DEPTH; depth++) {
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.status === 'suspended') active.add(parent.sessionId);
      parentId = parent.parentSessionId;
    }
  }
  return active;
}
