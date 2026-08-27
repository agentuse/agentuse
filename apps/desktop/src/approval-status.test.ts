import { describe, expect, test } from "bun:test";
import { pendingApprovalCount, pendingApprovalTitle, pendingApprovalTooltip } from "./approval-status";

describe("pending approval menu bar state", () => {
  test("reads the canonical pending bucket", () => {
    expect(pendingApprovalCount({ buckets: { pending: [{}, {}, {}] } })).toBe(3);
    expect(pendingApprovalCount({ buckets: { pending: [] } })).toBe(0);
    expect(pendingApprovalCount({})).toBeUndefined();
  });

  test("shows a compact title only when action is required", () => {
    expect(pendingApprovalTitle(0)).toBe("");
    expect(pendingApprovalTitle(7)).toBe("7");
    expect(pendingApprovalTitle(100)).toBe("99+");
  });

  test("uses a readable singular or plural tooltip", () => {
    expect(pendingApprovalTooltip(0)).toBe("AgentUse");
    expect(pendingApprovalTooltip(1)).toBe("AgentUse — 1 pending approval");
    expect(pendingApprovalTooltip(2)).toBe("AgentUse — 2 pending approvals");
  });
});
