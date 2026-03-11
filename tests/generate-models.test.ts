import { describe, it, expect } from "bun:test";

// parseModelVersion is a private function in generate-models.ts (a script).
// Re-implement it here to test the logic since it's a critical sorting function.
function parseModelVersion(id: string): number {
  const base = id.replace(/-\d{8}$/, '');
  const hyphenMatch = base.match(/^.+?-(\d+)-(\d+)$/);
  if (hyphenMatch) return parseInt(hyphenMatch[1], 10) * 1000 + parseInt(hyphenMatch[2], 10);
  const dotMatch = id.match(/(\d+)\.(\d+)/);
  if (dotMatch) return parseInt(dotMatch[1], 10) * 1000 + parseInt(dotMatch[2], 10);
  const singleMatch = id.match(/-(\d+)(?:-|$)/);
  if (singleMatch) return parseInt(singleMatch[1], 10) * 1000;
  return 0;
}

describe("parseModelVersion", () => {
  describe("hyphen format (Anthropic-style)", () => {
    it("parses claude-sonnet-4-6 as 4006", () => {
      expect(parseModelVersion("claude-sonnet-4-6")).toBe(4006);
    });

    it("parses claude-haiku-4-5 as 4005", () => {
      expect(parseModelVersion("claude-haiku-4-5")).toBe(4005);
    });

    it("parses claude-opus-4-6 as 4006", () => {
      expect(parseModelVersion("claude-opus-4-6")).toBe(4006);
    });

    it("strips date suffix before matching", () => {
      expect(parseModelVersion("claude-haiku-4-5-20251001")).toBe(4005);
    });

    it("ensures 4-6 > 4-5 (correct sorting)", () => {
      expect(parseModelVersion("claude-sonnet-4-6")).toBeGreaterThan(
        parseModelVersion("claude-haiku-4-5")
      );
    });
  });

  describe("dot format (OpenAI-style)", () => {
    it("parses gpt-5.2 as 5002", () => {
      expect(parseModelVersion("gpt-5.2")).toBe(5002);
    });

    it("parses gpt-5.4 as 5004", () => {
      expect(parseModelVersion("gpt-5.4")).toBe(5004);
    });

    it("ensures 5.4 > 5.2 (correct sorting)", () => {
      expect(parseModelVersion("gpt-5.4")).toBeGreaterThan(
        parseModelVersion("gpt-5.2")
      );
    });

    it("handles gpt-5.1 as 5001", () => {
      expect(parseModelVersion("gpt-5.1")).toBe(5001);
    });
  });

  describe("single version format", () => {
    it("parses gpt-5 as 5000", () => {
      expect(parseModelVersion("gpt-5")).toBe(5000);
    });
  });

  describe("unrecognized format", () => {
    it("returns 0 for no version", () => {
      expect(parseModelVersion("some-model-name")).toBe(0);
    });
  });

  describe("cross-provider comparison", () => {
    it("correctly orders claude-sonnet-4-5 < claude-sonnet-4-6", () => {
      expect(parseModelVersion("claude-sonnet-4-6")).toBeGreaterThan(
        parseModelVersion("claude-sonnet-4-5")
      );
    });

    it("correctly orders gpt-5.1 < gpt-5.2 < gpt-5.4", () => {
      const v51 = parseModelVersion("gpt-5.1");
      const v52 = parseModelVersion("gpt-5.2");
      const v54 = parseModelVersion("gpt-5.4");
      expect(v51).toBeLessThan(v52);
      expect(v52).toBeLessThan(v54);
    });
  });
});
