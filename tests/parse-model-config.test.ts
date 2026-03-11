import { describe, it, expect } from "bun:test";
import { parseModelConfig } from "../src/models";

describe("parseModelConfig", () => {
  describe("no-colon input (defaults to openai)", () => {
    it("treats bare model name as openai provider", () => {
      const result = parseModelConfig("gpt-5.2");
      expect(result.provider).toBe("openai");
      expect(result.modelName).toBe("gpt-5.2");
    });
  });

  describe("builtin providers", () => {
    it("parses provider:model format", () => {
      const result = parseModelConfig("anthropic:claude-sonnet-4-6");
      expect(result.provider).toBe("anthropic");
      expect(result.modelName).toBe("claude-sonnet-4-6");
    });

    it("parses openai:model format", () => {
      const result = parseModelConfig("openai:gpt-5.2");
      expect(result.provider).toBe("openai");
      expect(result.modelName).toBe("gpt-5.2");
    });

    it("parses openrouter:model format", () => {
      const result = parseModelConfig("openrouter:some-model");
      expect(result.provider).toBe("openrouter");
      expect(result.modelName).toBe("some-model");
    });

    it("parses demo:model format", () => {
      const result = parseModelConfig("demo:hello");
      expect(result.provider).toBe("demo");
      expect(result.modelName).toBe("hello");
    });

    it("parses env suffix (provider:model:suffix)", () => {
      const result = parseModelConfig("openai:gpt-5.2:dev");
      expect(result.provider).toBe("openai");
      expect(result.modelName).toBe("gpt-5.2");
      expect(result.envSuffix).toBe("DEV");
      expect(result.envVar).toBeUndefined();
    });

    it("parses full env var (provider:model:FULL_KEY_VAR)", () => {
      const result = parseModelConfig("openai:gpt-5.2:OPENAI_API_KEY_PERSONAL");
      expect(result.provider).toBe("openai");
      expect(result.modelName).toBe("gpt-5.2");
      expect(result.envVar).toBe("OPENAI_API_KEY_PERSONAL");
      expect(result.envSuffix).toBeUndefined();
    });

    it("uppercases env suffix", () => {
      const result = parseModelConfig("anthropic:claude-sonnet-4-6:staging");
      expect(result.envSuffix).toBe("STAGING");
    });

    it("detects full env var by _KEY presence", () => {
      const result = parseModelConfig("anthropic:claude-sonnet-4-6:ANTHROPIC_API_KEY_CUSTOM");
      expect(result.envVar).toBe("ANTHROPIC_API_KEY_CUSTOM");
    });
  });

  describe("custom providers", () => {
    it("treats everything after first colon as model name", () => {
      const result = parseModelConfig("ollama:llama3");
      expect(result.provider).toBe("ollama");
      expect(result.modelName).toBe("llama3");
    });

    it("preserves colons in custom provider model names", () => {
      // e.g. ollama:qwen3.5:0.8b should keep the full model name
      const result = parseModelConfig("ollama:qwen3.5:0.8b");
      expect(result.provider).toBe("ollama");
      expect(result.modelName).toBe("qwen3.5:0.8b");
    });

    it("does not extract env suffix for custom providers", () => {
      const result = parseModelConfig("mylocal:model:variant");
      expect(result.provider).toBe("mylocal");
      expect(result.modelName).toBe("model:variant");
      expect(result.envSuffix).toBeUndefined();
      expect(result.envVar).toBeUndefined();
    });

    it("handles custom provider with complex model names", () => {
      const result = parseModelConfig("lmstudio:TheBloke/Mistral-7B-Instruct:q4_0");
      expect(result.provider).toBe("lmstudio");
      expect(result.modelName).toBe("TheBloke/Mistral-7B-Instruct:q4_0");
    });
  });
});
