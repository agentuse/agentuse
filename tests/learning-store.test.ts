import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync } from "fs";
import { LearningStore, resolveLearningFilePath } from "../src/learning/store";
import type { Learning } from "../src/learning/types";

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

  it("round-trips provenance and ranks approval learnings first on load order", async () => {
    await store.save([
      baseLearning,
      { ...baseLearning, id: "appr001", title: "Cite sources", source: "approval" },
    ]);
    const loaded = await store.load();

    expect(loaded.find(l => l.id === "learn001")?.source).toBe("auto");
    const approval = loaded.find(l => l.id === "appr001");
    expect(approval?.source).toBe("approval");
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
});
