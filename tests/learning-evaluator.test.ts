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
});
