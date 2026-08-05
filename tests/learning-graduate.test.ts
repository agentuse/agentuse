import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  LEARNED_BLOCK_START,
  LEARNED_BLOCK_END,
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
    appliedCount: 0,
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
});
