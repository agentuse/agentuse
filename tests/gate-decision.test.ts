import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyGateDecisionEffects } from "../src/runner/gate-decision";
import { LeaseStore, LEASE_FILENAME } from "../src/runner/approval-lease";
import { GateSealStore, GATE_SEAL_FILENAME } from "../src/runner/gate-seal";

let dir: string;
let leaseStore: LeaseStore;
let gateSealStore: GateSealStore;

const gateInput = {
  prompt: "Push the release?",
  changes: [{ label: "Push", content: "git push origin main" }],
};

function apply(status: unknown, input: unknown = gateInput) {
  applyGateDecisionEffects({
    leaseStore,
    gateSealStore,
    status,
    gateInput: input,
    now: 1234,
    sealReason: "test reject",
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-decision-"));
  leaseStore = new LeaseStore(dir);
  gateSealStore = new GateSealStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("applyGateDecisionEffects", () => {
  it("approve grants a lease derived from changes[] (both status spellings)", () => {
    for (const status of ["approved", "approve"]) {
      apply(status);
      expect(leaseStore.isCovered("git push origin main")).toBe(true);
      expect(gateSealStore.isSealed()).toBe(false);
      leaseStore.revoke();
    }
  });

  it("approve REPLACES a prior lease rather than accumulating", () => {
    apply("approved");
    apply("approved", { changes: [{ content: "npm publish" }] });
    expect(leaseStore.isCovered("npm publish")).toBe(true);
    expect(leaseStore.isCovered("git push origin main")).toBe(false);
  });

  it("approve with no derivable entries revokes instead of granting", () => {
    apply("approved");
    apply("approved", { prompt: "just a question" });
    expect(fs.existsSync(path.join(dir, LEASE_FILENAME))).toBe(false);
  });

  it("comment revokes without sealing", () => {
    apply("approved");
    apply("commented");
    expect(leaseStore.isCovered("git push origin main")).toBe(false);
    expect(gateSealStore.isSealed()).toBe(false);
  });

  it("reject revokes and seals (both status spellings)", () => {
    for (const status of ["rejected", "reject"]) {
      apply("approved");
      apply(status);
      expect(leaseStore.isCovered("git push origin main")).toBe(false);
      expect(gateSealStore.isSealed()).toBe(true);
      fs.rmSync(path.join(dir, GATE_SEAL_FILENAME), { force: true });
    }
  });
});
