import type { ApprovalSummary } from "./list-payloads";

type ApprovalLister = {
  listApprovals(projectRoot: string): Promise<
    | { success: true; approvals: ApprovalSummary[] }
    | { success: false; error: { message: string } }
  >;
};

/**
 * Find the approval a Slack thread reply belongs to, across every project.
 *
 * Returns undefined only when every project was checked and none matched (the
 * reply is not in an AgentUse thread). If nothing matched but some project
 * could not be checked (no worker, or its lookup failed), it throws instead:
 * the reply may well belong to that project, and the Slack socket turns the
 * throw into a visible failure note rather than silently dropping a
 * reviewer's comment. A match in a reachable project still wins.
 */
export async function findThreadApproval<P extends { id: string; root: string }, W extends ApprovalLister>(
  targets: Array<{ project: P; worker: W | undefined }>,
  matches: (approval: ApprovalSummary) => boolean,
  threadLabel: string,
): Promise<{ project: P; worker: W; approval: ApprovalSummary } | undefined> {
  const unchecked: string[] = [];
  for (const { project, worker } of targets) {
    if (!worker) {
      unchecked.push(`${project.id}: worker not available`);
      continue;
    }
    const result = await worker.listApprovals(project.root);
    if (!result.success) {
      unchecked.push(`${project.id}: ${result.error.message}`);
      continue;
    }
    const approval = result.approvals.find(matches);
    if (approval) return { project, worker, approval };
  }
  if (unchecked.length > 0) {
    throw new Error(`Could not look up ${threadLabel} (${unchecked.join('; ')}). Reply again once AgentUse has recovered.`);
  }
  return undefined;
}
