import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentCompleteEvent } from "../src/plugin/types";

const generateTextMock = mock(async () => ({
  text: JSON.stringify([
    {
      category: "tip",
      title: "Shorten prompts",
      instruction: "Keep prompts concise to reduce token usage.",
      confidence: 0.9,
    },
  ]),
}));

const createModelMock = mock(async () => "mock-model");

mock.module("../src/models", () => ({
  createModel: createModelMock,
}));

mock.module("ai", () => ({
  generateText: generateTextMock,
  streamText: mock(),
  stepCountIs: mock(),
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
  generateTextMock.mockReset();
  createModelMock.mockReset();
  succeedMock.mockReset();
  failMock.mockReset();
  startMock.mockReset();
  startMock.mockImplementation(() => ({ succeed: succeedMock, fail: failMock }));
  // Default mock returns one learning
  generateTextMock.mockImplementation(async () => ({
    text: JSON.stringify([
      {
        category: "tip",
        title: "Shorten prompts",
        instruction: "Keep prompts concise to reduce token usage.",
        confidence: 0.9,
      },
    ]),
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

describe("extractLearnings", () => {
  it("persists new learnings and reports success", async () => {
    await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      config: { evaluate: true, apply: false },
    });

    const defaultPath = join(tempDir, "agents", "demo.learnings.md");
    expect(existsSync(defaultPath)).toBe(true);
    const content = readFileSync(defaultPath, "utf-8");
    expect(content).toContain("Shorten prompts");
    expect(succeedMock).toHaveBeenCalledWith(
      `Extracted 1 learning(s) → ${defaultPath}`
    );
  });

  it("skips persistence when no learnings are returned", async () => {
    generateTextMock.mockImplementation(async () => ({ text: "[]" }));

    await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      config: { evaluate: true, apply: false },
    });

    expect(existsSync(join(tempDir, "agents", "demo.learnings.md"))).toBe(false);
    expect(succeedMock).toHaveBeenCalledWith("No new learnings extracted");
  });

  it("fails gracefully when evaluation throws", async () => {
    createModelMock.mockImplementation(async () => {
      throw new Error("model error");
    });

    await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      config: { evaluate: true, apply: false },
    });

    expect(failMock).toHaveBeenCalledWith("Failed to extract learnings");
  });
});
