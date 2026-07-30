import { describe, it, expect } from "bun:test";
import { isHumanGateDecision } from "../src/runner/session-helper";

// Learning capture treats a gate comment as a human correction and stores it at
// confidence 0.95, above anything the agent concluded on its own. Several
// non-human writers resolve `await_human` parts with the same shape, so this
// predicate is the only thing keeping the runtime from teaching itself.
describe("isHumanGateDecision", () => {
  it("accepts a real reviewer's decision", () => {
    expect(isHumanGateDecision({ status: "comment", comment: "Don't lecture", reviewer: { username: "web" } })).toBe(true);
    expect(isHumanGateDecision({ status: "approve" })).toBe(true);
  });

  it("rejects the pre-review judge", () => {
    expect(isHumanGateDecision({ status: "reject", comment: "Echoes the OP", source: "pre-review" })).toBe(false);
    expect(isHumanGateDecision({ status: "reject", comment: "Echoes the OP", reviewer: { username: "verify-judge" } })).toBe(false);
  });

  it("rejects gate preflight and the runtime itself", () => {
    expect(isHumanGateDecision({ status: "comment", comment: "Gate plan invalid", source: "gate-preflight" })).toBe(false);
    expect(isHumanGateDecision({ status: "comment", comment: "internal", reviewer: { name: "agentuse-runtime" } })).toBe(false);
  });

  it("rejects a non-object output rather than defaulting to human", () => {
    expect(isHumanGateDecision(undefined)).toBe(false);
    expect(isHumanGateDecision(null)).toBe(false);
    expect(isHumanGateDecision("approve")).toBe(false);
  });
});
