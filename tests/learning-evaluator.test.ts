import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// Ensure no module mocks leak from other files
mock.restore();
import type { AgentCompleteEvent } from "../src/plugin/types";

const generateTextMock = mock(async () => ({ text: "[]" }));
const createModelMock = mock(async () => "mock-model");

mock.module("../src/models", () => ({
  createModel: createModelMock,
}));

mock.module("ai", () => ({
  generateText: generateTextMock,
  streamText: mock(),
  stepCountIs: mock(),
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
  generateTextMock.mockReset();
  createModelMock.mockReset();
});

describe("evaluateExecution", () => {
  it("returns only high-confidence learnings with metadata", async () => {
    generateTextMock.mockImplementation(async () => ({
      text: JSON.stringify([
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
    }));
    createModelMock.mockImplementation(async () => "anthropic-sonnet");

    const result = await evaluateExecution(baseEvent, "Agent instructions", "anthropic-sonnet", true, []);

    expect(result).toHaveLength(1);
    const [learning] = result;
    expect(learning.category).toBe("tip");
    expect(learning.appliedCount).toBe(0);
    expect(learning.id).toHaveLength(8);
    expect(new Date(learning.extractedAt).toString()).not.toBe("Invalid Date");
  });

  it("parses learnings from markdown code blocks", async () => {
    generateTextMock.mockImplementation(async () => ({
      text: "```json\n[{\"category\":\"pattern\",\"title\":\"Fallbacks\",\"instruction\":\"Use fallback prompts when tools fail.\",\"confidence\":0.82}]\n```",
    }));

    const result = await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", true, []);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("pattern");
    expect(result[0].confidence).toBeCloseTo(0.82);
  });

  it("returns empty array when response is not valid JSON", async () => {
    generateTextMock.mockImplementation(async () => ({ text: "not json" }));

    const result = await evaluateExecution(baseEvent, "Agent instructions", "gpt-4", true, []);
    expect(result).toEqual([]);
  });
});
