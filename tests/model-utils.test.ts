import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  validateModel,
  getSuggestions,
  warnIfModelNotInRegistry,
  loadCustomProviderNames,
  resolveModelProvider,
  toRegistryKey,
} from "../src/utils/model-utils";
import { getProviderModels, MODELS } from "../src/generated/models";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { AuthStorage } from "../src/auth/storage";

describe("validateModel", () => {
  it("normalizes bare model IDs as OpenAI across provider and registry resolution", () => {
    expect(resolveModelProvider("gpt-5")).toBe("openai");
    expect(toRegistryKey("gpt-5")).toBe("openai:gpt-5");
    expect(validateModel("gpt-5").valid).toBe(true);
  });

  it("returns valid for a known model", () => {
    const result = validateModel("anthropic:claude-sonnet-5");
    expect(result.valid).toBe(true);
    expect(result.model).toBeDefined();
  });

  it("returns invalid for unknown model with warning", () => {
    const result = validateModel("anthropic:claude-99-turbo");
    expect(result.valid).toBe(false);
    expect(result.warning).toContain("not found in registry");
    expect(result.warning).toContain("claude-99-turbo");
  });

  it("provides suggestions for misspelled model names", () => {
    const result = validateModel("anthropic:claude-sonet"); // misspelled
    expect(result.valid).toBe(false);
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions!.length).toBeGreaterThan(0);
  });

  it("returns valid for openai models in registry", () => {
    // Derive a real id from the registry so this test tracks model.dev churn
    // (the registry auto-regenerates and hardcoded versions age out).
    const openaiModels = getProviderModels("openai");
    expect(openaiModels.length).toBeGreaterThan(0);
    const result = validateModel(`openai:${openaiModels[0].id}`);
    expect(result.valid).toBe(true);
  });

  it("returns invalid for completely made-up model", () => {
    const result = validateModel("fakeprovider:nonexistent-model-xyz");
    expect(result.valid).toBe(false);
  });

  it("returns valid for demo provider models", () => {
    const result = validateModel("demo:hello");
    expect(result.valid).toBe(true);
  });
});

describe("registry excludes non-chat endpoints", () => {
  it("contains no embedding/moderation/rerank/transcription ids", () => {
    const nonChat = /(?:embed|moderation|rerank|whisper|transcrib|\btts\b|guardrail)/i;
    for (const models of Object.values(MODELS)) {
      for (const id of Object.keys(models)) {
        expect(nonChat.test(id)).toBe(false);
      }
    }
  });

  it("contains no image/audio/video-only generators (all can emit text)", () => {
    for (const models of Object.values(MODELS)) {
      for (const model of Object.values(models)) {
        expect(model.modalities.output.includes("text")).toBe(true);
      }
    }
  });

  it("rejects a non-chat model id as invalid", () => {
    // Locks in the filter: even though models.dev lists it, an embedding
    // endpoint must not validate as a selectable agent model.
    expect(validateModel("openai:text-embedding-3-large").valid).toBe(false);
  });
});

describe("getSuggestions", () => {
  it("returns suggestions for partial model names", () => {
    const suggestions = getSuggestions("claude-sonnet");
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("respects limit parameter", () => {
    const suggestions = getSuggestions("claude", 2);
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  it("returns suggestions for openai models", () => {
    const suggestions = getSuggestions("gpt");
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("returns results even for weak matches", () => {
    const suggestions = getSuggestions("zzzzz");
    // threshold is very low so should still return some results
    expect(suggestions).toBeDefined();
  });
});

describe("warnIfModelNotInRegistry (custom provider skip)", () => {
  let tempDir: string;
  let originalAuthFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentuse-model-utils-test-"));
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, "auth.json");
  });

  afterEach(async () => {
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("skips validation for custom provider models", async () => {
    // Register a custom provider
    await AuthStorage.setCustomProvider("ollama", {
      baseURL: "http://localhost:11434/v1",
    });

    // Load the custom provider names into cache
    await loadCustomProviderNames();

    // This should NOT warn (returns the model string unchanged, no warning)
    const result = warnIfModelNotInRegistry("ollama:llama3");
    expect(result).toBe("ollama:llama3");
  });

  it("still warns for unknown non-custom providers", async () => {
    // Ensure cache is loaded (empty)
    await loadCustomProviderNames();

    const result = warnIfModelNotInRegistry("fakeprovider:fake-model");
    expect(result).toBe("fakeprovider:fake-model");
    // The function still returns the model string, but it logs warnings
  });

  it("returns model string for valid registry models", async () => {
    await loadCustomProviderNames();
    const result = warnIfModelNotInRegistry("anthropic:claude-sonnet-5");
    expect(result).toBe("anthropic:claude-sonnet-5");
  });

  it("skips validation for bedrock models (not in registry)", async () => {
    await loadCustomProviderNames();
    // Bedrock model IDs are AWS-specific and intentionally not in the registry,
    // so warnIfModelNotInRegistry should return the string unchanged.
    const result = warnIfModelNotInRegistry(
      "bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0"
    );
    expect(result).toBe("bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0");
  });

  it("skips validation for opencode-go models (live model endpoint)", async () => {
    await loadCustomProviderNames();
    const result = warnIfModelNotInRegistry("opencode-go:kimi-k2.7-code");
    expect(result).toBe("opencode-go:kimi-k2.7-code");
  });
});
