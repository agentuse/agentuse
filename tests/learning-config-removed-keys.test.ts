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

  it("still accepts the canonical shape and the boolean shorthand", () => {
    expect(parseLearning("learning: true")).toEqual({ capture: true, apply: true });
    expect(parseLearning("learning:\n  capture: true\n  apply: false\n  criteria: tone")).toEqual({
      capture: true,
      apply: false,
      criteria: "tone",
    });
  });
});
