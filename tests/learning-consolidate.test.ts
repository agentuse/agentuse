import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LearningStore } from "../src/learning/store";
import type { Learning } from "../src/learning/types";

// The tidy-up runs in two passes: one call decides what relates to what (ids
// only), then one small call per group writes the replacement rule. The mock
// answers by prompt kind so every test can drive an exact decision and assert
// what the guardrails do with it.
let decideResponse = "{}";
let writeResponse = JSON.stringify({ category: "tip", title: "Merged", instruction: "One rule covering both." });

function isWriteCall(prompt: string): boolean {
  return prompt.includes("say substantially the same thing") || prompt.includes("has repeated this correction");
}

const completeTextMock = mock(async (_model: string, opts: { prompt: string }) =>
  isWriteCall(opts.prompt) ? writeResponse : decideResponse);
mock.module("../src/complete-text", () => ({ completeText: completeTextMock }));

/** Ids of the corrections a decide prompt was given, in prompt order. */
function idsIn(prompt: string): string[] {
  return [...prompt.matchAll(/id:(\w+) /g)].map((m) => m[1]!);
}

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
    decideResponse = JSON.stringify({});
    writeResponse = JSON.stringify({ category: "tip", title: "Merged", instruction: "One rule covering both." });
    completeTextMock.mockClear();
    // Restore the default implementation here rather than at the end of the
    // tests that override it: an assertion failing mid-test would otherwise
    // leave the stub broken and cascade into every test after it.
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) =>
      isWriteCall(opts.prompt) ? writeResponse : decideResponse);
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
    decideResponse = JSON.stringify({
      merge: [{ ids: ["rule0", "rule1"], keep: "rule0", why: "same thing" }],
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
    decideResponse = JSON.stringify({
      merge: [{ ids: ["keepme", "absorb"], keep: "keepme", why: "" }],
    });

    await run();

    const merged = (await store.load()).find((l) => l.id === "keepme")!;
    expect(merged.appliedCount).toBe(7);
    expect(merged.approvedRuns).toBe(2);
  });

  it("refuses to retire a rule a human wrote", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "human01", source: "manual" })]);
    decideResponse = JSON.stringify({ retire: [{ id: "human01", why: "looks stale" }] });

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
    decideResponse = JSON.stringify({ retire: [{ id: "fresh001", why: "not needed" }] });

    const result = await run();

    expect(result.retired).toBe(0);
  });

  it("refuses to retire a correction a human has repeated, since that is a rewrite case", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "repeat01", reasserted: 2 })]);
    decideResponse = JSON.stringify({ retire: [{ id: "repeat01", why: "redundant" }] });

    const result = await run();

    expect(result.retired).toBe(0);
  });

  it("rejects an unknown id, and an id already claimed by an earlier move", async () => {
    await seed();
    // `rule2` is otherwise graduation-eligible, so the ONLY reason the graduate
    // move can fail is that retire already claimed the id.
    await store.save((await store.load()).map((l) => (l.id === "rule2" ? { ...l, approvedRuns: 9 } : l)));
    decideResponse = JSON.stringify({
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
    decideResponse = JSON.stringify({ graduate: [{ id: "rule3", why: "feels right" }] });

    const result = await run();

    expect(result.graduated).toEqual([]);
    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
  });

  it("makes a proven rule permanent in the agent file and frees its cap slot", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "proven01", approvedRuns: 5, instruction: "Cite a source before publishing anything." })]);
    decideResponse = JSON.stringify({ graduate: [{ id: "proven01", why: "5 approved runs" }] });

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
    decideResponse = JSON.stringify({ graduate: [{ id: "proven01", why: "proven" }] });

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
    decideResponse = "I'm afraid I can't do that.";

    const result = await run();

    // The message quotes what came back: "unusable plan" with no evidence gives
    // the user nowhere to go.
    expect(result.note).toContain("did not return a usable plan");
    expect(result.note).toContain("I'm afraid I can't do that.");
    expect(await store.load()).toEqual(before);
  });

  it("asks for ids first and prose second, one call per group", async () => {
    // The split is the whole performance story: deciding sees everything and
    // writes almost nothing, writing sees almost nothing and produces all the
    // text. Fused, the job ran at the speed of writing, serially.
    await seed();
    decideResponse = JSON.stringify({
      merge: [{ ids: ["rule0", "rule1"], keep: "rule0", why: "same thing" }],
      retire: [{ id: "rule5", why: "superseded" }],
    });

    await run();

    const prompts = completeTextMock.mock.calls.map((c) => (c[1] as { prompt: string }).prompt);
    const decide = prompts.filter((p) => !isWriteCall(p));
    const writes = prompts.filter(isWriteCall);
    expect(decide).toHaveLength(1);
    expect(decide[0]).toContain("Do NOT write any replacement text");
    // One write for the merge, none for the retirement: a retirement needs no
    // wording and no longer waits behind text it never had a use for.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Guidance number rule0");
    expect(writes[0]).toContain("Guidance number rule1");
    // The write call is small on purpose: it must not carry the other ten.
    expect(writes[0]).not.toContain("Guidance number rule7");
  });

  it("leaves a group exactly as it was when its wording cannot be written", async () => {
    // The decision was sound; only the prose failed. Half-applying it would
    // retire an entry into a merge that never got written.
    await seed();
    decideResponse = JSON.stringify({
      merge: [{ ids: ["rule0", "rule1"], keep: "rule0", why: "same thing" }],
      retire: [{ id: "rule5", why: "superseded" }],
    });
    writeResponse = "I could not do that.";

    const result = await run();

    expect(result.merged).toBe(0);
    const loaded = await store.load();
    expect(loaded.find((l) => l.id === "rule1")!.state).toBeUndefined();
    expect(loaded.find((l) => l.id === "rule0")!.instruction).toContain("Guidance number rule0");
    // The retirement, which needed no wording, still lands.
    expect(loaded.find((l) => l.id === "rule5")!.state).toBe("retired");
    expect(result.note).toContain("1 rewrite could not be written");
  });

  it("covers a whole large file in one pass, one dead group costing only itself", async () => {
    // No ceiling on decide calls any more: they run concurrently, so a bigger
    // file costs tokens rather than the user's time, and one press finishes the
    // job instead of asking for three.
    await store.save(Array.from({ length: 130 }, (_, i) => learning({ id: `rule${String(i).padStart(3, "0")}` })));
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) => {
      if (isWriteCall(opts.prompt)) return writeResponse;
      const ids = idsIn(opts.prompt);
      if (ids.includes("rule000")) return "sorry, no";
      return JSON.stringify({ retire: [{ id: ids[0], why: "superseded" }] });
    });

    const result = await run();

    const decideCalls = completeTextMock.mock.calls
      .map((c) => (c[1] as { prompt: string }).prompt)
      .filter((p) => !isWriteCall(p));
    expect(decideCalls).toHaveLength(9);
    expect(result.retired).toBe(8);
    expect(result.note).toContain("1 of 9 groups");
  });

  it("dry run reports both diffs and touches neither file", async () => {
    await seed();
    await store.save([...(await store.load()), learning({ id: "proven01", approvedRuns: 5 })]);
    const storeBefore = readFileSync(store.filePath, "utf-8");
    decideResponse = JSON.stringify({
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
    decideResponse = JSON.stringify({
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

  it("keeps the calls it runs at once bounded", async () => {
    // Unbounded, a fleet-sized file would open thirty connections at once and
    // earn a rate limit, which costs far more time than the concurrency saved.
    await store.save(Array.from({ length: 40 }, (_, i) => learning({ id: `rule${String(i).padStart(2, "0")}` })));
    decideResponse = JSON.stringify({
      merge: Array.from({ length: 12 }, (_, i) => ({
        ids: [`rule${String(i * 2).padStart(2, "0")}`, `rule${String(i * 2 + 1).padStart(2, "0")}`],
        keep: `rule${String(i * 2).padStart(2, "0")}`,
        why: "same thing",
      })),
    });
    let inFlight = 0;
    let peak = 0;
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return isWriteCall(opts.prompt) ? writeResponse : decideResponse;
    });

    const result = await run();

    expect(result.merged).toBe(12);
    expect(peak).toBeGreaterThan(1); // they really do overlap
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("keeps undo history separate for two agents sharing a file name", async () => {
    // A shared history directory would let `undo` on one agent restore the
    // other's snapshot, silently reverting a file the user never touched.
    const other = join(tempDir, "nested");
    mkdirSync(other, { recursive: true });
    const otherAgent = join(other, "demo.agentuse");
    writeFileSync(otherAgent, AGENT_FILE);

    await seed();
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    await run();

    expect(await undoConsolidation(tempDir, otherAgent)).toBeNull();
    expect(await undoConsolidation(tempDir, agentFilePath)).not.toBeNull();
  });

  it("counts the rules as it writes them, not just the phase it is in", async () => {
    // The web page and the CLI both show this: a pass is minutes of model work,
    // and without it the only thing either surface can say is "please wait".
    // Writing is the long phase and it is the one that can honestly count.
    await seed();
    decideResponse = JSON.stringify({
      merge: [
        { ids: ["rule0", "rule1"], keep: "rule0", why: "same thing" },
        { ids: ["rule2", "rule3"], keep: "rule2", why: "same thing" },
      ],
    });
    const seen: string[] = [];

    await consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true },
      stateRoot: tempDir,
      now: NOW,
      onProgress: (p) => seen.push(`${p.phase}:${p.step}/${p.total}`),
    });

    expect(seen[0]).toBe("deciding:0/1");
    expect(seen).toContain("deciding:1/1");
    expect(seen).toContain("writing:0/2");
    expect(seen).toContain("writing:2/2");
    expect(seen).toContain("applying:2/2");
    expect(seen[seen.length - 1]).toBe("done:2/2");
  });

  it("reports no writing phase when nothing needs wording", async () => {
    // Retirements and graduations change state only. Announcing a writing phase
    // of zero would have the page claim work that never happens.
    await seed();
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    const seen: string[] = [];

    await consolidateLearnings({
      agentFilePath,
      agentInstructions: "Do the work.",
      agentModel: "demo:test",
      config: { capture: true, apply: true },
      stateRoot: tempDir,
      now: NOW,
      onProgress: (p) => seen.push(`${p.phase}:${p.step}/${p.total}`),
    });

    expect(seen.filter((s) => s.startsWith("writing:"))).toEqual(["writing:0/0"]);
  });
});

describe("who shares a decide call", () => {
  let orderForBatching: typeof import("../src/learning/consolidate").orderForBatching;

  beforeAll(async () => {
    orderForBatching = (await import("../src/learning/consolidate")).orderForBatching;
  });

  it("puts near-duplicates next to each other, whatever their rank order", async () => {
    // Decide calls have to be small, so two duplicates either side of a batch
    // boundary would never be compared and would both survive the pass. This
    // costs no model call and only decides who shares a call.
    const pair = [
      learning({ id: "dup1", title: "Never pipe browser commands", instruction: "Piping browser wrapper output through head or grep is blocked by the allowlist." }),
      learning({ id: "dup2", title: "Browser commands cannot be piped", instruction: "The allowlist blocks piping the browser wrapper output through head; call the wrapper alone." }),
    ];
    const filler = Array.from({ length: 6 }, (_, i) => learning({
      id: `pad${i}`,
      title: `Unrelated rule ${i}`,
      instruction: `Something entirely different about scheduling and store items, number ${i}.`,
    }));
    // Six unrelated corrections sit between them to start with.
    const scattered = [pair[0]!, ...filler, pair[1]!];

    const ordered = orderForBatching(scattered);

    const first = ordered.findIndex((l) => l.id === "dup1");
    const second = ordered.findIndex((l) => l.id === "dup2");
    expect(Math.abs(first - second)).toBe(1);
  });

  it("keeps every correction exactly once", () => {
    const all = Array.from({ length: 20 }, (_, i) => learning({ id: `rule${i}` }));
    const ordered = orderForBatching(all);
    expect(ordered).toHaveLength(20);
    expect(new Set(ordered.map((l) => l.id)).size).toBe(20);
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
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    completeTextMock.mockClear();
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) =>
      isWriteCall(opts.prompt) ? writeResponse : decideResponse);
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
