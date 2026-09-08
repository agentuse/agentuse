import { describe, it, expect } from "bun:test";

import { parseModelVersion, buildRegistry } from '../scripts/generate-models';

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
      expect(parseModelVersion("qwen/qwen3.8-max-0902")).toBe(3008);
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


describe('staggered OpenAI major rollout', () => {
  it('keeps existing GPT-5 workload tiers alongside Astra', () => {
    const ids = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o'];
    const registry = buildRegistry({ openai: { models: Object.fromEntries(ids.map(id => [id, { id, name: id }])) } });
    expect(Object.keys(registry.openai).sort()).toEqual(ids.slice(0, 4).sort());
    expect(parseModelVersion('gpt-6-astra')).toBe(6000);
  });
});

describe('dated curated model aliases', () => {
  it('keeps the newest Qwen Max release when OpenRouter uses an MMDD suffix', () => {
    const ids = ['qwen/qwen3.7-max', 'qwen/qwen3.8-max-0902'];
    const registry = buildRegistry({
      openrouter: {
        models: {
          [ids[0]]: { id: ids[0], name: ids[0], release_date: '2026-07-15' },
          [ids[1]]: { id: ids[1], name: ids[1], release_date: '2026-09-02' },
        },
      },
    });
    expect(Object.keys(registry.openrouter)).toEqual(['qwen/qwen3.8-max-0902']);
  });
});
