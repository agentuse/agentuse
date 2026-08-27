export interface ApprovalBucketsPayload {
  buckets?: {
    pending?: unknown;
  };
}

export function pendingApprovalCount(payload: ApprovalBucketsPayload): number | undefined {
  return Array.isArray(payload.buckets?.pending) ? payload.buckets.pending.length : undefined;
}

export function pendingApprovalTitle(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

export function pendingApprovalTooltip(count: number): string {
  if (count <= 0) return "AgentUse";
  return `AgentUse — ${count} pending approval${count === 1 ? "" : "s"}`;
}
