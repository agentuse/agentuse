import { describe, it, expect } from "bun:test";
import { MAX_INJECTED_LEARNINGS, partitionLearnings, rankLearnings } from "../src/learning/ranking";
import type { Learning } from "../src/learning/types";

/** A reviewer-sourced learning: the fixed 0.95 confidence the evaluator assigns. */
function correction(title: string, date: string): Learning {
  return {
    id: title.replace(/\W/g, "").slice(0, 8),
    category: "warning",
    title,
    instruction: `Correction: ${title}`,
    confidence: 0.95,
    appliedCount: 0,
    extractedAt: date,
    source: "approval",
  };
}

describe("rankLearnings", () => {
  it("keeps explicit human rules ahead of captured ones", () => {
    const ranked = rankLearnings([
      { ...correction("auto", "2026-01-01"), source: "auto", confidence: 0.99 },
      correction("approval", "2026-01-01"),
      { ...correction("manual", "2026-01-01"), source: "manual", confidence: 1 },
    ]);

    expect(ranked.map((l) => l.title)).toEqual(["manual", "approval", "auto"]);
  });

  it("orders equal-signal corrections newest first", () => {
    // Every reviewer correction carries the same 0.95, so without a recency key
    // the comparator ties and file order decides — which is what starved newer
    // corrections behind older ones indefinitely.
    const ranked = rankLearnings([
      correction("oldest", "2026-01-01"),
      correction("newest", "2026-06-01"),
      correction("middle", "2026-03-01"),
    ]);

    expect(ranked.map((l) => l.title)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks a same-day tie toward the later write", () => {
    // Dates persist to day precision, so same-day entries tie on recency. The
    // one written later in the file is the more recent assertion.
    const ranked = rankLearnings([
      correction("first-written", "2026-06-01"),
      correction("last-written", "2026-06-01"),
    ]);

    expect(ranked[0]!.title).toBe("last-written");
  });

  it("sorts a learning with a missing or unparseable date oldest", () => {
    const ranked = rankLearnings([
      correction("legacy-no-date", ""),
      correction("dated", "2020-01-01"),
    ]);

    expect(ranked.map((l) => l.title)).toEqual(["dated", "legacy-no-date"]);
  });

  it("does not mutate the input array", () => {
    const input = [correction("a", "2026-01-01"), correction("b", "2026-06-01")];
    rankLearnings(input);
    expect(input.map((l) => l.title)).toEqual(["a", "b"]);
  });
});

describe("partitionLearnings", () => {
  it("reports everything past the cap as dormant", () => {
    const many = Array.from({ length: MAX_INJECTED_LEARNINGS + 7 }, (_, i) =>
      correction(`c${i}`, `2026-01-${String(i + 1).padStart(2, "0")}`));

    const { injected, dormant } = partitionLearnings(many);

    expect(injected).toHaveLength(MAX_INJECTED_LEARNINGS);
    expect(dormant).toHaveLength(7);
    expect(injected.length + dormant.length).toBe(many.length);
  });

  it("puts a brand new correction in force, displacing the oldest", () => {
    // The regression this fixes: on a full file, a fresh reviewer correction used
    // to land behind every existing one and never reach the model.
    const existing = Array.from({ length: MAX_INJECTED_LEARNINGS }, (_, i) =>
      correction(`old-${i}`, `2026-01-${String(i + 1).padStart(2, "0")}`));
    const fresh = correction("just-corrected", "2026-07-28");

    const { injected, dormant } = partitionLearnings([...existing, fresh]);

    expect(injected.map((l) => l.title)).toContain("just-corrected");
    expect(dormant.map((l) => l.title)).toEqual(["old-0"]);
  });

  it("still lets manual rules crowd out captured corrections", () => {
    // Honest about the remaining limit: recency bounds staleness, it does not
    // create room. Enough manual rules and captured corrections go dormant.
    const manuals = Array.from({ length: MAX_INJECTED_LEARNINGS }, (_, i) => ({
      ...correction(`manual-${i}`, "2026-01-01"),
      source: "manual" as const,
      confidence: 1,
    }));

    const { injected, dormant } = partitionLearnings([...manuals, correction("recent-fix", "2026-07-28")]);

    expect(injected.every((l) => l.source === "manual")).toBe(true);
    expect(dormant.map((l) => l.title)).toEqual(["recent-fix"]);
  });

  it("honours an explicit cap", () => {
    const three = [correction("a", "2026-01-01"), correction("b", "2026-02-01"), correction("c", "2026-03-01")];
    const { injected, dormant } = partitionLearnings(three, 1);
    expect(injected.map((l) => l.title)).toEqual(["c"]);
    expect(dormant).toHaveLength(2);
  });
});
