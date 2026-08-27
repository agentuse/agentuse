/**
 * The 0.18 capture config: `learning.capture` is no longer a boolean switch over
 * free-form auto-capture. Human feedback becomes durable through the separate,
 * deliberate Learn path; everything that can observe a run automatically — the typed
 * addons, the scoped `custom` evaluator, a replacement `agent` — is opt-in by
 * name.
 *
 * These are the parse-time guarantees behind that: what the shorthand expands
 * to, which combinations are refused outright, and which legacy forms warn and
 * continue.
 */
import { describe, it, expect } from "bun:test";
import { parseAgentContent } from "../src/parser";
import { hasAutomaticLearningCapture, legacyLearningConfigNotices } from "../src/learning/types";

function parseLearning(yaml: string) {
  const content = `---\nmodel: anthropic:claude-sonnet-4-0\n${yaml}\n---\n\nbody`;
  return parseAgentContent(content, "test").config.learning;
}

describe("learning.capture config", () => {
  it("expands the shorthands without enabling automatic capture", () => {
    // `true` and `{}` mean the same thing, and neither reaches free-form capture:
    // "enable and hope" must not be able to manufacture policy.
    expect(parseLearning("learning: true")).toEqual({ capture: { addons: [] }, apply: true });
    expect(parseLearning("learning:\n  capture: true")).toEqual({ capture: { addons: [] }, apply: true });
    expect(parseLearning("learning:\n  capture: {}")).toEqual({ capture: { addons: [] }, apply: true });
  });

  it("recognizes only named automatic channels", () => {
    expect(hasAutomaticLearningCapture(parseLearning("learning: true"))).toBe(false);
    expect(hasAutomaticLearningCapture(parseLearning("learning:\n  capture: false"))).toBe(false);
    expect(hasAutomaticLearningCapture(parseLearning("learning:\n  capture:\n    custom: tone"))).toBe(true);
    expect(hasAutomaticLearningCapture(parseLearning("learning:\n  capture:\n    agent: ./capture.agentuse"))).toBe(true);
    expect(hasAutomaticLearningCapture(parseLearning("learning:\n  capture:\n    addons: [tool-errors]"))).toBe(true);
  });

  it("accepts a typed addon", () => {
    expect(parseLearning("learning:\n  capture:\n    addons: [tool-errors]")).toEqual({
      capture: { addons: ["tool-errors"] },
      apply: true,
    });
  });

  it("accepts scoped free-form capture via custom", () => {
    expect(parseLearning("learning:\n  capture:\n    custom: only publishing failures")).toEqual({
      capture: { addons: [], custom: "only publishing failures" },
      apply: true,
    });
  });

  it("accepts a replacement capture agent", () => {
    expect(parseLearning("learning:\n  capture:\n    agent: ./capture.agentuse")).toEqual({
      capture: { addons: [], agent: "./capture.agentuse" },
      apply: true,
    });
  });

  it("keeps capture: false as an automatic-capture opt-out", () => {
    expect(parseLearning("learning:\n  capture: false\n  apply: true")).toEqual({
      capture: false,
      apply: true,
    });
  });

  it("refuses custom and agent together instead of silently picking one", () => {
    // Same shape as verify's criteria/judge conflict: a contradiction the parser
    // cannot resolve is a hard error, never a quiet preference.
    expect(() => parseLearning("learning:\n  capture:\n    custom: a\n    agent: ./b.agentuse"))
      .toThrow(/set either "custom" \(built-in evaluator\) or "agent" \(agent file\), not both/);
  });

  it("names the replacement shape when it rejects the removed criteria key", () => {
    // The error text IS the upgrade path for an agent that stops parsing, so it
    // has to spell out where the free-form scope moved to.
    expect(() => parseLearning("learning:\n  capture: true\n  criteria: tone"))
      .toThrow(/capture: \{ custom: "\.\.\." \}/);
  });

  it("rejects an unknown addon by name", () => {
    expect(() => parseLearning("learning:\n  capture:\n    addons: [telepathy]"))
      .toThrow(/telepathy/);
  });

  it("rejects an unknown key inside capture", () => {
    expect(() => parseLearning("learning:\n  capture:\n    addons: [tool-errors]\n    junk: 1"))
      .toThrow(/'junk'/);
  });
});

describe("legacyLearningConfigNotices", () => {
  // Read from the RAW frontmatter, before zod normalizes the sugar away — after
  // normalization `true` and `{ addons: [] }` are indistinguishable, and only the
  // author who wrote `true` needs telling that its meaning narrowed.
  it("explains the narrowed meaning of learning: true", () => {
    const [notice, ...rest] = legacyLearningConfigNotices(true);
    expect(rest).toEqual([]);
    expect(notice).toContain("explicitly chooses Learn");
    expect(notice).toContain('capture: { custom: "..." }');
  });

  it("explains the narrowed meaning of capture: true", () => {
    const [notice] = legacyLearningConfigNotices({ capture: true, apply: true });
    expect(notice).toContain("no automatic observation channels");
    expect(notice).toContain('capture: { custom: "..." }');
  });

  it("says nothing about a config already written in the object form", () => {
    expect(legacyLearningConfigNotices({ capture: { addons: [] } })).toEqual([]);
    expect(legacyLearningConfigNotices({ capture: { custom: "tone" } })).toEqual([]);
    expect(legacyLearningConfigNotices({ capture: false })).toEqual([]);
    expect(legacyLearningConfigNotices(undefined)).toEqual([]);
  });
});
