import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  LearningStore,
  resolveLearningFilePath,
  takeLegacyLearningsNotice,
} from "../src/learning/store";
import { MAX_INJECTED_LEARNINGS, partitionLearnings } from "../src/learning/ranking";
import type { Learning } from "../src/learning/types";
import { saveManualLearning } from "../src/learning";
import { getProjectDir, getProjectDirSync } from "../src/storage/paths";
import { buildLearningPrompt, previewLearningPrompt } from "../src/runner/system-messages";

const baseLearning: Learning = {
  id: "learn001",
  category: "tip",
  title: "Sanitize inputs",
  instruction: "Always sanitize user input before executing shell commands.",
  confidence: 0.92,
  appliedCount: 0,
  extractedAt: "2024-01-02T10:00:00.000Z",
  source: "auto",
  reasserted: 0,
  approvedRuns: 0,
};

/** Where corrections used to live, before v0.17 moved them into the state
 *  directory: `{agent}.learnings.md`, right next to the agent file. */
function legacySibling(agentFilePath: string): string {
  return `${agentFilePath}.learnings.md`;
}

describe("LearningStore", () => {
  let tempDir: string;
  /** The agent file's own project root — what decides which project directory
   *  the corrections live in. Kept separate from the state directory below so a
   *  path that leaks back into the repo is visible as such. */
  let projectRoot: string;
  let agentFile: string;
  let store: LearningStore;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-store-"));
    // Corrections now land under $XDG_DATA_HOME. Point it at the temp tree so no
    // test can write into (or read from) the developer's real state directory.
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

  describe("path resolution", () => {
    it("keys the corrections file by agent id inside the project state directory", () => {
      expect(resolveLearningFilePath(agentFile, projectRoot)).toBe(
        join(getProjectDirSync(projectRoot), "learnings", "agents", "blog.learnings.md")
      );
      // The whole point of the move: nothing lands in the user's repository.
      expect(store.filePath.startsWith(projectRoot)).toBe(false);
    });

    it("preserves the agent's subdirectories, so two write.agentuse files stay apart", () => {
      const write = join(projectRoot, "agents", "blog", "write.agentuse");
      const publish = join(projectRoot, "agents", "social", "write.agentuse");

      expect(resolveLearningFilePath(write, projectRoot)).toBe(
        join(getProjectDirSync(projectRoot), "learnings", "agents", "blog", "write.learnings.md")
      );
      expect(resolveLearningFilePath(write, projectRoot)).not.toBe(
        resolveLearningFilePath(publish, projectRoot)
      );
    });

    it("gives two projects with the same agent path distinct files", () => {
      // `agents/blog/write.agentuse` exists in several of a user's repos; the
      // project hash is what stops them sharing one corrections file.
      const first = join(tempDir, "repo-a");
      const second = join(tempDir, "repo-b");
      const relative = join("agents", "blog", "write.agentuse");

      const firstPath = resolveLearningFilePath(join(first, relative), first);
      const secondPath = resolveLearningFilePath(join(second, relative), second);

      expect(firstPath).not.toBe(secondPath);
      // Same key, different project directory — not two different keys.
      expect(firstPath.endsWith(join("learnings", "agents", "blog", "write.learnings.md"))).toBe(true);
      expect(secondPath.endsWith(join("learnings", "agents", "blog", "write.learnings.md"))).toBe(true);
    });

    it("resolves one file for one agent whichever cwd the run started from", () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(projectRoot);
        const fromInside = resolveLearningFilePath(agentFile, projectRoot);
        process.chdir(tmpdir());
        const fromOutside = resolveLearningFilePath(agentFile, projectRoot);

        expect(fromOutside).toBe(fromInside);
        // And the anchoring choice is load-bearing rather than incidental: the
        // cwd-derived root that `stateRoot` deliberately isn't would have put the
        // second run's corrections in a different project directory entirely.
        expect(getProjectDirSync(process.cwd())).not.toBe(getProjectDirSync(projectRoot));
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("agrees between the sync and async project-dir helpers", async () => {
      // Sessions resolve their storage asynchronously and learnings resolve it
      // synchronously; a drifting digest would silently split one project in two.
      expect(await getProjectDir(projectRoot)).toBe(getProjectDirSync(projectRoot));
      // Also exercise the git-root branch, which the temp dirs above never hit.
      expect(await getProjectDir(process.cwd())).toBe(getProjectDirSync(process.cwd()));
    });
  });

  describe("the break with the old location", () => {
    // THE regression guard for this release. A sibling fallback is a one-line
    // change to make and impossible to notice in review, and reintroducing one
    // would resurrect exactly what the move fixed: a generated file rewritten in
    // the user's repo on every run. If this test is failing, the question is not
    // "how do I make it pass" — it is whether the project has decided to take
    // the old location back.
    const populatedLegacy = [
      "# Learnings for blog",
      "",
      "### [warning] Never publish without review",
      "<!-- id:old001 | confidence:0.88 | applied:3 | 2024-01-15 -->",
      "Always wait for explicit approval before publishing.",
      "",
    ].join("\n");

    it("never reads a populated corrections file left at the old location", async () => {
      const sibling = legacySibling(agentFile);
      writeFileSync(sibling, populatedLegacy);

      expect(await store.load()).toEqual([]);
      expect(store.filePath).not.toBe(sibling);
    });

    it("leaves the old file's bytes untouched when it writes the new one", async () => {
      const sibling = legacySibling(agentFile);
      writeFileSync(sibling, populatedLegacy);

      await store.save([baseLearning]);

      expect(readFileSync(sibling, "utf-8")).toBe(populatedLegacy);
      expect(existsSync(store.filePath)).toBe(true);
      expect((await store.load()).map((l) => l.id)).toEqual(["learn001"]);
    });

    it("warns once when corrections are stranded at the old location", () => {
      writeFileSync(legacySibling(agentFile), populatedLegacy);

      const notice = takeLegacyLearningsNotice(agentFile, projectRoot);
      expect(notice).toContain("old location");
      expect(notice).toContain(join("agents", "blog.agentuse"));
      expect(notice).toContain(join("agents", "blog.agentuse.learnings.md"));
      expect(notice).toContain("agentuse learnings migrate --all");

      // Once per agent per process: a single run loads its store several times.
      expect(takeLegacyLearningsNotice(agentFile, projectRoot)).toBeNull();
    });

    it("still warns once the keyed file exists, which is the dangerous case", async () => {
      writeFileSync(legacySibling(agentFile), populatedLegacy);
      await store.save([baseLearning]);

      // An agent that captured one learning after upgrading has a populated new
      // file and forty still stranded beside it. Going quiet here would be the
      // worst possible moment for it: every surface now shows learnings, so the
      // whole thing looks healthy while most of the history is unread.
      expect(takeLegacyLearningsNotice(agentFile, projectRoot)).toContain("old location");
    });

    it("stays silent when there was never a file at the old location", () => {
      expect(takeLegacyLearningsNotice(agentFile, projectRoot)).toBeNull();
    });
  });

  it("keeps a stored date stable across repeated save/load cycles", async () => {
    // Every save re-serializes every entry. Re-parsing an already-local
    // 'YYYY-MM-DD' as UTC midnight walked the day backwards on each write, so in
    // a negative UTC offset the whole file aged one day per run.
    await store.save([{ ...baseLearning, extractedAt: "2026-07-30T18:00:00.000Z" }]);
    const first = (await store.load())[0]!.extractedAt;

    for (let i = 0; i < 4; i++) {
      await store.save(await store.load());
    }

    expect((await store.load())[0]!.extractedAt).toBe(first);
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

  it("records the source agent as a breadcrumb that never parses back as a learning", async () => {
    // A file under `project/9f2c…/learnings/` is otherwise unattributable by eye.
    await store.save([baseLearning]);
    const raw = readFileSync(store.filePath, "utf-8");
    expect(raw.startsWith(`# Learnings for blog\n<!-- agent: ${join("agents", "blog.agentuse")} -->\n`)).toBe(true);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("learn001");
    // Round-trips: the breadcrumb survives load+render unchanged, and adds no
    // entry of its own on the way back in.
    expect(store.render(loaded)).toBe(raw);
  });

  it("produces no phantom learning from a file holding only the breadcrumb", async () => {
    await store.save([]);
    expect(readFileSync(store.filePath, "utf-8")).toContain("<!-- agent: ");
    expect(await store.load()).toEqual([]);
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
    await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
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
      stateRoot: projectRoot,
      instruction: "Always include source links when publishing.",
      sessionId: "sess-two",
    });
    loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sessionId).toBe("sess-two");
  });

  it("clears stale session provenance when a similar rule is upgraded at agent level", async () => {
    await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
      instruction: "Always include source links before publishing.",
      sessionId: "sess-one",
    });
    await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
      instruction: "Always include source links when publishing.",
    });

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sessionId).toBeUndefined();
  });

  it("reads corrections written before the src field existed", async () => {
    // Pre-provenance FORMAT (no `src:` token) at the current LOCATION — an old
    // file that was migrated, not an old file left where it was.
    const legacy = `# Learnings for agent

### [warning] Never publish without review
<!-- id:old001 | confidence:0.88 | applied:3 | 2024-01-15 -->
Always wait for explicit approval before publishing.
`;
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(store.filePath, legacy);
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
    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
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
    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
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
      stateRoot: projectRoot,
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
    const outcome = await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
      instruction: "Never delete files without an explicit confirmation step.",
    });

    expect(outcome.status).toBe("captured");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe("manual");
  });

  it("generates distinct 8-char hex ids for dissimilar manual rules", async () => {
    await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
      instruction: "Always cite primary sources in the final report.",
    });
    await saveManualLearning({
      agentFilePath: agentFile,
      stateRoot: projectRoot,
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
    await store.save([
      { ...baseLearning, id: "auto001", instruction: "Auto rule", source: "auto", confidence: 0.99 },
      { ...baseLearning, id: "appr001", instruction: "Approval rule", source: "approval", confidence: 0.95 },
      { ...baseLearning, id: "man001", instruction: "Manual rule", source: "manual", confidence: 1 },
    ]);

    const result = await buildLearningPrompt({
      name: "agent",
      instructions: "Do work.",
      config: { model: "demo:test", skills: { auto: false, trusted: false, explicit: {} }, learning: { capture: true, apply: true } },
    } as never, agentFile, projectRoot);

    const prompt = result?.prompt ?? "";
    expect(prompt.indexOf("Manual rule")).toBeLessThan(prompt.indexOf("Approval rule"));
    expect(prompt.indexOf("Approval rule")).toBeLessThan(prompt.indexOf("Auto rule"));
  });

  it("reports the stored total alongside what it injected", async () => {
    // A store written before capture enforced the cap can hold more than the cap
    // allows; the excess must be reported, not silently truncated.
    const total = MAX_INJECTED_LEARNINGS + 4;
    await store.save(Array.from({ length: total }, (_, i) => ({
      ...baseLearning,
      id: `appr${String(i).padStart(3, "0")}`,
      instruction: `Correction number ${i} about a distinct subject ${i}`,
      source: "approval" as const,
      confidence: 0.95,
      extractedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    })));

    const result = await buildLearningPrompt({
      name: "agent",
      instructions: "Do work.",
      config: { model: "demo:test", skills: { auto: false, trusted: false, explicit: {} }, learning: { capture: true, apply: true } },
    } as never, agentFile, projectRoot);

    // count must not be mistaken for the file size: 4 of these never reach the
    // model, and callers need to be able to say so.
    expect(result?.count).toBe(MAX_INJECTED_LEARNINGS);
    expect(result?.total).toBe(total);
  });

  it("previewLearningPrompt renders the same block without recording usage", async () => {
    await store.save([{ ...baseLearning, id: "prev0001", appliedCount: 3 }]);
    const agent = {
      name: "agent",
      instructions: "Do work.",
      config: { model: "demo:test", skills: { auto: false, trusted: false, explicit: {} }, learning: { capture: true, apply: true } },
    };

    const preview = await previewLearningPrompt(agent as never, agentFile, projectRoot);
    // A diagnostic must not mutate what it measures.
    expect((await store.load())[0]!.appliedCount).toBe(3);

    const applied = await buildLearningPrompt(agent as never, agentFile, projectRoot);
    expect(preview?.prompt).toBe(applied?.prompt ?? "");
  });

  describe("addOrEscalate", () => {
    const stored: Learning = {
      ...baseLearning,
      id: "dormant1",
      title: "Cut teaching-mode lines",
      instruction: "Rewrite instruction-shaped phrasing as the author's own lived observation.",
      source: "approval",
      confidence: 0.95,
      appliedCount: 4,
      extractedAt: "2026-06-02T00:00:00.000Z",
    };

    it("re-asserts a repeat correction in place instead of dropping it", async () => {
      await store.save([stored]);

      const { inserted, escalated } = await store.addOrEscalate([{
        ...stored,
        id: "fresh001",
        title: "Don't lecture the author",
        // Similar wording: the old add() would have silently discarded this.
        instruction: "Rewrite instruction-shaped phrasing as the author's own lived observation, never a rule.",
        appliedCount: 0,
        extractedAt: "2026-07-28T00:00:00.000Z",
        sessionId: "sess-repeat",
      }]);

      expect(inserted).toHaveLength(0);
      expect(escalated).toHaveLength(1);

      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
      // Identity and usage history survive; wording, date and session refresh, so
      // the rule ranks as recent and is injected on the next run.
      expect(loaded[0]!.id).toBe("dormant1");
      expect(loaded[0]!.appliedCount).toBe(4);
      expect(loaded[0]!.title).toBe("Don't lecture the author");
      expect(loaded[0]!.instruction).toContain("never a rule");
      expect(loaded[0]!.extractedAt).toBe("2026-07-28");
      expect(loaded[0]!.sessionId).toBe("sess-repeat");
    });

    it("moves a re-asserted rule to the tail so a same-day tie cannot keep it dormant", async () => {
      // Ranking breaks a same-day tie by file position. Rewriting the entry where
      // it sat would leave the refreshed rule sorting last among that day's
      // entries, still dormant, which defeats the point of re-asserting it.
      const sameDay = "2026-07-28T00:00:00.000Z";
      await store.save([
        { ...stored, extractedAt: sameDay },
        ...Array.from({ length: 10 }, (_, i) => ({
          ...stored,
          id: `peer${i}`,
          title: `Peer ${i}`,
          instruction: `Unrelated guidance covering separate territory numbered ${i} exactly.`,
          extractedAt: sameDay,
        })),
      ]);

      await store.addOrEscalate([{
        ...stored,
        id: "fresh002",
        title: "Don't lecture the author",
        instruction: "Rewrite instruction shaped phrasing as the author's own lived observation, never a rule.",
        extractedAt: sameDay,
      }]);

      const loaded = await store.load();
      expect(loaded[loaded.length - 1]!.id).toBe("dormant1");
      const { injected } = partitionLearnings(loaded);
      expect(injected.map((l) => l.id)).toContain("dormant1");
    });

    it("inserts a genuinely new learning with a fresh id", async () => {
      await store.save([stored]);

      const { inserted, escalated } = await store.addOrEscalate([{
        ...baseLearning,
        id: "",
        title: "Verify before posting",
        instruction: "Confirm the published result from the page, never from the click succeeding.",
      }]);

      expect(escalated).toHaveLength(0);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.id).toMatch(/^[0-9a-f]{8}$/);
      expect(await store.load()).toHaveLength(2);
    });

    it("never lets a weaker source rewrite a stronger rule", async () => {
      await store.save([{ ...stored, source: "manual", confidence: 1, instruction: "Human wording of the rule about lecturing the author." }]);

      const { inserted, escalated } = await store.addOrEscalate([{
        ...stored,
        id: "auto0001",
        source: "auto",
        confidence: 0.9,
        instruction: "Machine wording of the rule about lecturing the author.",
      }]);

      expect(inserted).toHaveLength(0);
      expect(escalated).toHaveLength(0);
      const loaded = await store.load();
      expect(loaded[0]!.source).toBe("manual");
      expect(loaded[0]!.instruction).toContain("Human wording");
    });

    it("upgrades an auto learning when a reviewer asserts the same thing", async () => {
      await store.save([{ ...stored, source: "auto", confidence: 0.85 }]);

      const { escalated } = await store.addOrEscalate([{
        ...stored,
        id: "appr0001",
        source: "approval",
        confidence: 0.95,
      }]);

      expect(escalated).toHaveLength(1);
      const loaded = await store.load();
      expect(loaded[0]!.source).toBe("approval");
      expect(loaded[0]!.confidence).toBe(0.95);
    });

    it("writes nothing when every candidate is redundant", async () => {
      await store.save([{ ...stored, source: "manual", confidence: 1 }]);
      const before = await store.load();

      const result = await store.addOrEscalate([{ ...stored, id: "auto0002", source: "auto", confidence: 0.9 }]);

      expect(result).toEqual({
        inserted: [], escalated: [], alreadyGraduated: [], retired: [], refused: [], overCap: 0,
      });
      expect(await store.load()).toEqual(before);
    });

    it("counts a repeat so the tidy-up can rewrite the rule instead of stacking a copy", async () => {
      await store.save([stored]);

      await store.addOrEscalate([{ ...stored, id: "again001", extractedAt: "2026-07-28T00:00:00.000Z" }]);
      await store.addOrEscalate([{ ...stored, id: "again002", extractedAt: "2026-07-29T00:00:00.000Z" }]);

      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.reasserted).toBe(2);
    });

    it("revives a retired rule when a human re-asserts it", async () => {
      // The archive's only correction signal: a human saying it again.
      await store.save([{ ...stored, state: "retired" }]);

      const { escalated } = await store.addOrEscalate([{ ...stored, id: "again001", extractedAt: "2026-07-28T00:00:00.000Z" }]);

      expect(escalated).toHaveLength(1);
      expect((await store.load())[0]!.state).toBeUndefined();
    });

    it("leaves a graduated rule alone rather than stating it twice", async () => {
      await store.save([{ ...stored, state: "graduated" }]);

      const result = await store.addOrEscalate([{ ...stored, id: "again001", extractedAt: "2026-07-28T00:00:00.000Z" }]);

      expect(result.alreadyGraduated).toHaveLength(1);
      expect(result.inserted).toHaveLength(0);
      expect(result.escalated).toHaveLength(0);
      expect((await store.load())[0]!.state).toBe("graduated");
    });
  });

  describe("addOrEscalate under a cap", () => {
    // Instructions that share no word over four characters, so `similar()` can
    // never match two of them and every draft below is genuinely new. Without
    // this the escalate path would absorb the drafts and the cap would never be
    // exercised at all.
    const WORDS = [
      "alphabetical", "borogoves", "cantilever", "dendrites", "effervesce",
      "fandangos", "gravitons", "hesperides", "ionosphere", "jacaranda",
    ];
    const distinct = (i: number) => `Skip ${WORDS[i]} when done`;

    /** `n` rules of one source, oldest first, so the last one added ranks
     *  highest and the first is the one eviction should reach for. */
    const fill = (n: number, source: Learning["source"]): Learning[] =>
      Array.from({ length: n }, (_, i) => ({
        ...baseLearning,
        id: `fill000${i}`,
        title: `Rule ${i}`,
        instruction: distinct(i),
        source,
        confidence: 0.9,
        extractedAt: `2026-06-0${i + 1}T00:00:00.000Z`,
      }));

    const draft = (over: Partial<Learning> = {}): Learning => ({
      ...baseLearning,
      id: "newdraft",
      title: "Fresh rule",
      instruction: distinct(9),
      source: "auto",
      confidence: 0.9,
      extractedAt: "2026-07-01T00:00:00.000Z",
      ...over,
    });

    const activeOf = (all: Learning[]) => all.filter((l) => (l.state ?? "active") === "active");

    it("retires the rule a draft supersedes and inserts it in the freed slot", async () => {
      await store.save(fill(3, "auto"));

      const result = await store.addOrEscalate(
        [{ ...draft(), supersedes: "fill0001" }],
        { cap: 3 },
      );

      expect(result.inserted).toHaveLength(1);
      expect(result.retired.map((l) => l.id)).toEqual(["fill0001"]);
      const loaded = await store.load();
      expect(activeOf(loaded)).toHaveLength(3);
      // Superseded, not deleted: still there to be revived if a human re-asserts it.
      expect(loaded.find((l) => l.id === "fill0001")!.state).toBe("retired");
    });

    it("never lets an auto draft supersede a human correction", async () => {
      await store.save(fill(3, "manual"));

      // The named rule outranks the draft, so the instruction is ignored — and
      // with nothing evictable left, the draft is refused rather than quietly
      // costing a human correction its place.
      const result = await store.addOrEscalate(
        [{ ...draft(), supersedes: "fill0001" }],
        { cap: 3 },
      );

      expect(result.retired).toHaveLength(0);
      expect(result.inserted).toHaveLength(0);
      expect(result.refused).toHaveLength(1);
      expect(activeOf(await store.load())).toHaveLength(3);
    });

    it("trades away the weakest auto rule when a full set gets a stronger draft", async () => {
      await store.save(fill(3, "auto"));

      const result = await store.addOrEscalate([draft()], { cap: 3 });

      expect(result.inserted).toHaveLength(1);
      // The oldest auto rule, which was the last one injection would have reached.
      expect(result.retired.map((l) => l.id)).toEqual(["fill0000"]);
      expect(activeOf(await store.load())).toHaveLength(3);
    });

    it("refuses an auto draft that is worth less than what it would displace", async () => {
      await store.save(fill(3, "auto"));

      const result = await store.addOrEscalate(
        [draft({ confidence: 0.8, extractedAt: "2026-01-01T00:00:00.000Z" })],
        { cap: 3 },
      );

      // Keeps the best three, not the last three.
      expect(result.inserted).toHaveLength(0);
      expect(result.refused).toHaveLength(1);
      expect(result.retired).toHaveLength(0);
    });

    it("refuses an auto draft rather than drop a human correction to fit it", async () => {
      await store.save(fill(3, "manual"));

      const result = await store.addOrEscalate([draft()], { cap: 3 });

      expect(result.refused).toHaveLength(1);
      expect(result.inserted).toHaveLength(0);
      expect(result.retired).toHaveLength(0);
      expect(activeOf(await store.load())).toHaveLength(3);
    });

    it("takes a reviewer correction over cap when nothing may be dropped, and says so", async () => {
      await store.save(fill(3, "manual"));

      const result = await store.addOrEscalate(
        [draft({ source: "approval", confidence: 0.95 })],
        { cap: 3 },
      );

      // The one case worth interrupting a human for: the ruleset is all human
      // corrections and still too big. Never resolved by discarding one.
      expect(result.inserted).toHaveLength(1);
      expect(result.retired).toHaveLength(0);
      expect(result.overCap).toBe(1);
      expect(activeOf(await store.load())).toHaveLength(4);
    });

    it("never evicts a rule a human has already repeated", async () => {
      const rules = fill(3, "auto");
      // The oldest, so it is exactly what eviction would otherwise reach for.
      rules[0]!.reasserted = 1;
      await store.save(rules);

      const result = await store.addOrEscalate([draft()], { cap: 3 });

      // A repeat is evidence the wording needs rewriting, the opposite of
      // evidence it should be dropped.
      expect(result.retired.map((l) => l.id)).toEqual(["fill0001"]);
      expect((await store.load()).find((l) => l.id === "fill0000")!.state ?? "active").toBe("active");
    });

    it("drains a store that was already over cap, taking only auto rules", async () => {
      await store.save([...fill(6, "auto"), {
        ...baseLearning,
        id: "human001",
        title: "Human rule",
        instruction: distinct(8),
        source: "manual",
        confidence: 1,
        extractedAt: "2026-06-09T00:00:00.000Z",
      }]);

      const result = await store.addOrEscalate([draft()], { cap: 3 });

      const loaded = await store.load();
      expect(activeOf(loaded)).toHaveLength(3);
      expect(result.overCap).toBe(0);
      // Behaviour-neutral: it retires from the bottom of the same ranking that
      // injection reads from the top of, and never touches the human rule.
      expect(loaded.find((l) => l.id === "human001")!.state ?? "active").toBe("active");
      expect(result.retired.every((l) => l.source === "auto")).toBe(true);
    });

    it("promotes a starved re-asserted rule into force as the pile around it drains", async () => {
      // Taken from a real store: a rule a human had repeated three times sat at
      // rank 27 of 70 active and had never once been injected. It cannot be
      // evicted, so draining the auto pile around it is what finally puts it in
      // force — the outcome the cap exists for, not a side effect of it.
      const rules = fill(6, "auto");
      rules[0]!.reasserted = 3;          // oldest, so ranked last of the six
      rules[0]!.confidence = 0.85;       // and weakest, so ranked last on every key
      await store.save(rules);

      await store.addOrEscalate([], { cap: 3 });

      const survivors = activeOf(await store.load());
      expect(survivors).toHaveLength(3);
      expect(survivors.map((l) => l.id)).toContain("fill0000");
    });

    it("stops draining when only human corrections are left, and reports the overage", async () => {
      await store.save(fill(5, "manual"));

      const result = await store.addOrEscalate(
        [draft({ source: "approval", confidence: 0.95 })],
        { cap: 3 },
      );

      expect(result.retired).toHaveLength(0);
      expect(activeOf(await store.load())).toHaveLength(6);
      expect(result.overCap).toBe(3);
    });

    it("leaves the set alone when no cap is given", async () => {
      await store.save(fill(3, "auto"));

      const result = await store.addOrEscalate([draft()]);

      expect(result.inserted).toHaveLength(1);
      expect(result.retired).toHaveLength(0);
      expect(result.overCap).toBe(0);
      expect(activeOf(await store.load())).toHaveLength(4);
    });

    it("never writes `supersedes` into the corrections file", async () => {
      await store.save(fill(3, "auto"));

      await store.addOrEscalate([{ ...draft(), supersedes: "fill0001" }], { cap: 3 });

      // It is an instruction to the store, not a property of the rule. Persisting
      // it would leave a dangling id in the file the moment the target is tidied.
      expect(readFileSync(store.filePath, "utf-8")).not.toContain("supersedes");
    });
  });

  describe("lifecycle state", () => {
    it("round-trips state and the evidence counters, defaulting them on older files", async () => {
      await store.save([
        { ...baseLearning, id: "perm0001", state: "graduated", approvedRuns: 7 },
        { ...baseLearning, id: "arch0001", title: "Archived", instruction: "Something entirely different about archives here.", state: "retired", reasserted: 2 },
      ]);

      const loaded = await store.load();
      const permanent = loaded.find((l) => l.id === "perm0001")!;
      const archived = loaded.find((l) => l.id === "arch0001")!;

      expect(permanent.state).toBe("graduated");
      expect(permanent.approvedRuns).toBe(7);
      expect(archived.state).toBe("retired");
      expect(archived.reasserted).toBe(2);
      // An entry with nothing to say writes no extra metadata, so a file that
      // predates these fields round-trips unchanged.
      expect(store.render([baseLearning])).not.toContain("state:");
    });

    it("sinks retired entries into an archive section instead of deleting them", async () => {
      await store.save([
        baseLearning,
        { ...baseLearning, id: "arch0001", title: "Archived", instruction: "Something entirely different about archives here.", state: "retired" },
      ]);

      const raw = store.render(await store.load());
      expect(raw).toContain("## Retired");
      expect(raw.indexOf("## Retired")).toBeLessThan(raw.indexOf("Archived"));
      expect(await store.load()).toHaveLength(2);
    });

    it("credits only the injected rules for an approved run", async () => {
      await store.save([baseLearning, { ...baseLearning, id: "other001", title: "Other", instruction: "Completely unrelated guidance about something else." }]);

      await store.recordApprovedRun(["learn001"]);

      const loaded = await store.load();
      expect(loaded.find((l) => l.id === "learn001")!.approvedRuns).toBe(1);
      expect(loaded.find((l) => l.id === "other001")!.approvedRuns).toBe(0);
    });

    it("moves rules between states and reports what changed", async () => {
      await store.save([baseLearning]);

      expect(await store.setState(["learn001"], "graduated")).toEqual(["learn001"]);
      // Already there: nothing to change, nothing to report.
      expect(await store.setState(["learn001"], "graduated")).toEqual([]);
      expect((await store.load())[0]!.state).toBe("graduated");
    });
  });
});
