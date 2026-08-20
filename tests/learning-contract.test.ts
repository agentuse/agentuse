/**
 * Contract provenance: the hash a learning is captured and vetted against, and
 * the staleness test injection uses to hold back rules the contract has moved
 * out from under.
 */
import { describe, it, expect } from "bun:test";
import { hashInstructions, isStaleAgainst, splitInstructions } from "../src/learning/contract";
import { LEARNED_BLOCK_END, LEARNED_BLOCK_START } from "../src/learning/graduate";

const BODY = "Write the weekly digest.\n\nCite the primary source, never a summary.";

const withBlock = (body: string, permanent: string) =>
  `${body}\n\n${LEARNED_BLOCK_START}\n## Learned Guidelines\n\n- [warning] ${permanent}\n${LEARNED_BLOCK_END}\n`;

describe("splitInstructions", () => {
  it("separates the author's instructions from the machine-managed block", () => {
    const { body, permanentText } = splitInstructions(withBlock(BODY, "Keep intros factual."));

    expect(body).toContain("Write the weekly digest.");
    expect(body).not.toContain("Keep intros factual.");
    expect(permanentText).toContain("Keep intros factual.");
  });

  it("leaves instructions with no block untouched", () => {
    const { body, permanentText } = splitInstructions(BODY);
    expect(body).toBe(BODY);
    expect(permanentText).toBe("");
  });
});

describe("hashInstructions", () => {
  it("ignores the graduated block, so a rule graduating does not stale every other rule", () => {
    // The block is output of the learning system itself. Hashing it would mark
    // every stored learning stale each time one of them graduated — a
    // self-invalidation loop with no new information in it.
    expect(hashInstructions(withBlock(BODY, "Keep intros factual."))).toBe(hashInstructions(BODY));
    // And it stays stable as the block's own contents change.
    expect(hashInstructions(withBlock(BODY, "Something else entirely."))).toBe(hashInstructions(BODY));
  });

  it("changes when a human rewrites the contract, which is what it exists to catch", () => {
    expect(hashInstructions(`${BODY}\nNever publish on a Friday.`)).not.toBe(hashInstructions(BODY));
  });

  it("is a short, stable hex token so the metadata line stays readable", () => {
    expect(hashInstructions(BODY)).toMatch(/^[0-9a-f]{12}$/);
    expect(hashInstructions(BODY)).toBe(hashInstructions(BODY));
  });

  it("ignores surrounding whitespace", () => {
    expect(hashInstructions(`\n\n${BODY}\n  `)).toBe(hashInstructions(BODY));
  });
});

describe("isStaleAgainst", () => {
  const current = hashInstructions(BODY);

  it("flags an entry vetted against a different contract", () => {
    expect(isStaleAgainst(current, hashInstructions("Some other agent entirely."))).toBe(true);
  });

  it("passes an entry vetted against this contract", () => {
    expect(isStaleAgainst(current, current)).toBe(false);
  });

  it("does not flag a legacy entry that has no recorded hash", () => {
    // Entries that predate provenance stay injectable until a capture or tidy
    // pass backfills them; treating "unknown" as "stale" would silently disarm
    // every pre-0.18 store on upgrade.
    expect(isStaleAgainst(current, undefined)).toBe(false);
  });
});
