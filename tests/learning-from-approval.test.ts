import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const generateTextMock = mock(async () => ({ text: "{}" }));
const createModelMock = mock(async () => "mock-model");

mock.module("../src/models", () => ({ createModel: createModelMock }));
mock.module("ai", () => ({
  generateText: generateTextMock,
  streamText: mock(),
  stepCountIs: mock(),
}));

let promoteApprovalComment: typeof import("../src/learning/from-approval").promoteApprovalComment;
let tempDir: string;
let agentFilePath: string;

beforeAll(async () => {
  ({ promoteApprovalComment } = await import("../src/learning/from-approval"));
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "learning-approval-"));
  agentFilePath = join(tempDir, "agents", "demo.md");
  generateTextMock.mockReset();
  createModelMock.mockReset();
  createModelMock.mockImplementation(async () => "mock-model");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

const learningsPath = () => join(tempDir, "agents", "demo.learnings.md");

describe("promoteApprovalComment", () => {
  it("captures a durable approval comment as an approval-sourced learning", async () => {
    generateTextMock.mockImplementation(async () => ({
      text: JSON.stringify({
        applies: true,
        category: "warning",
        title: "Cite a source",
        instruction: "Always include a cited source before publishing.",
      }),
    }));

    const result = await promoteApprovalComment({
      comment: "Looks good. Going forward, always cite a source before publishing.",
      agentInstructions: "Write blog posts.",
      agentModel: "gpt-4",
      agentFilePath,
    });

    expect(result?.source).toBe("approval");
    expect(result?.confidence).toBe(0.95);
    expect(existsSync(learningsPath())).toBe(true);
    const content = readFileSync(learningsPath(), "utf-8");
    expect(content).toContain("Cite a source");
    expect(content).toContain("src:approval");
  });

  it("skips run-specific comments judged not to apply", async () => {
    generateTextMock.mockImplementation(async () => ({
      text: JSON.stringify({ applies: false }),
    }));

    const result = await promoteApprovalComment({
      comment: "Fix the typo in paragraph two.",
      agentInstructions: "Write blog posts.",
      agentModel: "gpt-4",
      agentFilePath,
    });

    expect(result).toBeUndefined();
    expect(existsSync(learningsPath())).toBe(false);
  });
});
