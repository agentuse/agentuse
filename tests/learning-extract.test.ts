import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentCompleteEvent } from "../src/plugin/types";
import { LearningStore, resolveLearningFilePath } from "../src/learning/store";

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
let xdgDir: string;
let agentFilePath: string;
/** Where this agent's corrections actually land: keyed under the project state
 *  directory, NOT beside the agent file. Resolved through the same helper the
 *  code uses, since the path contains a sha256 of the project root that a test
 *  cannot spell out by hand. */
let learningsPath: string;

// Corrections are generated state, so they live under $XDG_DATA_HOME rather
// than in the project. Point it at a temp directory or the suite would write
// into the developer's real ~/.local/share/agentuse.
const priorXdgDataHome = process.env.XDG_DATA_HOME;

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
  xdgDir = mkdtempSync(join(tmpdir(), "learning-extract-xdg-"));
  process.env.XDG_DATA_HOME = xdgDir;
  agentFilePath = join(tempDir, "agents", "demo.agentuse");
  learningsPath = resolveLearningFilePath(agentFilePath, tempDir);
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
  rmSync(xdgDir, { recursive: true, force: true });
});

afterAll(() => {
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdgDataHome;
  mock.restore();
});

describe("extractLearnings", () => {
  it("persists new learnings and reports a captured outcome", async () => {
    const outcome = await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: { capture: true, apply: false },
    });

    expect(existsSync(learningsPath)).toBe(true);
    // The point of the move: the run wrote state, and the user's repository is
    // exactly as it was.
    expect(learningsPath.startsWith(xdgDir)).toBe(true);
    expect(existsSync(join(tempDir, "agents", "demo.agentuse.learnings.md"))).toBe(false);
    const content = readFileSync(learningsPath, "utf-8");
    expect(content).toContain("Shorten prompts");
    expect(succeedMock).toHaveBeenCalledWith(
      `Extracted 1 learning(s) → ${learningsPath}`
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
      stateRoot: tempDir,
      config: { capture: true, apply: false },
    });

    expect(existsSync(learningsPath)).toBe(false);
    expect(succeedMock).toHaveBeenCalledWith("No new learnings extracted");
    expect(outcome.status).toBe("none");
    expect(outcome.count).toBe(0);
  });

  it("reports none when everything the evaluator proposed was redundant", async () => {
    // The old code reported the evaluator's count before the store filtered
    // similars, so the session marker could claim a lesson was learned while
    // nothing was written.
    const store = LearningStore.fromAgentFile(agentFilePath, tempDir);
    await store.save([{
      id: "manual01",
      category: "warning",
      title: "Don't lecture",
      instruction: "Rewrite instruction shaped phrasing as the author's own lived observation.",
      confidence: 1,
      appliedCount: 5,
      extractedAt: "2026-06-02T00:00:00.000Z",
      source: "manual",
      reasserted: 0,
      approvedRuns: 0,
    }]);

    completeTextMock.mockImplementation(async () => JSON.stringify([{
      source: "auto",
      category: "warning",
      title: "Avoid lecturing",
      instruction: "Rewrite instruction shaped phrasing as the author's own lived observation always.",
      confidence: 0.9,
    }]));

    const outcome = await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: { capture: true, apply: false },
    });

    expect(outcome.status).toBe("none");
    expect(outcome.count).toBe(0);
    expect(succeedMock).toHaveBeenCalledWith("No new learnings extracted");
    expect(await store.load()).toHaveLength(1);
  });

  it("shows the evaluator every active rule with its id, and re-asserts a repeat", async () => {
    // Two properties in one run, because they are the same mechanism.
    //
    // The evaluator is shown the WHOLE active set, each entry with the id that
    // makes it revisable. Withholding any of it was the older behaviour and it
    // is what let contradictory rules accumulate: a rule the model cannot see is
    // a rule it cannot notice its new one collides with.
    //
    // And a reviewer repeating a correction still refreshes the stored entry
    // rather than appending a near-copy beside it.
    const store = LearningStore.fromAgentFile(agentFilePath, tempDir);
    const dormant = {
      id: "dormant1",
      category: "warning" as const,
      title: "Cut teaching-mode lines",
      instruction: "Rewrite instruction shaped phrasing as the author's own lived observation.",
      confidence: 0.95,
      appliedCount: 0,
      extractedAt: "2026-06-02T00:00:00.000Z",
      source: "approval" as const,
      reasserted: 0,
      approvedRuns: 0,
    };
    const fillers = Array.from({ length: 10 }, (_, i) => ({
      ...dormant,
      id: `filler${i}`,
      title: `Filler ${i}`,
      instruction: `Unrelated guidance covering separate territory numbered ${i} exactly.`,
      extractedAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    await store.save([dormant, ...fillers]);

    completeTextMock.mockImplementation(async () => JSON.stringify([{
      source: "approval",
      category: "warning",
      title: "Don't lecture the author",
      instruction: "Rewrite instruction shaped phrasing as the author's own lived observation, never a rule.",
      confidence: 0.95,
    }]));

    const outcome = await extractLearnings({
      event,
      agentInstructions: "Do things",
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: { capture: true, apply: false },
      reviews: [{ comment: "Don't lecture" }],
      sessionId: "sess-repeat",
    });

    // Every active rule reached the evaluator, each addressable by id, together
    // with the instruction to reconcile rather than merely avoid duplicating.
    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("Filler 9");
    expect(prompt).toContain("Cut teaching-mode lines");
    expect(prompt).toContain("(id dormant1)");
    expect(prompt).toContain("CONTRADICT an existing rule");
    expect(prompt).toContain('"supersedes"');

    // And the repeat refreshed the existing entry rather than appending a near-copy.
    expect(outcome.status).toBe("captured");
    expect(outcome.count).toBe(1);
    const loaded = await store.load();
    expect(loaded).toHaveLength(11);
    const updated = loaded.find((l) => l.id === "dormant1");
    expect(updated?.title).toBe("Don't lecture the author");
    // Refreshed to now, so it ranks as recent and is injected next run.
    expect(updated?.extractedAt).not.toBe("2026-06-02");
    expect(updated?.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(updated?.sessionId).toBe("sess-repeat");
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
      stateRoot: tempDir,
      config: { capture: true, apply: false },
    });

    expect(failMock).toHaveBeenCalledWith("Failed to extract learnings");
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("Stream must be set to true");
  });
});
