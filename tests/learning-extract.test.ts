import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentCompleteEvent } from "../src/plugin/types";

// extractLearnings now goes through completeText() (streaming) instead of
// generateText(), which is required for the ChatGPT Codex backend. Mock
// completeText to return the raw model text directly.
const completeTextMock = mock(async () =>
  JSON.stringify([
    {
      category: "tip",
      title: "Shorten prompts",
      instruction: "Keep prompts concise to reduce token usage.",
      confidence: 0.9,
    },
  ]),
);

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

const succeedMock = mock(() => {});
const failMock = mock(() => {});
const startMock = mock(() => ({ succeed: succeedMock, fail: failMock }));

mock.module("ora", () => ({
  default: () => ({ start: startMock }),
}));

let extractLearnings: typeof import("../src/learning/index").extractLearnings;
let tempDir: string;
let agentFilePath: string;

const event: AgentCompleteEvent = {
  agent: { name: "demo-agent", model: "gpt-4" },
  result: { text: "done", duration: 0.5, toolCalls: 0, hasTextOutput: true },
  isSubAgent: false,
  consoleOutput: "",
};

beforeAll(async () => {
  ({ extractLearnings } = await import("../src/learning/index"));
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "learning-extract-"));
  agentFilePath = join(tempDir, "agents", "demo.md");
  completeTextMock.mockReset();
  succeedMock.mockReset();
  failMock.mockReset();
  startMock.mockReset();
  startMock.mockImplementation(() => ({ succeed: succeedMock, fail: failMock }));
  // Default mock returns one learning
  completeTextMock.mockImplementation(async () =>
    JSON.stringify([
      {
        category: "tip",
        title: "Shorten prompts",
        instruction: "Keep prompts concise to reduce token usage.",
        confidence: 0.9,
      },
    ]),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

describe("extractLearnings", () => {
  it("persists new learnings and reports a captured outcome", async () => {
    const outcome = await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      config: { capture: true, apply: false },
    });

    const defaultPath = join(tempDir, "agents", "demo.learnings.md");
    expect(existsSync(defaultPath)).toBe(true);
    const content = readFileSync(defaultPath, "utf-8");
    expect(content).toContain("Shorten prompts");
    expect(succeedMock).toHaveBeenCalledWith(
      `Extracted 1 learning(s) → ${defaultPath}`
    );
    expect(outcome).toEqual({
      status: "captured",
      source: "auto",
      count: 1,
      titles: ["Shorten prompts"],
    });
  });

  it("skips persistence and reports a none outcome when no learnings are returned", async () => {
    completeTextMock.mockImplementation(async () => "[]");

    const outcome = await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      config: { capture: true, apply: false },
    });

    expect(existsSync(join(tempDir, "agents", "demo.learnings.md"))).toBe(false);
    expect(succeedMock).toHaveBeenCalledWith("No new learnings extracted");
    expect(outcome.status).toBe("none");
    expect(outcome.count).toBe(0);
  });

  it("reports a failed outcome with detail when the model call throws", async () => {
    // Mirrors the Codex-backend regression: the helper LLM call rejects. The
    // failure must surface as a 'failed' outcome (with the error detail) rather
    // than being swallowed and looking like "nothing was learned".
    completeTextMock.mockImplementation(async () => {
      throw new Error("Stream must be set to true");
    });

    const outcome = await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "openai:gpt-5.5",
      agentFilePath,
      config: { capture: true, apply: false },
    });

    expect(failMock).toHaveBeenCalledWith("Failed to extract learnings");
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("Stream must be set to true");
  });
});
