/**
 * Replaces tests/legacy-learning-config.test.ts, which asserted the
 * `learning.evaluate` -> `{capture, criteria}` migration that shipped with
 * src/learning/legacy.ts. Both are gone in v0.17.0.
 *
 * The point of keeping a file here is the failure mode, not the removal:
 * CanonicalLearningSchema is `.strict()`, so an agent file still carrying
 * either key must fail by NAME rather than as a generic union mismatch. That
 * error text is the whole upgrade path for someone whose agent stops parsing,
 * so it is worth pinning against a future `.passthrough()` or a re-added key.
 */
import { describe, it, expect } from "bun:test";
import { parseAgentContent } from "../src/parser";

function parseLearning(yaml: string) {
  const content = `---\nmodel: anthropic:claude-sonnet-4-0\n${yaml}\n---\n\nbody`;
  return parseAgentContent(content, "test").config.learning;
}

describe("removed learning config keys", () => {
  it("rejects learning.evaluate by name", () => {
    expect(() => parseLearning("learning:\n  evaluate: true")).toThrow(/'evaluate'/);
    expect(() => parseLearning("learning:\n  evaluate: focus on tone")).toThrow(/'evaluate'/);
  });

  it("rejects learning.file by name", () => {
    expect(() =>
      parseLearning("learning:\n  capture: true\n  file: ../shared.learnings.md")
    ).toThrow(/'file'/);
  });

  it("rejects learning.criteria by name, with the shape that replaced it", () => {
    // Removed in 0.18. The one faithful mapping (capture.custom) keeps free-form
    // capture alive, which is what the redesign exists to stop, so the author has
    // to rewrite it consciously rather than have it migrated for them.
    expect(() => parseLearning("learning:\n  capture: true\n  criteria: tone")).toThrow(
      /criteria/,
    );
    expect(() => parseLearning("learning:\n  capture: true\n  criteria: tone")).toThrow(
      /capture: \{ custom: "\.\.\." \}/,
    );
  });

  it("still accepts the canonical shape and the boolean shorthand", () => {
    // `learning: true` is corrections-only sugar now: capture is an object with
    // no addons and no free-form opt-in.
    expect(parseLearning("learning: true")).toEqual({ capture: { addons: [] }, apply: true });
    expect(parseLearning("learning:\n  capture: true\n  apply: false")).toEqual({
      capture: { addons: [] },
      apply: false,
    });
  });
});
