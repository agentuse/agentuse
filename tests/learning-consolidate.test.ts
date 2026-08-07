import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LearningStore } from "../src/learning/store";
import { getProjectDirSync } from "../src/storage/paths";
import { LEARNED_BLOCK_START } from "../src/learning/graduate";
import type { Learning } from "../src/learning/types";
import { createLearningsCommand } from "../src/cli/learnings";

// Corrections and undo snapshots are generated state under $XDG_DATA_HOME, not
// files in the user's repo. Every describe block points it at a temp directory,
// or the suite would write into the developer's real ~/.local/share/agentuse.
const priorXdgDataHome = process.env.XDG_DATA_HOME;

afterAll(() => {
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdgDataHome;
});

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
let reconcileConcurrentLearnings: typeof import("../src/learning/consolidate").reconcileConcurrentLearnings;

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
  let xdgDir: string;
  let agentFilePath: string;
  let store: LearningStore;

  beforeAll(async () => {
    const mod = await import("../src/learning/consolidate");
    consolidateLearnings = mod.consolidateLearnings;
    undoConsolidation = mod.undoConsolidation;
    reconcileConcurrentLearnings = mod.reconcileConcurrentLearnings;
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-tidy-"));
    xdgDir = mkdtempSync(join(tmpdir(), "learning-tidy-xdg-"));
    process.env.XDG_DATA_HOME = xdgDir;
    agentFilePath = join(tempDir, "demo.agentuse");
    writeFileSync(agentFilePath, AGENT_FILE);
    // `tempDir` is the state root, so the store resolves to
    // {xdgDir}/agentuse/project/{hash}/learnings/demo.learnings.md — the same
    // file the tidy-up under test opens.
    store = LearningStore.fromAgentFile(agentFilePath, tempDir);
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
    rmSync(xdgDir, { recursive: true, force: true });
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

  /** Undo snapshots live beside the corrections file they roll back, under the
   *  project's state directory — not in `{stateRoot}/.agentuse/`, which put a
   *  `?? .agentuse/consolidations/` in `git status` after every tidy-up. */
  const consolidationsDir = () => join(getProjectDirSync(tempDir), "consolidations");

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

  // Root ignores the mode bits, so the only way to make a file unwritable there
  // is not to be root. Skipped rather than asserted-around: a test that quietly
  // proves nothing is worse than one that says it did not run.
  it.skipIf(process.getuid?.() === 0)("never edits an agent file it cannot write, and says so", async () => {
    // The only remaining reason graduation can be blocked. (It used to also
    // cover an agent whose `learning.file` pointed at a shared corrections file;
    // that config key no longer exists, and every agent now has a file of its
    // own keyed by agent id, so the case is unreachable rather than untested.)
    await seed();
    await store.save([...(await store.load()), learning({ id: "proven01", approvedRuns: 5 })]);
    decideResponse = JSON.stringify({ graduate: [{ id: "proven01", why: "proven" }] });
    chmodSync(agentFilePath, 0o444);

    try {
      const result = await run();

      expect(result.graduated).toEqual([]);
      expect(result.graduationSkipped).toContain("not writable");
      expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
    } finally {
      chmodSync(agentFilePath, 0o644);
    }
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

    const prompts = completeTextMock.mock.calls.map((call) => (call[1] as { prompt: string }).prompt);
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
    // Counted once, though a later round retried the same group and failed
    // again: the user has one broken rule, not two.
    expect(result.note).toContain("1 rewrite could not be written");
  });

  it("covers a whole large file, one dead group costing only itself", async () => {
    // No ceiling on decide calls: they run concurrently, so a bigger file costs
    // tokens rather than the user's time.
    await store.save(Array.from({ length: 130 }, (_, i) => learning({ id: `rule${String(i).padStart(3, "0")}` })));
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) => {
      if (isWriteCall(opts.prompt)) return writeResponse;
      const ids = idsIn(opts.prompt);
      if (ids.includes("rule000")) return "sorry, no";
      return JSON.stringify({ retire: [{ id: ids[0], why: "superseded" }] });
    });

    const result = await run();

    const decideCalls = completeTextMock.mock.calls
      .map((call) => (call[1] as { prompt: string }).prompt)
      .filter((prompt: string) => !isWriteCall(prompt));
    // Nine groups on the first pass, and the one that came back unreadable took
    // nothing else down with it: the other eight all retired their first entry.
    expect(decideCalls.length).toBeGreaterThanOrEqual(9);
    // Exactly one group per pass came back unreadable, and every other group
    // retired its first entry: the dead one cost itself and nothing else.
    expect(result.retired).toBe(decideCalls.length - result.rounds);
    expect(result.note).toContain(`${result.rounds} of ${decideCalls.length} groups`);
  });

  it("keeps going by itself until another pass would not help", async () => {
    // The whole point: a long list used to need the button pressed five times,
    // with nothing on screen saying how many more presses were coming.
    await store.save(Array.from({ length: 20 }, (_, i) => learning({ id: `rule${String(i).padStart(2, "0")}` })));
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) => {
      if (isWriteCall(opts.prompt)) return writeResponse;
      // Retire two per pass, so it takes five passes to reach the cap of 10.
      const ids = idsIn(opts.prompt);
      return JSON.stringify({ retire: ids.slice(0, 2).map((id) => ({ id, why: "superseded" })) });
    });

    const result = await run();

    expect(result.rounds).toBeGreaterThan(1);
    expect(result.retired).toBeGreaterThanOrEqual(10);
    expect(result.activeAfter).toBeLessThanOrEqual(result.cap);
    // It reached the cap, so there is nothing left to explain.
    expect(result.remaining).toBeUndefined();
    // One press, one undo: the rounds happen in memory and both files are
    // written once at the end.
    const snapshots = readdirSync(consolidationsDir()).flatMap((d) =>
      readdirSync(join(consolidationsDir(), d)),
    );
    expect(snapshots).toHaveLength(1);
  });

  it("keeps its undo snapshots out of the user's repository", async () => {
    await seed();
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });

    const result = await run();

    expect(result.undoId).toBeTruthy();
    expect(consolidationsDir().startsWith(xdgDir)).toBe(true);
    const dirs = readdirSync(consolidationsDir());
    expect(dirs).toHaveLength(1);
    expect(readdirSync(join(consolidationsDir(), dirs[0]!))).toHaveLength(1);
    // The whole point of the move: the tidy-up wrote state, and the project
    // directory has nothing new in it to commit or ignore.
    expect(existsSync(join(tempDir, ".agentuse"))).toBe(false);
  });

  it("stops the moment a pass stops paying, rather than running the limit out", async () => {
    await seed();
    // The model finds one merge and then nothing: a second pass proposes the
    // same ids, which no longer exist, so it frees nothing.
    decideResponse = JSON.stringify({ merge: [{ ids: ["rule0", "rule1"], keep: "rule0", why: "same thing" }] });

    const result = await run();

    expect(result.rounds).toBe(2);
    expect(result.merged).toBe(1);
  });

  it("says why the corrections it left in force are still there", async () => {
    // "Still 20 over the cap, tidy up again" was the whole explanation a user
    // used to get after waiting a minute.
    await store.save([
      ...Array.from({ length: 8 }, (_, i) => learning({ id: `fresh${i}`, extractedAt: new Date(NOW - 2 * DAY).toISOString() })),
      ...Array.from({ length: 3 }, (_, i) => learning({ id: `mine${i}`, source: "manual" })),
      learning({ id: "repeated1", reasserted: 2 }),
      learning({ id: "plain1", approvedRuns: 1 }),
    ]);
    decideResponse = JSON.stringify({});

    const result = await run();

    const remaining = result.remaining!;
    expect(remaining.active).toBe(13);
    expect(remaining.cap).toBe(10);
    expect(remaining.moreToDo).toBe(false);
    // Every remaining correction is accounted for exactly once.
    expect(remaining.reasons.reduce((n, r) => n + r.count, 0)).toBe(13);
    expect(remaining.reasons.find((r) => r.because.includes("14 days old"))!.count).toBe(8);
    expect(remaining.reasons.find((r) => r.because.includes("by hand"))!.count).toBe(3);
    expect(remaining.reasons.find((r) => r.because.includes("more than once"))!.count).toBe(1);
    expect(remaining.reasons.find((r) => r.because.includes("say different things"))!.count).toBe(1);
    // Three of these are hand-written, and a hand-written rule can become
    // permanent whenever the model picks it, so waiting is not what is holding
    // this file up and saying it would be a red herring.
    expect(remaining.graduationWait).toBeUndefined();
  });

  it("answers the question people actually ask: why did nothing become permanent", async () => {
    // A distance, not a rule. "Needs three approved runs" is policy; "the
    // closest of them has one" is how far off they are.
    await store.save(Array.from({ length: 13 }, (_, i) => learning({ id: `rule${i}`, approvedRuns: i === 0 ? 1 : 0 })));
    decideResponse = JSON.stringify({});

    const result = await run();

    expect(result.remaining!.graduationWait).toContain("3 runs approved");
    expect(result.remaining!.graduationWait).toContain("has 1");
  });

  it("does not explain the leftovers when there are none", async () => {
    await seed();
    decideResponse = JSON.stringify({
      retire: [{ id: "rule4", why: "superseded" }, { id: "rule5", why: "superseded" }],
    });

    const result = await run();

    expect(result.activeAfter).toBe(10);
    expect(result.remaining).toBeUndefined();
  });

  it("says there is more to do when it stopped at the pass limit", async () => {
    await store.save(Array.from({ length: 40 }, (_, i) => learning({ id: `rule${String(i).padStart(2, "0")}` })));
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) => {
      if (isWriteCall(opts.prompt)) return writeResponse;
      const ids = idsIn(opts.prompt);
      return JSON.stringify({ retire: [{ id: ids[0], why: "superseded" }] });
    });

    const result = await run();

    expect(result.rounds).toBe(5);
    expect(result.activeAfter).toBeGreaterThan(result.cap);
    // Pressing again really would get further, so it says so instead of
    // claiming the rest are there on merit.
    expect(result.remaining!.moreToDo).toBe(true);
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

  it("CLI undo restores an agent even when the current file no longer parses", async () => {
    await seed();
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    const result = await run();
    expect(result.undoId).toBeTruthy();
    writeFileSync(agentFilePath, "---\ninvalid: [\n---\n");

    await createLearningsCommand().parseAsync(["undo", agentFilePath], { from: "user" });

    expect(readFileSync(agentFilePath, "utf-8")).toBe(AGENT_FILE);
  });

  it("preserves a correction captured while tidy-up was thinking", () => {
    const original = [learning({ id: "original" })];
    const proposed = [{ ...original[0]!, state: "retired" as const }];
    const captured = learning({ id: "captured", instruction: "A newly captured correction." });

    const reconciled = reconcileConcurrentLearnings(original, proposed, [...original, captured]);

    expect(reconciled.map((item) => item.id)).toEqual(["original", "captured"]);
    expect(reconciled[0]?.state).toBe("retired");
  });

  it("aborts instead of overwriting a correction changed concurrently", () => {
    const original = [learning({ id: "same" })];
    const proposed = [{ ...original[0]!, instruction: "Tidy wording." }];
    const concurrent = [{ ...original[0]!, appliedCount: 1 }];

    expect(() => reconcileConcurrentLearnings(original, proposed, concurrent))
      .toThrow("Nothing was overwritten");
  });

  it("reports nothing to undo when no tidy-up has run", async () => {
    expect(await undoConsolidation(tempDir, agentFilePath)).toBeNull();
  });

  it("reports nothing to undo once the history is spent, rather than failing", async () => {
    // This is what makes the snapshot move need no migration: snapshots left
    // behind at the old location are simply not found, and an absent snapshot
    // was always a supported state — the history is pruned anyway.
    await seed();
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    await run();

    expect(await undoConsolidation(tempDir, agentFilePath)).not.toBeNull();
    // The snapshot directory now exists but holds no snapshot, which is the
    // case a missing-file check alone would miss.
    expect(readdirSync(consolidationsDir())).toHaveLength(1);
    expect(await undoConsolidation(tempDir, agentFilePath)).toBeNull();
  });

  it("starts a renamed agent with an empty corrections file, its graduated rules still in force", async () => {
    // ACCEPTED LIMITATION, not a bug — pinned here so it stays a decision.
    // Corrections are keyed by the agent's path, so `git mv` orphans them; the
    // spec ships without rename recovery because the cost is bounded, and this
    // test is what states the bound: what a rename loses is the staging buffer,
    // and what it keeps is everything that earned its way into the agent file.
    await seed();
    await store.save([...(await store.load()), learning({
      id: "proven01",
      approvedRuns: 5,
      instruction: "Cite a source before publishing anything.",
    })]);
    decideResponse = JSON.stringify({ graduate: [{ id: "proven01", why: "5 approved runs" }] });
    await run();
    expect((await store.load()).length).toBeGreaterThan(0);

    const renamed = join(tempDir, "demo-renamed.agentuse");
    renameSync(agentFilePath, renamed);
    const afterRename = LearningStore.fromAgentFile(renamed, tempDir);

    // The buffer is gone: a different path is a different agent.
    expect(afterRename.filePath).not.toBe(store.filePath);
    expect(await afterRename.load()).toEqual([]);
    // The graduated rule is not lost with it. It lives in the agent file, which
    // the rename carried along, so it still reaches the model.
    const renamedText = readFileSync(renamed, "utf-8");
    expect(renamedText).toContain(LEARNED_BLOCK_START);
    expect(renamedText).toContain("Cite a source before publishing anything.");
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
    // Applying happens once, after the last pass: the files are written once
    // however many passes it took.
    expect(seen).toContain("applying:1/1");
    expect(seen[seen.length - 1]).toBe("done:1/1");
    expect(seen.every((s) => s.length > 0)).toBe(true);
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

    // One per pass, and never claiming work: a writing phase of two would have
    // the page count rules that are never written.
    expect(new Set(seen.filter((s) => s.startsWith("writing:")))).toEqual(new Set(["writing:0/0"]));
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
  let xdgDir: string;
  let agentFilePath: string;
  let store: LearningStore;
  let mod: typeof import("../src/learning/consolidate");

  beforeAll(async () => {
    mod = await import("../src/learning/consolidate");
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-record-"));
    xdgDir = mkdtempSync(join(tmpdir(), "learning-record-xdg-"));
    process.env.XDG_DATA_HOME = xdgDir;
    agentFilePath = join(tempDir, "demo.agentuse");
    writeFileSync(agentFilePath, AGENT_FILE);
    store = LearningStore.fromAgentFile(agentFilePath, tempDir);
    decideResponse = JSON.stringify({ retire: [{ id: "rule4", why: "superseded" }] });
    completeTextMock.mockClear();
    completeTextMock.mockImplementation(async (_model: string, opts: { prompt: string }) =>
      isWriteCall(opts.prompt) ? writeResponse : decideResponse);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(xdgDir, { recursive: true, force: true });
  });

  const record = (over: Partial<import("../src/learning/consolidate").TidyRecord> = {}) => ({
    jobId: "job-1",
    agentFilePath,
    startedAt: NOW,
    finishedAt: NOW + 1000,
    result: {
      ran: true, activeBefore: 12, activeAfter: 11, cap: 10, rounds: 1, changes: [],
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
