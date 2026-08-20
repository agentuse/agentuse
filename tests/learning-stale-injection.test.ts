/**
 * Injection-time staleness. A learning records the contract it was vetted
 * against; when the human rewrites that contract, injecting the rule unexamined
 * is the failure hash provenance exists to stop. It is held back — not deleted,
 * not silently dropped — until the next capture or tidy pass re-vets it.
 *
 * Legacy entries carrying no hash at all are the deliberate exception: treating
 * "unknown" as "stale" would disarm every pre-0.18 store on upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { LearningStore } from "../src/learning/store";
import { hashInstructions } from "../src/learning/contract";
import type { Learning } from "../src/learning/types";
import { buildLearningPrompt, previewLearningPrompt } from "../src/runner/system-messages";

const INSTRUCTIONS = "Do work.";

const learning = (over: Partial<Learning> & { id: string }): Learning => ({
  category: "tip",
  title: `Rule ${over.id}`,
  instruction: `Guidance for ${over.id} about a wholly separate subject.`,
  confidence: 0.9,
  injectedCount: 0,
  extractedAt: "2026-06-01T00:00:00.000Z",
  source: "approval",
  reasserted: 0,
  approvedRuns: 0,
  ...over,
});

describe("stale learnings are held out of the injected prompt", () => {
  let tempDir: string;
  let projectRoot: string;
  let agentFile: string;
  let store: LearningStore;
  let originalXdg: string | undefined;

  const agent = {
    name: "agent",
    instructions: INSTRUCTIONS,
    config: {
      model: "demo:test",
      skills: { auto: false, trusted: false, explicit: {} },
      learning: { capture: { addons: [] }, apply: true },
    },
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-stale-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(tempDir, "state");

    projectRoot = join(tempDir, "project");
    agentFile = join(projectRoot, "agents", "blog.agentuse");
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, `---\nmodel: demo:test\n---\n${INSTRUCTIONS}\n`);

    store = LearningStore.fromAgentFile(agentFile, projectRoot);
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips the entry whose contract hash no longer matches, and keeps the legacy one", async () => {
    await store.save([
      // Vetted against instructions that no longer exist.
      learning({ id: "stale001", title: "Stale", instruction: "Written against an older contract entirely.", instructionsHash: hashInstructions("A completely different agent.") }),
      // Pre-0.18: no hash recorded, so it stays injectable until a pass backfills it.
      learning({ id: "legacy01", title: "Legacy", instruction: "Written before contract hashes existed here." }),
      // Vetted against the current contract.
      learning({ id: "fresh001", title: "Fresh", instruction: "Written against the contract now in force." }),
    ]);

    const result = await buildLearningPrompt(agent as never, agentFile, projectRoot);

    expect(result?.prompt).not.toContain("Written against an older contract entirely.");
    expect(result?.prompt).toContain("Written before contract hashes existed here.");
    expect(result?.prompt).toContain("Written against the contract now in force.");
    expect(result?.injectedIds.sort()).toEqual(["fresh001", "legacy01"]);
    expect(result?.count).toBe(2);
    expect(result?.stale).toBe(1);
    // Held back, not lost: the stale entry still counts toward the active total
    // the run banner reports.
    expect(result?.total).toBe(3);
  });

  it("does not bump the injection counter of a held-back entry", async () => {
    await store.save([
      learning({ id: "stale001", injectedCount: 4, instructionsHash: hashInstructions("Some other contract.") }),
      learning({ id: "fresh001", instruction: "Written against the contract now in force." }),
    ]);

    await buildLearningPrompt(agent as never, agentFile, projectRoot);
    // The counter is bumped without awaiting, so give the write a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const loaded = await store.load();
    expect(loaded.find((l) => l.id === "stale001")!.injectedCount).toBe(4);
    expect(loaded.find((l) => l.id === "fresh001")!.injectedCount).toBe(1);
  });

  it("reports nothing to inject when every active rule is stale", async () => {
    await store.save([
      learning({ id: "stale001", instructionsHash: hashInstructions("Some other contract.") }),
    ]);

    expect(await buildLearningPrompt(agent as never, agentFile, projectRoot)).toBeUndefined();
  });

  it("reports the same split from the read-only preview", async () => {
    await store.save([
      learning({ id: "stale001", instructionsHash: hashInstructions("Some other contract.") }),
      learning({ id: "fresh001", instruction: "Written against the contract now in force." }),
    ]);

    const preview = await previewLearningPrompt(agent as never, agentFile, projectRoot);

    expect(preview?.stale).toBe(1);
    expect(preview?.count).toBe(1);
    // A diagnostic must not mutate what it measures.
    expect((await store.load()).every((l) => l.injectedCount === 0)).toBe(true);
  });

  it("ignores the graduated block when deciding what is stale", async () => {
    // The block is the learning system's own output. If it counted toward the
    // hash, one rule graduating would mark every other rule stale — a
    // self-invalidation loop with no new information in it.
    const withBlock = {
      ...agent,
      instructions: `${INSTRUCTIONS}\n\n<!-- agentuse:learned -->\n## Learned Guidelines\n\n- [tip] Something graduated.\n<!-- /agentuse:learned -->\n`,
    };
    await store.save([
      learning({ id: "fresh001", instructionsHash: hashInstructions(INSTRUCTIONS), instruction: "Written against the contract now in force." }),
    ]);

    const result = await buildLearningPrompt(withBlock as never, agentFile, projectRoot);

    expect(result?.stale).toBe(0);
    expect(result?.count).toBe(1);
  });
});
