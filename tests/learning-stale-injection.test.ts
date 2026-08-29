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

  it("returns diagnostics when every active rule is stale", async () => {
    await store.save([
      learning({ id: "stale001", instructionsHash: hashInstructions("Some other contract.") }),
    ]);

    expect(await buildLearningPrompt(agent as never, agentFile, projectRoot)).toEqual({
      count: 0,
      total: 1,
      injectedIds: [],
      cap: 15,
      stale: 1,
    });
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

  it("holds back rules after a human edits the permanent learned block", async () => {
    const beforeEdit = `${INSTRUCTIONS}\n\n<!-- agentuse:learned -->\n## Learned Guidelines\n\n- [tip] Keep introductions short.\n<!-- /agentuse:learned -->\n`;
    const afterEdit = {
      ...agent,
      instructions: beforeEdit.replace("Keep introductions short.", "Include a detailed introduction."),
    };
    await store.save([
      learning({ id: "stale001", instructionsHash: hashInstructions(beforeEdit), instruction: "Keep every introduction to one sentence." }),
    ]);

    expect((await buildLearningPrompt(afterEdit as never, agentFile, projectRoot))?.stale).toBe(1);
  });
});
