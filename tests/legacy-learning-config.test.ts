/**
 * DEPRECATED-COMPAT(learning.evaluate)
 * DELETE WITH src/learning/legacy.ts when the legacy `evaluate` shape is removed.
 */
import { describe, it, expect } from "bun:test";
import { parseAgentContent } from "../src/parser";

function parseLearning(yaml: string) {
  const content = `---\nmodel: anthropic:claude-sonnet-4-0\n${yaml}\n---\n\nbody`;
  return parseAgentContent(content, "test").config.learning;
}

describe("legacy learning.evaluate migration", () => {
  it("migrates evaluate: true to capture, preserving the old apply default (false)", () => {
    expect(parseLearning("learning:\n  evaluate: true")).toEqual({
      capture: true,
      apply: false,
    });
  });

  it("migrates an evaluate string to criteria", () => {
    expect(parseLearning("learning:\n  evaluate: focus on tone")).toEqual({
      capture: true,
      apply: false,
      criteria: "focus on tone",
    });
  });

  it("preserves apply and file from the legacy shape", () => {
    expect(
      parseLearning("learning:\n  evaluate: true\n  apply: true\n  file: ../shared.learnings.md")
    ).toEqual({
      capture: true,
      apply: true,
      file: "../shared.learnings.md",
    });
  });
});
