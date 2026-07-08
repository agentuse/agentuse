import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync } from "fs";
import { LearningStore, resolveLearningFilePath } from "../src/learning/store";
import type { Learning } from "../src/learning/types";
import { saveManualLearning } from "../src/learning";
import { buildLearningPrompt } from "../src/runner/system-messages";

const baseLearning: Learning = {
  id: "learn001",
  category: "tip",
  title: "Sanitize inputs",
  instruction: "Always sanitize user input before executing shell commands.",
  confidence: 0.92,
  appliedCount: 0,
  extractedAt: "2024-01-02T10:00:00.000Z",
  source: "auto",
};

describe("LearningStore", () => {
  let tempDir: string;
  let store: LearningStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-store-"));
    store = new LearningStore(join(tempDir, "agent.learnings.md"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves default and custom learning file paths", () => {
    const agentFile = join(tempDir, "agents", "blog.md");

    const defaultPath = resolveLearningFilePath(agentFile);
    expect(defaultPath.endsWith("agents/blog.learnings.md")).toBe(true);

    const customPath = resolveLearningFilePath(agentFile, "./notes/learnings.md");
    expect(customPath.endsWith("agents/notes/learnings.md")).toBe(true);
  });

  it("saves and loads learnings in markdown format", async () => {
    const learnings: Learning[] = [
      baseLearning,
      {
        ...baseLearning,
        id: "learn002",
        title: "Retry failures",
        instruction: "Retry transient tool failures once before aborting.",
        appliedCount: 2,
        extractedAt: "2024-02-10T00:00:00.000Z",
      },
    ];

    await store.save(learnings);
    const loaded = await store.load();

    expect(loaded).toHaveLength(2);
    expect(loaded[0].title).toBe("Sanitize inputs");
    expect(loaded[1].appliedCount).toBe(2);
    expect(loaded[1].extractedAt.startsWith("2024-02-10")).toBe(true);
  });

  it("round-trips provenance", async () => {
    await store.save([
      baseLearning,
      { ...baseLearning, id: "appr001", title: "Cite sources", source: "approval" },
      { ...baseLearning, id: "man001", title: "Use reviewer language", source: "manual" },
    ]);
    const loaded = await store.load();

    expect(loaded.find(l => l.id === "learn001")?.source).toBe("auto");
    const approval = loaded.find(l => l.id === "appr001");
    expect(approval?.source).toBe("approval");
    const manual = loaded.find(l => l.id === "man001");
    expect(manual?.source).toBe("manual");
  });

  it("round-trips session provenance and omits it when absent", async () => {
    await store.save([
      { ...baseLearning, id: "sess0001", title: "From a run", sessionId: "20260707-abc123" },
      { ...baseLearning, id: "nosess01", title: "Agent-level rule" },
    ]);
    const loaded = await store.load();

    expect(loaded.find(l => l.id === "sess0001")?.sessionId).toBe("20260707-abc123");
    expect(loaded.find(l => l.id === "nosess01")?.sessionId).toBeUndefined();
  });

  it("stamps the originating session on manual rules and re-owns upgraded ones", async () => {
    const agentFile = join(tempDir, "agent.md");

    await saveManualLearning({
      agentFilePath: agentFile,
      instruction: "Always include source links before publishing.",
      sessionId: "sess-one",
    });
    let loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sessionId).toBe("sess-one");

    // A similar rule re-asserted from another session upgrades in place and
    // takes over the session provenance.
    await saveManualLearning({
      agentFilePath: agentFile,
      instruction: "Always include source links when publishing.",
      sessionId: "sess-two",
    });
    loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sessionId).toBe("sess-two");
  });

  it("reads legacy learnings files written without a src field", async () => {
    // Pre-provenance format: metadata comment has no `src:` token.
    const legacy = `# Learnings for agent

### [warning] Never publish without review
<!-- id:old001 | confidence:0.88 | applied:3 | 2024-01-15 -->
Always wait for explicit approval before publishing.
`;
    writeFileSync(join(tempDir, "agent.learnings.md"), legacy);
    const loaded = await store.load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("old001");
    expect(loaded[0].confidence).toBe(0.88);
    expect(loaded[0].appliedCount).toBe(3);
    expect(loaded[0].source).toBe("auto"); // defaulted
  });

  it("deduplicates similar learnings when adding", async () => {
    await store.save([baseLearning]);

    await store.add([
      {
        ...baseLearning,
        id: "learn-dup",
        instruction: "Sanitize user input before executing shell commands to avoid issues.",
      },
    ]);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("learn001");
  });

  it("increments applied counts for specific learning IDs", async () => {
    const learnings = [
      baseLearning,
      { ...baseLearning, id: "learn003", title: "Log output", appliedCount: 1 },
    ];
    await store.save(learnings);

    await store.incrementApplied(["learn003"]);

    const loaded = await store.load();
    const updated = loaded.find(l => l.id === "learn003");
    expect(updated?.appliedCount).toBe(2);
  });

  it("saves explicit manual learnings", async () => {
    const agentFile = join(tempDir, "agent.md");

    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      config: { capture: true, apply: true },
      instruction: "Always include source links before publishing.",
    });

    expect(outcome.status).toBe("captured");
    expect(outcome.source).toBe("manual");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "manual",
      confidence: 1,
      instruction: "Always include source links before publishing.",
    });
  });

  it("saves a manual rule with no learning config (the reviewer's action is the opt-in)", async () => {
    const agentFile = join(tempDir, "agent.md");

    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      instruction: "Ask before deleting files.",
    });

    expect(outcome.status).toBe("captured");
    expect(outcome.source).toBe("manual");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "manual",
      confidence: 1,
      instruction: "Ask before deleting files.",
    });
  });

  it("upserts a manual rule by upgrading a similar existing learning instead of dropping it", async () => {
    const agentFile = join(tempDir, "agent.md");
    await store.save([
      {
        ...baseLearning,
        id: "auto001",
        title: "Source links",
        instruction: "always include source links when publishing reports",
        source: "auto",
        confidence: 0.5,
      },
    ]);

    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      config: { capture: true, apply: true },
      instruction: "Always include source links before publishing.",
    });

    expect(outcome.status).toBe("captured");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1); // upgraded in place, not silently dropped or duplicated
    expect(loaded[0].source).toBe("manual");
    expect(loaded[0].confidence).toBe(1);
    expect(loaded[0].instruction).toBe("Always include source links before publishing.");
  });

  it("upserts a manual rule as a fresh insert when nothing similar exists", async () => {
    const agentFile = join(tempDir, "agent.md");

    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      config: { capture: true, apply: true },
      instruction: "Never delete files without an explicit confirmation step.",
    });

    expect(outcome.status).toBe("captured");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe("manual");
  });

  it("generates distinct 8-char hex ids for dissimilar manual rules", async () => {
    const agentFile = join(tempDir, "agent.md");

    await saveManualLearning({
      agentFilePath: agentFile,
      config: { capture: true, apply: true },
      instruction: "Always cite primary sources in the final report.",
    });
    await saveManualLearning({
      agentFilePath: agentFile,
      config: { capture: true, apply: true },
      instruction: "Never delete files without an explicit confirmation step.",
    });

    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    for (const l of loaded) {
      expect(l.id).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(loaded[0].id).not.toBe(loaded[1].id);
  });

  it("injects manual learnings before approval and auto learnings", async () => {
    const agentFile = join(tempDir, "agent.md");
    await store.save([
      { ...baseLearning, id: "auto001", instruction: "Auto rule", source: "auto", confidence: 0.99 },
      { ...baseLearning, id: "appr001", instruction: "Approval rule", source: "approval", confidence: 0.95 },
      { ...baseLearning, id: "man001", instruction: "Manual rule", source: "manual", confidence: 1 },
    ]);

    const result = await buildLearningPrompt({
      name: "agent",
      instructions: "Do work.",
      config: { model: "demo:test", skills: { auto: false, trusted: false, explicit: {} }, learning: { capture: true, apply: true } },
    }, agentFile);

    const prompt = result?.prompt ?? "";
    expect(prompt.indexOf("Manual rule")).toBeLessThan(prompt.indexOf("Approval rule"));
    expect(prompt.indexOf("Approval rule")).toBeLessThan(prompt.indexOf("Auto rule"));
  });
});
