import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// Ensure no module mocks leak from other files
mock.restore();
import type { AgentCompleteEvent } from "../src/plugin/types";

// evaluateExecution now goes through completeText() (streaming) instead of
// generateText(), which is required for the ChatGPT Codex backend. Mock
// completeText to return the raw model text directly.
const completeTextMock = mock(async () => "[]");

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

let evaluateExecution: typeof import("../src/learning/evaluator").evaluateExecution;

const baseEvent: AgentCompleteEvent = {
  agent: { name: "demo-agent", model: "gpt-4" },
  result: {
    text: "complete",
    duration: 1.2,
    toolCalls: 0,
    hasTextOutput: true,
  },
  isSubAgent: false,
  consoleOutput: "Execution logs",
};

beforeAll(async () => {
  ({ evaluateExecution } = await import("../src/learning/evaluator"));
});

beforeEach(() => {
  completeTextMock.mockReset();
});

describe("evaluateExecution", () => {
  it("returns only high-confidence learnings with metadata", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        {
          category: "tip",
          title: "Cache responses",
          instruction: "Cache tool responses to reduce latency.",
          confidence: 0.9,
        },
        {
          category: "warning",
          title: "Low confidence",
          instruction: "Ignore",
          confidence: 0.5,
        },
      ]),
    );

    const result = await evaluateExecution(baseEvent, "Agent instructions", "anthropic-sonnet", undefined, []);

    expect(result).toHaveLength(1);
    const [learning] = result;
    expect(learning.category).toBe("tip");
    expect(learning.appliedCount).toBe(0);
    expect(learning.id).toHaveLength(8);
    expect(new Date(learning.extractedAt).toString()).not.toBe("Invalid Date");
  });

  it("parses learnings from markdown code blocks", async () => {
    completeTextMock.mockImplementation(async () =>
      "```json\n[{\"category\":\"pattern\",\"title\":\"Fallbacks\",\"instruction\":\"Use fallback prompts when tools fail.\",\"confidence\":0.82}]\n```",
    );

    const result = await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", undefined, []);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("pattern");
    expect(result[0].confidence).toBeCloseTo(0.82);
  });

  it("returns empty array when response is not valid JSON", async () => {
    completeTextMock.mockImplementation(async () => "not json");

    const result = await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", undefined, []);
    expect(result).toEqual([]);
  });

  it("includes structured tool outputs (not just inputs) in the evaluation prompt", async () => {
    completeTextMock.mockImplementation(async () => "[]");

    const eventWithTraces: AgentCompleteEvent = {
      ...baseEvent,
      result: {
        ...baseEvent.result,
        toolCalls: 1,
        toolCallTraces: [
          {
            name: "search",
            type: "tool",
            startTime: 0,
            duration: 12,
            success: true,
            input: { query: "pricing" },
            output: "No results found for 'pricing'",
          },
        ],
      },
    };

    await evaluateExecution(eventWithTraces, "Agent instructions", "gpt-4", undefined, []);

    const [, opts] = completeTextMock.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(opts.prompt).toContain("Input: {\"query\":\"pricing\"}");
    expect(opts.prompt).toContain("Output: No results found for 'pricing'");
  });

  it("surfaces reviewer feedback in the prompt and trusts approval learnings at 0.95", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        {
          source: "approval",
          category: "warning",
          title: "Avoid salesy intros",
          instruction: "Keep intros factual; avoid promotional language.",
          confidence: 0.7,
        },
      ]),
    );

    const result = await evaluateExecution(
      baseEvent,
      "Agent instructions",
      "gpt-4",
      undefined,
      [],
      [{ comment: "this intro is too salesy", work: "Draft: Unlock the AMAZING secret!!!" }],
    );

    const [, opts] = completeTextMock.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(opts.prompt).toContain("Reviewer Feedback");
    expect(opts.prompt).toContain("this intro is too salesy");
    expect(opts.prompt).toContain("Unlock the AMAZING secret");

    // Human-sourced: kept despite confidence < 0.8, stored at the trusted 0.95.
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("approval");
    expect(result[0].confidence).toBe(0.95);
  });

  it("forces source to 'auto' when the model claims approval but there were no reviews", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        {
          source: "approval",
          category: "tip",
          title: "Hallucinated provenance",
          instruction: "Should be tagged auto, not approval.",
          confidence: 0.9,
        },
      ]),
    );

    const result = await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", undefined, [], []);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("auto");
    expect(result[0].confidence).toBe(0.9);
  });

  const rule = (i: number) => ({
    id: `rule000${i}`,
    category: "warning" as const,
    title: `Rule ${i}`,
    instruction: `Skip subject ${i} entirely.`,
    confidence: 0.95,
    appliedCount: 0,
    extractedAt: "2026-07-01T00:00:00.000Z",
    source: "approval" as const,
    reasserted: 0,
    approvedRuns: 0,
  });

  it("demands a fold from every learning once the set is full, reviewer ones included", async () => {
    completeTextMock.mockImplementation(async () => "[]");
    const active = [rule(0), rule(1), rule(2)];

    await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", undefined, active, [], { cap: 3 });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("The set is FULL (3/3)");
    expect(prompt).toContain("EVERY learning you return must set \"supersedes\"");
    // The carve-out that let a reviewer correction land without folding is what
    // built the backlog: rules past the cap are never injected, so they can
    // neither prove themselves nor be evicted.
    expect(prompt).toContain("applies to reviewer-sourced learnings too");
    // Folding must not be read as picking a winner.
    expect(prompt).toContain("satisfies both");
  });

  it("asks for reconciliation but not a fold while the set has room", async () => {
    completeTextMock.mockImplementation(async () => "[]");

    await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", undefined, [rule(0)], [], { cap: 3 });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("CONTRADICT an existing rule");
    expect(prompt).not.toContain("The set is FULL");
  });

  it("only accepts a supersedes id the model was actually shown", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        { source: "auto", category: "tip", title: "Real", instruction: "Fold into a real rule.", confidence: 0.9, supersedes: "rule0001" },
        { source: "auto", category: "tip", title: "Bogus", instruction: "Fold into a rule that does not exist.", confidence: 0.9, supersedes: "made-up" },
      ]),
    );

    const result = await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", undefined, [rule(0), rule(1)], [], { cap: 2 });

    // A hallucinated id must fall through to the store's capacity handling. A
    // fold that quietly became an append is the exact failure this prevents.
    expect(result[0].supersedes).toBe("rule0001");
    expect(result[1].supersedes).toBeUndefined();
  });
});
