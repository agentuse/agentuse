/**
 * The vet: the pass every free-form candidate makes against the COMPLETE agent
 * contract before it can become active. The production failure this exists for
 * had two mechanically detectable bad candidates — one duplicating the contract,
 * one contradicting it — so the tests here are about the verdicts surviving the
 * round trip intact, and about the one verdict the vet is not allowed to reach
 * for.
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

mock.restore();

const completeTextMock = mock(async (_model: string, _opts: { prompt: string }) => "[]");

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

let vetCandidates: typeof import("../src/learning/vet").vetCandidates;
let describeVetFailure: typeof import("../src/learning/vet").describeVetFailure;

import type { Learning, LearningDraft } from "../src/learning/types";

const draft = (id: string, title: string): LearningDraft => ({
  id,
  category: "tip",
  title,
  instruction: `Instruction behind ${title}.`,
  confidence: 0.9,
  injectedCount: 0,
  extractedAt: "2026-08-19T00:00:00.000Z",
  source: "auto",
  reasserted: 0,
  approvedRuns: 0,
});

const rule = (id: string, title: string): Learning => ({
  ...draft(id, title),
  source: "approval",
});

const lastPrompt = () => String(completeTextMock.mock.calls.at(-1)?.[1]?.prompt ?? "");

beforeAll(async () => {
  ({ vetCandidates, describeVetFailure } = await import("../src/learning/vet"));
});

beforeEach(() => {
  completeTextMock.mockReset();
  completeTextMock.mockImplementation(async () => "[]");
});

describe("vetCandidates", () => {
  it("keys every verdict shape back to its candidate id", async () => {
    completeTextMock.mockImplementation(async () => JSON.stringify([
      { id: "cand0001", verdict: "pass" },
      { id: "cand0002", verdict: "duplicate", detail: "Cite the primary source." },
      { id: "cand0003", verdict: "contradiction", detail: "Never publish on a Friday." },
      { id: "cand0004", verdict: "ungrounded", detail: "The trace shows no such call." },
    ]));

    const drafts = [
      draft("cand0001", "New ground"),
      draft("cand0002", "Restatement"),
      draft("cand0003", "Collision"),
      draft("cand0004", "Invention"),
    ];

    const verdicts = await vetCandidates({
      drafts,
      agentInstructions: "Cite the primary source, never a summary.",
      activeRules: [],
      traceSummary: "## Execution Results\nnothing much happened",
      groundedIds: new Set(drafts.map((d) => d.id)),
      model: "gpt-4",
    });

    expect(verdicts.get("cand0001")).toEqual({ verdict: "pass" });
    expect(verdicts.get("cand0002")).toEqual({ verdict: "duplicate", of: "Cite the primary source." });
    expect(verdicts.get("cand0003")).toEqual({ verdict: "contradiction", conflict: "Never publish on a Friday." });
    expect(verdicts.get("cand0004")).toEqual({ verdict: "ungrounded", reason: "The trace shows no such call." });
  });

  it("ignores an ungrounded verdict against a human-authored candidate", async () => {
    // A human wrote it, which is grounding the trace cannot overrule. A verdict
    // the model is not entitled to reach for is recorded as no verdict, so the
    // channel's fail-open default applies instead.
    completeTextMock.mockImplementation(async () => JSON.stringify([
      { id: "human001", verdict: "ungrounded", detail: "I could not find it in the trace." },
    ]));

    const verdicts = await vetCandidates({
      drafts: [draft("human001", "Reviewer correction")],
      agentInstructions: "Write the digest.",
      activeRules: [],
      traceSummary: "## Execution Results\nnothing much happened",
      groundedIds: new Set(), // nothing here is model-authored
      model: "gpt-4",
    });

    expect(verdicts.has("human001")).toBe(false);
    // And the prompt says so out loud, so the model is not merely overruled after
    // the fact.
    expect(lastPrompt()).toContain("human-authored: never rule \"ungrounded\"");
  });

  it("returns no verdicts when the response cannot be parsed", async () => {
    completeTextMock.mockImplementation(async () => "I think they all look fine, honestly.");

    const verdicts = await vetCandidates({
      drafts: [draft("cand0001", "New ground")],
      agentInstructions: "Write the digest.",
      activeRules: [],
      model: "gpt-4",
    });

    expect(verdicts.size).toBe(0);
  });

  it("drops verdicts for ids it never asked about, and keeps the first of a repeat", async () => {
    completeTextMock.mockImplementation(async () => JSON.stringify([
      { id: "cand0001", verdict: "pass" },
      { id: "cand0001", verdict: "duplicate", detail: "changed my mind" },
      { id: "invented", verdict: "pass" },
    ]));

    const verdicts = await vetCandidates({
      drafts: [draft("cand0001", "New ground")],
      agentInstructions: "Write the digest.",
      activeRules: [],
      model: "gpt-4",
    });

    expect(verdicts.size).toBe(1);
    expect(verdicts.get("cand0001")).toEqual({ verdict: "pass" });
  });

  it("makes no model call at all when there is nothing to vet", async () => {
    expect((await vetCandidates({
      drafts: [],
      agentInstructions: "Write the digest.",
      activeRules: [],
      model: "gpt-4",
    })).size).toBe(0);
    expect(completeTextMock).not.toHaveBeenCalled();
  });

  it("shows the whole contract, the rules in force, and the trace", async () => {
    await vetCandidates({
      drafts: [draft("cand0001", "New ground")],
      agentInstructions: [
        "Write the weekly digest.",
        "<!-- agentuse:learned -->",
        "- [warning] Keep intros factual.",
        "<!-- /agentuse:learned -->",
      ].join("\n"),
      activeRules: [rule("rule0001", "Cite sources")],
      traceSummary: "## Execution Results\nthe publish tool returned an error",
      groundedIds: new Set(["cand0001"]),
      model: "gpt-4",
    });

    const prompt = lastPrompt();
    // A vet that cannot see the whole contract cannot detect a duplicate of it,
    // so nothing here is truncated on the way in.
    expect(prompt).toContain("Write the weekly digest.");
    expect(prompt).toContain("Keep intros factual.");
    expect(prompt).toContain("(id rule0001) Cite sources");
    expect(prompt).toContain("the publish tool returned an error");
    expect(prompt).toContain("ungrounded");
  });

  it("does not offer the ungrounded verdict when re-vetting without a trace", async () => {
    // Re-vetting a stored rule against a rewritten contract has no trace to check
    // grounding against — the original run is long gone.
    await vetCandidates({
      drafts: [draft("cand0001", "Stored rule")],
      agentInstructions: "Write the digest.",
      activeRules: [],
      model: "gpt-4",
    });

    const prompt = lastPrompt();
    expect(prompt).not.toContain('- "ungrounded"');
    expect(prompt).toContain('"pass|duplicate|contradiction"');
  });
});

describe("describeVetFailure", () => {
  it("renders each failure as the reason stored beside the quarantined entry", () => {
    expect(describeVetFailure({ verdict: "duplicate", of: "Cite the primary source." }))
      .toBe("duplicates the contract: Cite the primary source.");
    expect(describeVetFailure({ verdict: "contradiction", conflict: "Never publish on a Friday." }))
      .toBe("contradicts the contract: Never publish on a Friday.");
    expect(describeVetFailure({ verdict: "ungrounded", reason: "no such call in the trace" }))
      .toBe("unsupported by the trace: no such call in the trace");
  });

  it("has nothing to say about a pass", () => {
    expect(describeVetFailure({ verdict: "pass" })).toBe("");
  });
});
