/**
 * Quarantine in the store. A candidate the vet rejects is not deleted and not
 * injected: it is kept with its reason, visible in the CLI, the serve UI and
 * doctor. That makes three things load-bearing here — the reason survives the
 * round trip, a quarantined entry never competes for a cap slot or merges into
 * an active rule, and it is not swept up by the read-time drop that retired
 * entries get.
 *
 * The `applied:` → `injected:` rename rides along, because both are properties
 * of the same metadata line.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { LearningStore } from "../src/learning/store";
import { activeLearnings, partitionLearnings } from "../src/learning/ranking";
import type { Learning, LearningDraft } from "../src/learning/types";

const base: Learning = {
  id: "learn001",
  category: "tip",
  title: "Sanitize inputs",
  instruction: "Always sanitize user input before executing shell commands.",
  confidence: 0.92,
  injectedCount: 0,
  extractedAt: "2026-06-02T00:00:00.000Z",
  source: "auto",
  reasserted: 0,
  approvedRuns: 0,
};

const quarantined = (over: Partial<Learning> = {}): Learning => ({
  ...base,
  id: "quar0001",
  title: "Cite the summary",
  instruction: "Cite the summary rather than the primary source.",
  source: "approval",
  state: "quarantined",
  quarantineReason: "contradicts the contract: Cite the primary source, never a summary.",
  ...over,
});

describe("quarantined learnings in the store", () => {
  let tempDir: string;
  let projectRoot: string;
  let agentFile: string;
  let store: LearningStore;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-quarantine-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(tempDir, "state");

    projectRoot = join(tempDir, "project");
    agentFile = join(projectRoot, "agents", "blog.agentuse");
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, "---\nmodel: demo:test\n---\nDo work.\n");

    store = LearningStore.fromAgentFile(agentFile, projectRoot);
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips the state and the reason it was set aside", async () => {
    await store.save([base, quarantined()]);

    const raw = readFileSync(store.filePath, "utf-8");
    expect(raw).toContain("state:quarantined");
    expect(raw).toContain("<!-- why: contradicts the contract: Cite the primary source, never a summary. -->");

    const loaded = await store.load();
    // Unlike a retired entry, it is NOT dropped on read: staying visible with its
    // reason is the whole point.
    expect(loaded).toHaveLength(2);
    const set = loaded.find((l) => l.id === "quar0001")!;
    expect(set.state).toBe("quarantined");
    expect(set.quarantineReason).toBe("contradicts the contract: Cite the primary source, never a summary.");
    // The reason is peeled off the head of the body, so the instruction itself
    // comes back clean.
    expect(set.instruction).toBe("Cite the summary rather than the primary source.");
    // And a second save is byte-stable.
    expect(store.render(loaded)).toBe(raw);
  });

  it("keeps a quarantined entry out of the active set and out of both injection buckets", async () => {
    const all = [base, quarantined()];

    expect(activeLearnings(all).map((l) => l.id)).toEqual(["learn001"]);
    const { injected, dormant } = partitionLearnings(all);
    expect(injected.map((l) => l.id)).toEqual(["learn001"]);
    expect(dormant).toEqual([]);
  });

  it("stores a quarantined draft without spending a cap slot", async () => {
    const fill = Array.from({ length: 3 }, (_, i) => ({
      ...base,
      id: `fill000${i}`,
      title: `Rule ${i}`,
      instruction: `Skip subject ${i} entirely, whatever else happens here.`,
      extractedAt: `2026-06-0${i + 1}T00:00:00.000Z`,
    }));
    await store.save(fill);

    const draft: LearningDraft = quarantined({ id: "quar0002" });
    const result = await store.addOrEscalate([draft], { cap: 3 });

    expect(result.quarantined.map((l) => l.id)).toEqual(["quar0002"]);
    expect(result.inserted).toHaveLength(0);
    // Nothing was traded away to fit it, and the set is not reported as over cap:
    // an entry that is never injected costs no slot.
    expect(result.retired).toHaveLength(0);
    expect(result.refused).toHaveLength(0);
    expect(result.overCap).toBe(0);

    const loaded = await store.load();
    expect(loaded).toHaveLength(4);
    expect(activeLearnings(loaded)).toHaveLength(3);
  });

  it("judges a later candidate on its own vet instead of merging it into a quarantined entry", async () => {
    // Quarantined entries are set aside, not part of the working set. Merging
    // into one would silently bury a fresh candidate in a rejection it never got.
    await store.save([quarantined()]);

    const result = await store.addOrEscalate([{
      ...base,
      id: "fresh001",
      title: "Cite the summary again",
      instruction: "Cite the summary rather than the primary source please.",
      source: "approval",
    }]);

    expect(result.escalated).toHaveLength(0);
    expect(result.inserted.map((l) => l.id)).toEqual(["fresh001"]);
    expect((await store.load())).toHaveLength(2);
  });

  it("reads a pre-0.19 applied: counter and rewrites it under the new name", async () => {
    // `injectedCount` is the same number under an honest name: it counts what
    // injection COST, not evidence a rule worked. Old files keep loading.
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(store.filePath, [
      "# Learnings for blog",
      "",
      "### [tip] Sanitize inputs",
      "<!-- id:old00001 | confidence:0.92 | applied:7 | src:auto | 2026-01-02 -->",
      "Always sanitize user input before executing shell commands.",
      "",
    ].join("\n"));

    const loaded = await store.load();
    expect(loaded[0]!.injectedCount).toBe(7);

    await store.save(loaded);
    const raw = readFileSync(store.filePath, "utf-8");
    expect(raw).toContain("injected:7");
    expect(raw).not.toContain("applied:");
    // And the rewritten file still reads back the same.
    expect((await store.load())[0]!.injectedCount).toBe(7);
  });

  it("prefers the new token when a file somehow carries both", async () => {
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(store.filePath, [
      "# Learnings for blog",
      "",
      "### [tip] Sanitize inputs",
      "<!-- id:old00001 | confidence:0.92 | injected:2 | applied:7 | src:auto | 2026-01-02 -->",
      "Always sanitize user input before executing shell commands.",
      "",
    ].join("\n"));

    expect((await store.load())[0]!.injectedCount).toBe(2);
  });
});
