import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { validateModel, getSuggestions, warnIfModelNotInRegistry, loadCustomProviderNames } from "../src/utils/model-utils";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { AuthStorage } from "../src/auth/storage";

describe("validateModel", () => {
  it("returns valid for a known model", () => {
    const result = validateModel("anthropic:claude-sonnet-4-6");
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
    const result = validateModel("openai:gpt-5.4");
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
    const result = warnIfModelNotInRegistry("anthropic:claude-sonnet-4-6");
    expect(result).toBe("anthropic:claude-sonnet-4-6");
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
});
