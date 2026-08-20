import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentCompleteEvent } from "../src/plugin/types";
import { LearningStore, resolveLearningFilePath } from "../src/learning/store";
import { hashInstructions } from "../src/learning/contract";

// extractLearnings now goes through completeText() (streaming) instead of
// generateText(), which is required for the ChatGPT Codex backend. Mock
// completeText to return the raw model text directly.
//
// One capture pass can make SEVERAL completeText calls: the capture evaluator,
// then the vet, then (when the store holds entries with no contract hash) a
// re-vet of those. The mock dispatches on the prompt so each call gets the
// answer its own parser expects.
const completeTextMock = mock(async (_model: string, _opts: { prompt: string }) => "[]");

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

/** The vet prompt, distinguished from the evaluator prompt by its opening line. */
const isVetPrompt = (prompt: string) => prompt.includes("vetting candidate rules");

/** Pass every id the vet was shown. Ids it does not recognise are dropped by the
 *  vet itself, so over-answering is harmless. */
function vetAllPass(prompt: string): string {
  const ids = [...prompt.matchAll(/\(id ([A-Za-z0-9_-]+)\)/g)].map((m) => m[1]);
  return JSON.stringify(ids.map((id) => ({ id, verdict: "pass" })));
}

/** The ids of the candidates being vetted (not the rules already in force). */
function candidateIds(prompt: string): string[] {
  const block = prompt.split("## Candidate rules to vet\n")[1]?.split("\n\n")[0] ?? "";
  return [...block.matchAll(/\(id ([A-Za-z0-9_-]+)\)/g)].map((m) => m[1]!);
}

/** Drive the evaluator call with `evaluator`, and answer every vet call with
 *  `vet` (all-pass by default). */
function respondWith(
  evaluator: () => string | Promise<string>,
  vet: (prompt: string) => string = vetAllPass,
): void {
  completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) =>
    isVetPrompt(opts.prompt) ? vet(opts.prompt) : await evaluator());
}

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

const INSTRUCTIONS = "Do things";
/** The contract hash stored entries must carry to count as vetted against the
 *  instructions these tests pass in. Without it they are re-vetted, which costs
 *  an extra model call the test would then have to answer. */
const CURRENT_HASH = hashInstructions(INSTRUCTIONS);

/** Corrections-only: the default capture mode since 0.18. */
const CORRECTIONS_ONLY = { capture: { addons: [] }, apply: false } as const;
/** Free-form observation capture, scoped by guidance — the opt-in that makes
 *  execution-derived learnings reachable at all. */
const WITH_CUSTOM = {
  capture: { addons: [], custom: "Record anything worth remembering." },
  apply: false,
} as const;

const ONE_AUTO_LEARNING = JSON.stringify([
  {
    source: "auto",
    category: "tip",
    title: "Shorten prompts",
    instruction: "Keep prompts concise to reduce token usage.",
    confidence: 0.9,
  },
]);

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
  // Default: the evaluator returns one execution-derived learning and the vet
  // passes everything.
  respondWith(() => ONE_AUTO_LEARNING);
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
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: WITH_CUSTOM,
    });

    expect(existsSync(learningsPath)).toBe(true);
    // The point of the move: the run wrote state, and the user's repository is
    // exactly as it was.
    expect(learningsPath.startsWith(xdgDir)).toBe(true);
    expect(existsSync(join(tempDir, "agents", "demo.agentuse.learnings.md"))).toBe(false);
    const content = readFileSync(learningsPath, "utf-8");
    expect(content).toContain("Shorten prompts");
    // Provenance is stamped as it is stored: the channel it came from, and the
    // contract it was vetted against.
    expect(content).toContain("ch:custom");
    expect(content).toContain(`ih:${CURRENT_HASH}`);
    expect(succeedMock).toHaveBeenCalledWith(
      `Extracted 1 learning(s) → ${learningsPath}`
    );
    expect(outcome).toEqual({
      status: "captured",
      source: "auto",
      count: 1,
      titles: ["Shorten prompts"],
      channels: { custom: { captured: 1, vettedOut: 0, quarantined: 0 } },
      quarantined: 0,
    });
  });

  it("makes no model call at all with no corrections and no free-form opt-in", async () => {
    // The corrections-only default has to be free when a run drew no comments,
    // or every run pays for a capture pass that can produce nothing.
    const outcome = await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: CORRECTIONS_ONLY,
    });

    expect(completeTextMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("none");
    expect(existsSync(learningsPath)).toBe(false);
  });

  it("skips persistence and reports a none outcome when no learnings are returned", async () => {
    respondWith(() => "[]");

    const outcome = await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: WITH_CUSTOM,
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
      injectedCount: 5,
      extractedAt: "2026-06-02T00:00:00.000Z",
      source: "manual",
      instructionsHash: CURRENT_HASH,
      reasserted: 0,
      approvedRuns: 0,
    }]);

    respondWith(() => JSON.stringify([{
      source: "auto",
      category: "warning",
      title: "Avoid lecturing",
      instruction: "Rewrite instruction shaped phrasing as the author's own lived observation always.",
      confidence: 0.9,
    }]));

    const outcome = await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: WITH_CUSTOM,
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
      injectedCount: 0,
      extractedAt: "2026-06-02T00:00:00.000Z",
      source: "approval" as const,
      instructionsHash: CURRENT_HASH,
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

    respondWith(() => JSON.stringify([{
      source: "approval",
      category: "warning",
      title: "Don't lecture the author",
      instruction: "Rewrite instruction shaped phrasing as the author's own lived observation, never a rule.",
      confidence: 0.95,
    }]));

    const outcome = await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      // Corrections-only: the reviewer comment is what makes the evaluator run.
      config: CORRECTIONS_ONLY,
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

    // The candidate then went through the vet, against the same rules in force.
    const vetPrompt = String(completeTextMock.mock.calls[1]?.[1]?.prompt ?? "");
    expect(isVetPrompt(vetPrompt)).toBe(true);
    expect(vetPrompt).toContain("(id dormant1)");

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

  it("quarantines a human correction the vet finds contradictory, never drops it", async () => {
    respondWith(
      () => JSON.stringify([{
        source: "approval",
        category: "warning",
        title: "Always cite a summary",
        instruction: "Cite the summary rather than the primary source.",
        confidence: 0.95,
      }]),
      (prompt) => JSON.stringify(candidateIds(prompt).map((id) => ({
        id,
        verdict: "contradiction",
        detail: "Cite the primary source, never a summary.",
      }))),
    );

    const outcome = await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: CORRECTIONS_ONLY,
      reviews: [{ comment: "cite the summary" }],
    });

    // Set aside with the conflict named — not injected, and not discarded: a
    // human wrote it, so silently dropping it is never allowed.
    expect(outcome.quarantined).toBe(1);
    expect(outcome.count).toBe(0);
    expect(outcome.channels?.corrections).toEqual({ captured: 0, vettedOut: 0, quarantined: 1 });
    const raw = readFileSync(learningsPath, "utf-8");
    expect(raw).toContain("state:quarantined");
    expect(raw).toContain("<!-- why: contradicts the contract: Cite the primary source, never a summary. -->");
  });

  it("rejects a model-authored duplicate outright rather than storing it", async () => {
    respondWith(
      () => ONE_AUTO_LEARNING,
      (prompt) => JSON.stringify(candidateIds(prompt).map((id) => ({
        id,
        verdict: "duplicate",
        detail: "Keep prompts concise.",
      }))),
    );

    const outcome = await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: WITH_CUSTOM,
    });

    // Nothing is lost — the rule the candidate restates already exists.
    expect(outcome.status).toBe("none");
    expect(outcome.channels?.custom).toEqual({ captured: 0, vettedOut: 1, quarantined: 0 });
    expect(existsSync(learningsPath)).toBe(false);
  });

  it("captures a tool-error recovery structurally, with no model call", async () => {
    const traced: AgentCompleteEvent = {
      ...event,
      result: {
        ...event.result,
        toolCalls: 2,
        toolCallTraces: [
          {
            name: "publish", type: "tool", startTime: 0, duration: 5, success: false,
            input: { path: "post.md" }, output: "Error: missing required field 'slug'",
          },
          {
            name: "publish", type: "tool", startTime: 1, duration: 5, success: true,
            input: { path: "post.md", slug: "post" }, output: "ok",
          },
        ],
      },
    };

    const outcome = await extractLearnings({
      event: traced,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: { capture: { addons: ["tool-errors"] }, apply: false },
    });

    // Structurally verified in code — the trace holds the failure, the corrected
    // call and the success — so this channel never asks a model anything.
    expect(completeTextMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("captured");
    expect(outcome.channels?.["tool-errors"]).toEqual({ captured: 1, vettedOut: 0, quarantined: 0 });
    const raw = readFileSync(learningsPath, "utf-8");
    expect(raw).toContain("ch:tool-errors");
    expect(raw).toContain("tool:publish");
    expect(raw).toContain("<!-- evidence: ");
  });

  it("re-vets a stored rule that predates contract hashing and stamps it", async () => {
    // A pre-0.18 store carries no `ih:` token. The first capture after the
    // upgrade checks those entries against the current contract and stamps the
    // ones that still hold, instead of injecting them unexamined forever.
    const store = LearningStore.fromAgentFile(agentFilePath, tempDir);
    await store.save([{
      id: "legacy01",
      category: "tip",
      title: "Legacy rule",
      instruction: "Something captured long before contract hashes existed here.",
      confidence: 0.9,
      injectedCount: 2,
      extractedAt: "2026-01-02T00:00:00.000Z",
      source: "auto",
      reasserted: 0,
      approvedRuns: 0,
    }]);

    respondWith(() => "[]");

    await extractLearnings({
      event,
      agentInstructions: INSTRUCTIONS,
      agentModel: "gpt-4",
      agentFilePath,
      stateRoot: tempDir,
      config: WITH_CUSTOM,
    });

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.instructionsHash).toBe(CURRENT_HASH);
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
      agentInstructions: INSTRUCTIONS,
      agentModel: "openai:gpt-5.5",
      agentFilePath,
      stateRoot: tempDir,
      config: WITH_CUSTOM,
    });

    expect(failMock).toHaveBeenCalledWith("Failed to extract learnings");
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("Stream must be set to true");
  });
});
