import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  LEARNED_BLOCK_START,
  LEARNED_BLOCK_END,
  parseLearnedBlock,
  renderLearnedBlock,
  spliceLearnedBlock,
  writeLearnedBlock,
  agentFileIsWritable,
} from "../src/learning/graduate";
import type { Learning } from "../src/learning/types";

function rule(id: string, instruction: string): Learning {
  return {
    id,
    category: "tip",
    title: instruction.slice(0, 20),
    instruction,
    confidence: 1,
    injectedCount: 0,
    extractedAt: "2026-07-01T00:00:00.000Z",
    source: "manual",
    state: "graduated",
    reasserted: 0,
    approvedRuns: 0,
  };
}

// A frontmatter block with the kinds of things a string splice must preserve and
// a gray-matter round trip would destroy: comments, quoting style, key order.
const AGENT_FILE = `---
# our production model, do not downgrade
model: "anthropic:claude-sonnet-5"
learning:
  capture: true
  apply: true
---

# Blog Writer

Write short posts.
`;

describe("reading the block back out of an agent file", () => {
  // The agent file can only be the source of truth if it can be READ as one.
  // Before this, the block could only be reprinted from a copy in the store, so
  // anything a human edited between the markers was restored to the stored
  // wording on the next graduation.
  it("round-trips what it renders", () => {
    const rules = [rule("a", "Cite a source."), { ...rule("b", "Keep it short."), category: "warning" as const }];
    const parsed = parseLearnedBlock(renderLearnedBlock(rules));

    expect(parsed).toEqual([
      { category: "tip", instruction: "Cite a source." },
      { category: "warning", instruction: "Keep it short." },
    ]);
  });

  it("renders learned guidance with contextual rather than unconditional authority", () => {
    const block = renderLearnedBlock([rule("a", "For simple questions, answer directly.")]);

    expect(block).toContain("## Learned Guidance");
    expect(block).toContain("Apply each learning only when its situation is relevant");
    expect(block).toContain("agent's authored instructions take precedence");
    expect(block).not.toContain("take precedence over Skills");
  });

  it("keeps a multi-line rule whole", () => {
    // A graduated rule can carry its own numbered list, so a bullet runs until
    // the next bullet starts, not to the end of its line.
    const multi = "Two triggers to watch for:\n\n1. The first one.\n\n2. The second one.";
    const parsed = parseLearnedBlock(renderLearnedBlock([rule("a", multi), rule("b", "Something else.")]));

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.instruction).toBe(multi);
    expect(parsed[1]!.instruction).toBe("Something else.");
  });

  it("survives a human editing the text between the markers", () => {
    const edited = spliceLearnedBlock(AGENT_FILE, [rule("a", "Cite a source.")])
      .replace("Cite a source.", "Cite a primary source, never a summary.");

    expect(parseLearnedBlock(edited)).toEqual([
      { category: "tip", instruction: "Cite a primary source, never a summary." },
    ]);
  });

  it("returns nothing when the file has no block", () => {
    expect(parseLearnedBlock(AGENT_FILE)).toEqual([]);
  });
});

describe("graduating rules into the agent file", () => {
  let tempDir: string;
  let agentFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "learning-graduate-"));
    agentFile = join(tempDir, "blog.agentuse");
    writeFileSync(agentFile, AGENT_FILE);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends a marked block and leaves the frontmatter byte-identical", async () => {
    const { after, changed } = await writeLearnedBlock(agentFile, [rule("a", "Cite sources before publishing.")]);

    expect(changed).toBe(true);
    const frontmatter = after.slice(0, after.indexOf("---", 3) + 3);
    expect(frontmatter).toBe(AGENT_FILE.slice(0, AGENT_FILE.indexOf("---", 3) + 3));
    expect(after).toContain("# our production model, do not downgrade");
    expect(after).toContain(LEARNED_BLOCK_START);
    expect(after).toContain("- [tip] Cite sources before publishing.");
    expect(readFileSync(agentFile, "utf-8")).toBe(after);
  });

  it("replaces the block instead of appending a second copy", async () => {
    await writeLearnedBlock(agentFile, [rule("a", "Cite sources before publishing.")]);
    const { after } = await writeLearnedBlock(agentFile, [
      rule("a", "Cite sources before publishing."),
      rule("b", "Keep intros factual."),
    ]);

    expect(after.split(LEARNED_BLOCK_START)).toHaveLength(2);
    expect(after.split(LEARNED_BLOCK_END)).toHaveLength(2);
    expect(after).toContain("Keep intros factual.");
  });

  it("is idempotent: writing the same set twice changes nothing the second time", async () => {
    const set = [rule("a", "Cite sources before publishing.")];
    await writeLearnedBlock(agentFile, set);
    const second = await writeLearnedBlock(agentFile, set);

    expect(second.changed).toBe(false);
    expect(second.before).toBe(second.after);
  });

  it("removes the block entirely when nothing is graduated any more", () => {
    const withBlock = spliceLearnedBlock(AGENT_FILE, [rule("a", "Cite sources before publishing.")]);
    const without = spliceLearnedBlock(withBlock, []);

    expect(without).not.toContain(LEARNED_BLOCK_START);
    // Back to the original file, not the original file plus a scar of blank lines.
    expect(without).toBe(AGENT_FILE.trimEnd() + "\n");
  });

  it("reports an unwritable agent file rather than throwing mid-tidy", async () => {
    chmodSync(agentFile, 0o444);
    expect(await agentFileIsWritable(agentFile)).toBe(false);
    chmodSync(agentFile, 0o644);
    expect(await agentFileIsWritable(agentFile)).toBe(true);
  });

  it("keeps the source file mode across the atomic replacement", async () => {
    chmodSync(agentFile, 0o640);
    await writeLearnedBlock(agentFile, [rule("a", "Preserve permissions.")]);
    expect(statSync(agentFile).mode & 0o777).toBe(0o640);
  });
});
