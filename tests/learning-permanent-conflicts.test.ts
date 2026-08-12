import { describe, expect, test } from "bun:test";
import { buildBlockRewritePrompt, validateBlockRewrite } from "../src/learning/consolidate";
import { LEARNED_BLOCK_START, LEARNED_BLOCK_END } from "../src/learning/graduate";
import type { PermanentRule } from "../src/learning/graduate";

const rules: PermanentRule[] = [
  { category: "pattern", instruction: "Open every reply by accepting the author's point." },
  { category: "warning", instruction: "Never name a benchmark you cannot cite." },
];

describe("showing the rewrite pass what the rules sit beside", () => {
  test("includes the agent body so a rule can be read against it", () => {
    const prompt = buildBlockRewritePrompt(rules, 0, "The first sentence must carry the new thing.");
    expect(prompt).toContain("The first sentence must carry the new thing.");
    expect(prompt).toContain("They OUTRANK every rule above at run time");
  });

  test("omits the block from the body, so a rule is not matched against itself", () => {
    const body = [
      "Draft one reply.",
      LEARNED_BLOCK_START,
      "## Learned Guidelines",
      "- [pattern] Open every reply by accepting the author's point.",
      LEARNED_BLOCK_END,
    ].join("\n");

    const prompt = buildBlockRewritePrompt(rules, 0, body);
    // The instruction appears once, as rule 0 — not a second time via the body.
    const occurrences = prompt.split("Open every reply by accepting the author's point.").length - 1;
    expect(occurrences).toBe(1);
    expect(prompt).toContain("Draft one reply.");
  });

  test("carries a word count per rule, so one long rule is visible as a problem", () => {
    const prompt = buildBlockRewritePrompt(rules, 0);
    expect(prompt).toContain("(8 words)");
  });

  test("says nothing about a body it was not given", () => {
    const prompt = buildBlockRewritePrompt(rules, 0);
    expect(prompt).not.toContain("The agent's own instructions, for comparison");
  });
});

describe("reporting a permanent rule the body contradicts", () => {
  const kept = { rules: [{ category: "pattern", instruction: rules[0]!.instruction, covers: [0] }, { category: "warning", instruction: rules[1]!.instruction, covers: [1] }] };

  test("passes a conflict through with the body text that collides", () => {
    const checked = validateBlockRewrite(
      {
        ...kept,
        conflicts: [{ index: 0, bodySays: "An echo lead is an auto-reject.", why: "rule requires an accepting opener; body rejects one" }],
      },
      rules,
    );
    expect("rejected" in checked).toBe(false);
    if ("rejected" in checked) return;
    expect(checked.conflicts).toHaveLength(1);
    expect(checked.conflicts[0]!.instruction).toBe(rules[0]!.instruction);
    expect(checked.conflicts[0]!.bodySays).toBe("An echo lead is an auto-reject.");
  });

  test("keeps the contradicted rule rather than dropping it", () => {
    const checked = validateBlockRewrite(
      { ...kept, conflicts: [{ index: 0, bodySays: "x", why: "y" }] },
      rules,
    );
    if ("rejected" in checked) throw new Error("unexpectedly rejected");
    expect(checked.rules.map((r) => r.instruction)).toContain(rules[0]!.instruction);
    expect(checked.dropped).toHaveLength(0);
  });

  test("skips a malformed conflict instead of failing the whole rewrite", () => {
    const checked = validateBlockRewrite(
      {
        ...kept,
        conflicts: [
          { index: 99, why: "out of range" },
          { index: 0, why: "   " },
          { index: 1, why: "real one" },
        ],
      },
      rules,
    );
    if ("rejected" in checked) throw new Error("unexpectedly rejected");
    expect(checked.conflicts).toHaveLength(1);
    expect(checked.conflicts[0]!.why).toBe("real one");
  });

  test("reports none when the model finds none", () => {
    const checked = validateBlockRewrite(kept, rules);
    if ("rejected" in checked) throw new Error("unexpectedly rejected");
    expect(checked.conflicts).toEqual([]);
  });
});
