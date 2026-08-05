import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LearningStore } from "../src/learning/store";
import type { Learning } from "../src/learning/types";

// The tidy-up plans with one helper LLM call; mock it so every test drives an
// exact proposal and asserts what the guardrails do with it.
let planResponse = "{}";
const completeTextMock = mock(async () => planResponse);
mock.module("../src/complete-text", () => ({ completeText: completeTextMock }));

let consolidateLearnings: typeof import("../src/learning/consolidate").consolidateLearnings;
let undoConsolidation: typeof import("../src/learning/consolidate").undoConsolidation;

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const DAY = 86_400_000;

function learning(overrides: Partial<Learning> & { id: string }): Learning {
  return {
    category: "tip",
    title: `Rule ${overrides.id}`,
    instruction: `Guidance number ${overrides.id} covering separate territory entirely.`,
    confidence: 0.95,
    appliedCount: 0,
    // Old enough to retire unless a test says otherwise.
    extractedAt: new Date(NOW - 120 * DAY).toISOString(),
    source: "approval",
    reasserted: 0,
    approvedRuns: 0,
    ...overrides,
  };
}

const AGENT_FILE = `---
model: "anthropic:claude-sonnet-5"
learning: true
---

# Demo

Do the work.
`;

describe("tidying up an over-cap corrections file", () => {
  let tempDir: string;
  let agentFilePath: string;
  let store: LearningStore;

  beforeAll(async () => {
    const mod = await import("../src/learning/consolidate");
    consolidateLearnings = mod.consolidateLearnings;
    undoConsolidation = mod.undoConsolidation;
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-tidy-"));
    agentFilePath = join(tempDir, "demo.agentuse");
    writeFileSync(agentFilePath, AGENT_FILE);
    store = LearningStore.fromAgentFile(agentFilePath);
    planResponse = JSON.stringify({});
    completeTextMock.mockClear();
    // Restore the default implementation here rather than at the end of the
    // tests that override it: an assertion failing mid-test would otherwise
    // leave the stub broken and cascade into every test after it.
    completeTextMock.mockImplementation(async () => planResponse);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const run = (opts: { dryRun?: boolean } = {}) =>
    consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true },
      stateRoot: tempDir,
      now: NOW,
      ...opts,
    });

  /** 12 stored rules against a cap of 10: two over. */
  async function seed(extra: Partial<Learning>[] = []) {
    const base = Array.from({ length: 12 }, (_, i) => learning({ id: `rule${i}` }));
    await store.save([...base, ...extra.map((e) => learning({ id: "x", ...e } as Partial<Learning> & { id: string }))]);
  }

  it("spends no model call when everything already fits the cap", async () => {
    await store.save([learning({ id: "only1" })]);

    const result = await run();

    expect(result.ran).toBe(false);
    expect(completeTextMock).not.toHaveBeenCalled();
  });

  it("merges near-duplicates, retiring the absorbed entries rather than deleting them", async () => {
    await seed();
    planResponse = JSON.stringify({
      merge: [{ ids: ["rule0", "rule1"], keep: "rule0", title: "Merged", instruction: "One rule covering both.", why: "same thing" }],
    });

    const result = await run();

    expect(result.merged).toBe(1);
    const loaded = await store.load();
    expect(loaded.find((l) => l.id === "rule0")!.instruction).toBe("One rule covering both.");
    // Nothing is destroyed: the absorbed entry is archived, still readable.
    expect(loaded.find((l) => l.id === "rule1")!.state).toBe("retired");
    expect(loaded).toHaveLength(12);
  });

  it("takes the max applied and approved counts on a merge, never the sum", async () => {
    // Summing would manufacture the evidence that graduates the merged rule.
    await store.save([
      learning({ id: "keepme", appliedCount: 4, approvedRuns: 2 }),
      learning({ id: "absorb", appliedCount: 7, approvedRuns: 2, instruction: "Guidance number absorb covering separate territory entirely." }),
      ...Array.from({ length: 10 }, (_, i) => learning({ id: `pad${i}` })),
    ]);
    planResponse = JSON.stringify({
      merge: [{ ids: ["keepme", "absorb"], keep: "keepme", instruction: "Merged rule.", why: "" }],
    });

    await run();

    const merged = (await store.load()).find((l) => l.id === "keepme")!;
    expect(merged.appliedCount).toBe(7);
    expect(merged.approvedRuns).toBe(2);
  });

  it("refuses to retire a rule a human wrote", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "human01", source: "manual" })]);
    planResponse = JSON.stringify({ retire: [{ id: "human01", why: "looks stale" }] });

    const result = await run();

    expect(result.retired).toBe(0);
    expect((await store.load()).find((l) => l.id === "human01")!.state).toBeUndefined();
  });

  it("refuses to retire a correction younger than two weeks", async () => {
    await seed();
    await store.save([
      ...(await store.load()),
      learning({ id: "fresh001", extractedAt: new Date(NOW - 3 * DAY).toISOString() }),
    ]);
    planResponse = JSON.stringify({ retire: [{ id: "fresh001", why: "not needed" }] });

    const result = await run();

    expect(result.retired).toBe(0);
  });

  it("refuses to retire a correction a human has repeated, since that is a rewrite case", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "repeat01", reasserted: 2 })]);
    planResponse = JSON.stringify({ retire: [{ id: "repeat01", why: "redundant" }] });

    const result = await run();

    expect(result.retired).toBe(0);
  });

  it("rejects an unknown id, and an id already claimed by an earlier move", async () => {
    await seed();
    // `rule2` is otherwise graduation-eligible, so the ONLY reason the graduate
    // move can fail is that retire already claimed the id.
    await store.save((await store.load()).map((l) => (l.id === "rule2" ? { ...l, approvedRuns: 9 } : l)));
    planResponse = JSON.stringify({
      retire: [{ id: "nosuchid", why: "" }, { id: "rule2", why: "superseded" }],
      graduate: [{ id: "rule2", why: "double-claimed" }],
    });

    const result = await run();

    expect(result.retired).toBe(1);
    expect(result.graduated).toEqual([]);
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
  });

  it("refuses to make a rule permanent before it has a track record", async () => {
    await seed();
    planResponse = JSON.stringify({ graduate: [{ id: "rule3", why: "feels right" }] });

    const result = await run();

    expect(result.graduated).toEqual([]);
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
  });

  it("makes a proven rule permanent in the agent file and frees its cap slot", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "proven01", approvedRuns: 5, instruction: "Cite a source before publishing anything." })]);
    planResponse = JSON.stringify({ graduate: [{ id: "proven01", why: "5 approved runs" }] });

    const result = await run();

    expect(result.graduated).toEqual(["Rule proven01"]);
    expect(readFileSync(agentFilePath, "utf-8")).toContain("Cite a source before publishing anything.");
    expect((await store.load()).find((l) => l.id === "proven01")!.state).toBe("graduated");
    // Both diffs are produced, because the change landed in two files.
    expect(result.diffs.learnings).not.toBe("");
    expect(result.diffs.agentFile).toBeTruthy();
  });

  it("never edits an agent file that shares its corrections with other agents", async () => {
    const shared = join(tempDir, "shared.md");
    const sharedStore = new LearningStore(shared);
    await sharedStore.save([
      ...Array.from({ length: 12 }, (_, i) => learning({ id: `rule${i}` })),
      learning({ id: "proven01", approvedRuns: 5 }),
    ]);
    planResponse = JSON.stringify({ graduate: [{ id: "proven01", why: "proven" }] });

    const result = await consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true, file: "./shared.md" },
      stateRoot: tempDir,
      now: NOW,
    });

    expect(result.graduated).toEqual([]);
    expect(result.graduationSkipped).toContain("shares its learnings file");
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
  });

  it("writes nothing when the model returns an unusable plan", async () => {
    await seed();
    const before = await store.load();
    planResponse = "I'm afraid I can't do that.";

    const result = await run();

    // The message quotes what came back: "unusable plan" with no evidence gives
    // the user nowhere to go.
    expect(result.note).toContain("did not return a usable plan");
    expect(result.note).toContain("I'm afraid I can't do that.");
    expect(await store.load()).toEqual(before);
  });

  it("plans in batches, so one dead batch costs that batch and not the whole tidy-up", async () => {
    // 60 corrections is three batches. The first returns junk; the rest must
    // still be planned and applied.
    await store.save(Array.from({ length: 60 }, (_, i) => learning({ id: `rule${String(i).padStart(2, "0")}` })));
    let call = 0;
    completeTextMock.mockImplementation(async () => {
      call++;
      if (call === 1) return "sorry, no";
      return JSON.stringify({ retire: [{ id: `rule${String(call * 25 - 25).padStart(2, "0")}`, why: "superseded" }] });
    });

    const result = await run();

    expect(call).toBeGreaterThan(1);
    expect(result.retired).toBeGreaterThan(0);
    expect(result.note).toContain("1 of 3 batches");
  });

  it("stops early once the goal is met instead of paying for every batch", async () => {
    // 26 corrections is two batches, but one retirement is enough to hit the
    // cap... it is not, so instead assert the inverse: a file barely over the
    // cap that gets fixed by the first batch never opens the second.
    await store.save(Array.from({ length: 26 }, (_, i) => learning({ id: `rule${String(i).padStart(2, "0")}` })));
    let call = 0;
    completeTextMock.mockImplementation(async () => {
      call++;
      // Ranking is newest-first and these entries tie on everything but file
      // position, so the LAST written land in batch one. Retire 16 of those.
      return JSON.stringify({
        retire: Array.from({ length: 16 }, (_, i) => ({ id: `rule${String(25 - i).padStart(2, "0")}`, why: "superseded" })),
      });
    });

    const result = await run();

    expect(call).toBe(1);
    expect(result.activeAfter).toBe(10);
  });

  it("dry run reports both diffs and touches neither file", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "proven01", approvedRuns: 5 })]);
    const storeBefore = readFileSync(store.filePath, "utf-8");
    planResponse = JSON.stringify({
      retire: [{ id: "rule4", why: "superseded" }],
      graduate: [{ id: "proven01", why: "proven" }],
    });

    const result = await run({ dryRun: true });

    expect(result.diffs.learnings).toContain("state:retired");
    expect(result.diffs.agentFile).toContain("agentuse:learned");
    expect(readFileSync(store.filePath, "utf-8")).toBe(storeBefore);
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
    expect(result.undoId).toBeUndefined();
  });

  it("undo restores both files to their exact prior bytes", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "proven01", approvedRuns: 5 })]);
    const storeBefore = readFileSync(store.filePath, "utf-8");
    planResponse = JSON.stringify({
      retire: [{ id: "rule4", why: "superseded" }],
      graduate: [{ id: "proven01", why: "proven" }],
    });

    const result = await run();
    expect(result.undoId).toBeTruthy();
    expect(readFileSync(agentFilePath, "utf-8")).not.toBe(AGENT_FILE);

    const restored = await undoConsolidation(tempDir, agentFilePath);

    expect(restored!.restored).toHaveLength(2);
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
    expect(readFileSync(store.filePath, "utf-8")).toBe(storeBefore);
  });

  it("reports nothing to undo when no tidy-up has run", async () => {
    expect(await undoConsolidation(tempDir, agentFilePath)).toBeNull();
  });

  it("bounds one invocation so a huge file cannot run for ten minutes", async () => {
    // 200 corrections is eight batches; a single pass must stop well short of
    // that, or the web button's request times out before anything is written.
    await store.save(Array.from({ length: 200 }, (_, i) => learning({ id: `rule${String(i).padStart(3, "0")}` })));
    let call = 0;
    completeTextMock.mockImplementation(async () => {
      call++;
      return JSON.stringify({});
    });

    await run();

    expect(call).toBe(3);
  });

  it("keeps undo history separate for two agents sharing a file name", async () => {
    // A shared history directory would let `undo` on one agent restore the
    // other's snapshot, silently reverting a file the user never touched.
    const other = join(tempDir, "nested");
    mkdirSync(other, { recursive: true });
    const otherAgent = join(other, "demo.agentuse");
    writeFileSync(otherAgent, AGENT_FILE);

    await seed();
    planResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    await run();

    expect(await undoConsolidation(tempDir, otherAgent)).toBeNull();
    expect(await undoConsolidation(tempDir, agentFilePath)).not.toBeNull();
  });

  it("reports which batch it is on, then that it is writing", async () => {
    // The web page and the CLI both show this: a pass is minutes of model work,
    // and without it the only thing either surface can say is "please wait".
    await store.save(Array.from({ length: 60 }, (_, i) => learning({ id: `rule${String(i).padStart(3, "0")}` })));
    const seen: string[] = [];

    await consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true },
      stateRoot: tempDir,
      now: NOW,
      onProgress: (p) => seen.push(`${p.phase}:${p.batch}/${p.batches}`),
    });

    expect(seen.slice(0, 3)).toEqual(["planning:1/3", "planning:2/3", "planning:3/3"]);
    expect(seen).toContain("applying:3/3");
  });

  it("stops reporting progress once the file is back under the cap", async () => {
    // The early exit is the point: an agent two over the cap should not sit
    // through three batches of progress it never needed.
    await seed();
    planResponse = JSON.stringify({
      retire: [{ id: "rule4", why: "superseded" }, { id: "rule5", why: "superseded" }],
    });
    const planned: number[] = [];

    await consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true },
      stateRoot: tempDir,
      now: NOW,
      onProgress: (p) => { if (p.phase === "planning") planned.push(p.batch); },
    });

    expect(planned).toEqual([1]);
  });
});

describe("the record of an agent's last tidy-up", () => {
  let tempDir: string;
  let agentFilePath: string;
  let store: LearningStore;
  let mod: typeof import("../src/learning/consolidate");

  beforeAll(async () => {
    mod = await import("../src/learning/consolidate");
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-record-"));
    agentFilePath = join(tempDir, "demo.agentuse");
    writeFileSync(agentFilePath, AGENT_FILE);
    store = LearningStore.fromAgentFile(agentFilePath);
    planResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    completeTextMock.mockClear();
    completeTextMock.mockImplementation(async () => planResponse);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const record = (over: Partial<import("../src/learning/consolidate").TidyRecord> = {}) => ({
    jobId: "job-1",
    agentFilePath,
    startedAt: NOW,
    finishedAt: NOW + 1000,
    result: {
      ran: true, activeBefore: 12, activeAfter: 11, cap: 10, changes: [],
      merged: 0, rewritten: 0, retired: 1, graduated: [], diffs: { learnings: "" },
    },
    ...over,
  });

  it("survives a restart: written once, readable later, gone after undo", async () => {
    // The whole reason it is on disk. A tidy-up rewrote two files, and the offer
    // to undo it has to outlive the browser tab that started the run.
    expect(await mod.readTidyRecord(tempDir, agentFilePath)).toBeNull();

    await mod.writeTidyRecord(tempDir, agentFilePath, record());
    expect((await mod.readTidyRecord(tempDir, agentFilePath))!.jobId).toBe("job-1");

    await mod.clearTidyRecord(tempDir, agentFilePath);
    expect(await mod.readTidyRecord(tempDir, agentFilePath)).toBeNull();
  });

  it("is not mistaken for an undo snapshot", async () => {
    // It lives in the snapshot directory. Listed as one, undo would try to
    // restore the record's own JSON over the user's agent file.
    await store.save(Array.from({ length: 12 }, (_, i) => learning({ id: `rule${i}` })));
    await mod.writeTidyRecord(tempDir, agentFilePath, record());

    await mod.consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true },
      stateRoot: tempDir,
      now: NOW,
    });
    const restored = await mod.undoConsolidation(tempDir, agentFilePath);

    expect(restored!.restored).toEqual([store.filePath, agentFilePath]);
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
    // Undoing a tidy-up does not throw away the record of a different one.
    expect(await mod.readTidyRecord(tempDir, agentFilePath)).not.toBeNull();
  });

  it("keeps one agent's record out of another's, file names alike", async () => {
    const nested = join(tempDir, "nested");
    mkdirSync(nested, { recursive: true });
    const otherAgent = join(nested, "demo.agentuse");
    writeFileSync(otherAgent, AGENT_FILE);

    await mod.writeTidyRecord(tempDir, agentFilePath, record());

    expect(await mod.readTidyRecord(tempDir, otherAgent)).toBeNull();
  });
});
