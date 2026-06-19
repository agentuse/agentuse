import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// promoteApprovalComment now goes through completeText() (streaming) instead of
// generateText(), which is required for the ChatGPT Codex backend. Mock
// completeText to return the raw model text directly.
const completeTextMock = mock(async () => "{}");

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

let promoteApprovalComment: typeof import("../src/learning/from-approval").promoteApprovalComment;
let maybePromoteApprovalComment: typeof import("../src/learning/from-approval").maybePromoteApprovalComment;
let tempDir: string;
let agentFilePath: string;

beforeAll(async () => {
  ({ promoteApprovalComment, maybePromoteApprovalComment } = await import("../src/learning/from-approval"));
});

// Minimal ParsedAgent stub: maybePromoteApprovalComment only reads
// config.learning, config.model, and instructions.
function agentStub() {
  return {
    instructions: "Write blog posts.",
    config: {
      model: "gpt-4",
      learning: { capture: true, apply: true },
    },
  } as unknown as import("../src/parser").ParsedAgent;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "learning-approval-"));
  agentFilePath = join(tempDir, "agents", "demo.md");
  completeTextMock.mockReset();
  completeTextMock.mockImplementation(async () => "{}");
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
    completeTextMock.mockImplementation(async () =>
      JSON.stringify({
        applies: true,
        category: "warning",
        title: "Cite a source",
        instruction: "Always include a cited source before publishing.",
      }),
    );

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
    completeTextMock.mockImplementation(async () =>
      JSON.stringify({ applies: false }),
    );

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

describe("maybePromoteApprovalComment guard", () => {
  it("captures a comment-decision (revise loop), not just approve", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify({
        applies: true,
        category: "tip",
        title: "Lead with agreement",
        instruction: "Open replies by agreeing with the other person before adding your angle.",
      }),
    );

    const outcome = await maybePromoteApprovalComment({
      agent: agentStub(),
      agentFilePath,
      toolResult: {
        status: "comment",
        comment: "Always agree with what they said first, then add your point.",
        reviewer: { username: "web" },
      },
    });

    expect(existsSync(learningsPath())).toBe(true);
    expect(readFileSync(learningsPath(), "utf-8")).toContain("src:approval");
    expect(outcome).toEqual({
      status: "captured",
      source: "approval",
      count: 1,
      titles: ["Lead with agreement"],
    });
  });

  it("skips a bare approve with no comment", async () => {
    completeTextMock.mockImplementation(async () => "{}");

    const outcome = await maybePromoteApprovalComment({
      agent: agentStub(),
      agentFilePath,
      toolResult: { status: "approve", reviewer: { username: "web" } },
    });

    expect(completeTextMock).not.toHaveBeenCalled();
    expect(existsSync(learningsPath())).toBe(false);
    // No capture was attempted, so no marker should be surfaced.
    expect(outcome).toBeUndefined();
  });

  it("reports a failed outcome when the model call throws (Codex-backend regression)", async () => {
    completeTextMock.mockImplementation(async () => {
      throw new Error("Stream must be set to true");
    });

    const outcome = await maybePromoteApprovalComment({
      agent: agentStub(),
      agentFilePath,
      toolResult: {
        status: "comment",
        comment: "Always cite a source before publishing.",
        reviewer: { username: "web" },
      },
    });

    expect(outcome?.status).toBe("failed");
    expect(outcome?.source).toBe("approval");
    expect(outcome?.detail).toContain("Stream must be set to true");
    expect(existsSync(learningsPath())).toBe(false);
  });
});
