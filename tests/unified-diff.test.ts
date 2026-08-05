import { describe, it, expect } from "bun:test";
import { unifiedDiff } from "../src/utils/diff";

describe("unifiedDiff", () => {
  it("returns nothing for identical text, so callers can skip showing a diff", () => {
    expect(unifiedDiff("same\ntext\n", "same\ntext\n")).toBe("");
  });

  it("marks added and removed lines and keeps surrounding context", () => {
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nb\nCHANGED\nd\ne\n";

    const diff = unifiedDiff(before, after);

    expect(diff).toContain("-c");
    expect(diff).toContain("+CHANGED");
    expect(diff).toContain(" b");
    expect(diff).toContain(" d");
  });

  it("labels the file and splits distant changes into separate hunks", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 2", "changed 2").replace("line 35", "changed 35");

    const diff = unifiedDiff(before, after, { label: "/tmp/agent.agentuse" });

    expect(diff.startsWith("--- /tmp/agent.agentuse")).toBe(true);
    // Two changes 30 lines apart must not be joined into one hunk carrying the
    // whole file: the point of the diff is to show only what moved.
    expect(diff.split("@@").length - 1).toBe(4); // two hunks, two markers each
    expect(diff).not.toContain(" line 20");
  });
});
