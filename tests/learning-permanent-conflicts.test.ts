import { describe, expect, test } from "bun:test";
import { buildBlockRewritePrompt, buildCompressPrompt, buildMergeAuditPrompt, validateBlockRewrite, validateDecisions } from "../src/learning/consolidate";
import type { Learning } from "../src/learning/types";
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

  // The bug this guards: a cut body does not weaken the answer, it deletes the
  // question. Everything past the cut comes back "no contradiction" whatever it
  // says. Measured at a 12,000-character cut on a 34,181-character body: two of
  // four known contradictions sat past it and were reported absent.
  test("sends a real agent body whole, however far in the rule it collides with sits", () => {
    const filler = "Draft one reply per run. ".repeat(1400); // ~35k characters
    const deep = "The FIRST sentence must already carry the new thing.";
    const prompt = buildBlockRewritePrompt(rules, 0, `${filler}\n${deep}`);
    expect(prompt).toContain(deep);
  });
});

// Measured cause of the 2.5% saving: the rewrite was allowed to cut a passage
// the body already states, and the audit then read every such cut as a dropped
// instruction and restored the original. Both halves have to know about the
// body or the largest available saving is unreachable.
describe("cutting a passage the body already states", () => {
  test("the rewrite is told it may cut inside a rule, not only drop a whole one", () => {
    const prompt = buildBlockRewritePrompt(rules, 0, "Put the target URL in the gate.");
    expect(prompt).toContain("A passage inside a rule that the body already states");
    expect(prompt).toContain("not merely the same subject");
  });

  test("the audit sees the body, so a cut it covers is not counted as missing", () => {
    const prompt = buildMergeAuditPrompt(rules, "one merged rule", "Put the target URL in the gate.");
    expect(prompt).toContain("Put the target URL in the gate.");
    expect(prompt).toContain("dropping something the body already states is fine");
  });

  test("the audit holds coverage to the instruction, not the topic", () => {
    const prompt = buildMergeAuditPrompt(rules, "merged", "gate the reply");
    expect(prompt).toContain("does not cover a source that says which fields the gate must carry");
  });

  test("the audit says nothing about a body it was not given", () => {
    const prompt = buildMergeAuditPrompt(rules, "merged");
    expect(prompt).not.toContain("THE AGENT'S OWN INSTRUCTIONS");
  });
});

// Measured: 53 of 272 learnings carry 3+ quoted examples and hold 53% of the
// corpus. One of them illustrates "light register" nine times for one rule. The
// two prompts disagreed on this — the rewrite called every worked example
// load-bearing while the audit called removed repetition the point of the
// rewrite — and the stricter one governed what was proposed.
// The staging path had no size-triggered move at all. `rewrite` fires only when
// a human REPEATS a correction, and deliberately makes it more specific;
// `merge` fires only when two say the same thing. A learning captured once,
// applied often and never repeated was never revisited, at any length.
// Measured: 267 of 272 learnings live in staging, holding ~40k of the 43k words.
describe("compressing an over-long staged learning", () => {
  const staged: Learning = {
    id: "uv12wx34",
    category: "warning",
    title: "Every slate needs a light candidate",
    instruction: "Long text. ".repeat(200),
    source: "approval",
    confidence: 0.9,
    appliedCount: 8,
    approvedRuns: 3,
    reasserted: 0,
    extractedAt: "2026-08-01T00:00:00.000Z",
    state: "active",
  };
  const NOW = Date.parse("2026-08-12T00:00:00.000Z");

  test("the plan accepts a compress move", () => {
    const plan = validateDecisions({ compress: [{ id: "uv12wx34", why: "620 words for one rule" }] }, [staged], NOW);
    expect(plan.compresses).toHaveLength(1);
    expect(plan.compresses[0]!.target.id).toBe("uv12wx34");
    expect(plan.rejected).toHaveLength(0);
  });

  test("an id already used by another move cannot also be compressed", () => {
    const old = { ...staged, extractedAt: "2026-01-01T00:00:00.000Z" };
    const plan = validateDecisions(
      { retire: [{ id: "uv12wx34", why: "superseded" }], compress: [{ id: "uv12wx34", why: "long" }] },
      [old],
      NOW,
    );
    expect(plan.retires).toHaveLength(1);
    expect(plan.compresses).toHaveLength(0);
    expect(plan.rejected.join(" ")).toContain("already used by another move");
  });

  test("the compress prompt carries the three measured cuts and the too-short guard", () => {
    const prompt = buildCompressPrompt(staged, "620 words for one rule", "Gate the reply before posting.");
    expect(prompt).toContain("The story of how it came to exist");
    expect(prompt).toContain("Anything the agent's own instructions already say");
    expect(prompt).toContain("The second through Nth example of one point");
    expect(prompt).toContain("writing the topic instead of the instruction");
    expect(prompt).toContain("Gate the reply before posting.");
  });

  test("it states the real word count, since that is why it was flagged", () => {
    expect(buildCompressPrompt(staged, "too long")).toContain("It is 400 words");
  });
});

describe("cutting a repeated example", () => {
  test("the rewrite is told the protection covers the first example, not the fourth", () => {
    const prompt = buildBlockRewritePrompt(rules, 0);
    expect(prompt).toContain("Cut a repeated example freely");
    expect(prompt).toContain("protects the FIRST example of a point, not the fourth");
    // The distinct-case carve-out has to survive alongside it.
    expect(prompt).toContain("Distinct examples that each carry a DIFFERENT case all stay");
  });

  test("the audit counts a repeated illustration once", () => {
    const prompt = buildMergeAuditPrompt(rules, "merged");
    expect(prompt).toContain("Count an example ONCE");
    expect(prompt).toContain("carried a case none of the surviving ones do");
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
