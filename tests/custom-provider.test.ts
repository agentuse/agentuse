import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { AuthStorage } from "../src/auth/storage";
import { CustomProviderAuth } from "../src/auth/types";

describe("CustomProviderAuth schema", () => {
  it("validates a custom provider with baseURL and key", () => {
    const result = CustomProviderAuth.safeParse({
      type: "custom",
      baseURL: "http://localhost:11434/v1",
      key: "sk-test",
    });
    expect(result.success).toBe(true);
  });

  it("validates a custom provider without key (optional)", () => {
    const result = CustomProviderAuth.safeParse({
      type: "custom",
      baseURL: "http://localhost:11434/v1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing baseURL", () => {
    const result = CustomProviderAuth.safeParse({
      type: "custom",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type", () => {
    const result = CustomProviderAuth.safeParse({
      type: "api",
      baseURL: "http://localhost:11434/v1",
    });
    expect(result.success).toBe(false);
  });
});

describe("AuthStorage custom provider methods", () => {
  let tempDir: string;
  let originalAuthFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentuse-auth-test-"));
    const authFile = path.join(tempDir, "auth.json");
    // Override the private AUTH_FILE to use our temp file
    originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = authFile;
  });

  afterEach(async () => {
    (AuthStorage as any).AUTH_FILE = originalAuthFile;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("setCustomProvider", () => {
    it("stores a custom provider with baseURL and key", async () => {
      await AuthStorage.setCustomProvider("ollama", {
        baseURL: "http://localhost:11434/v1",
        key: "sk-test",
      });

      const provider = await AuthStorage.getCustomProvider("ollama");
      expect(provider).toBeDefined();
      expect(provider!.type).toBe("custom");
      expect(provider!.baseURL).toBe("http://localhost:11434/v1");
      expect(provider!.key).toBe("sk-test");
    });

    it("stores a custom provider without key", async () => {
      await AuthStorage.setCustomProvider("local", {
        baseURL: "http://localhost:8080/v1",
      });

      const provider = await AuthStorage.getCustomProvider("local");
      expect(provider).toBeDefined();
      expect(provider!.baseURL).toBe("http://localhost:8080/v1");
      expect(provider!.key).toBeUndefined();
    });

    it("overwrites existing custom provider", async () => {
      await AuthStorage.setCustomProvider("test", {
        baseURL: "http://old.url/v1",
      });
      await AuthStorage.setCustomProvider("test", {
        baseURL: "http://new.url/v1",
        key: "new-key",
      });

      const provider = await AuthStorage.getCustomProvider("test");
      expect(provider!.baseURL).toBe("http://new.url/v1");
      expect(provider!.key).toBe("new-key");
    });

    it("sets file permissions to 0o600", async () => {
      await AuthStorage.setCustomProvider("secure", {
        baseURL: "http://localhost/v1",
      });

      const authFile = (AuthStorage as any).AUTH_FILE;
      const stats = await fs.stat(authFile);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe("getCustomProvider", () => {
    it("returns undefined for non-existent provider", async () => {
      const provider = await AuthStorage.getCustomProvider("nonexistent");
      expect(provider).toBeUndefined();
    });

    it("returns undefined when auth file doesn't exist", async () => {
      const provider = await AuthStorage.getCustomProvider("test");
      expect(provider).toBeUndefined();
    });

    it("ignores non-custom entries with matching key pattern", async () => {
      // Manually write a non-custom entry under custom: key
      const authFile = (AuthStorage as any).AUTH_FILE;
      await fs.mkdir(path.dirname(authFile), { recursive: true });
      await fs.writeFile(authFile, JSON.stringify({
        "custom:fake": { type: "api", key: "sk-test" },
      }));

      const provider = await AuthStorage.getCustomProvider("fake");
      expect(provider).toBeUndefined();
    });
  });

  describe("getCustomProviders", () => {
    it("returns empty object when no custom providers", async () => {
      const providers = await AuthStorage.getCustomProviders();
      expect(Object.keys(providers)).toHaveLength(0);
    });

    it("returns all custom providers", async () => {
      await AuthStorage.setCustomProvider("ollama", {
        baseURL: "http://localhost:11434/v1",
      });
      await AuthStorage.setCustomProvider("lmstudio", {
        baseURL: "http://localhost:1234/v1",
        key: "lm-key",
      });

      const providers = await AuthStorage.getCustomProviders();
      expect(Object.keys(providers)).toHaveLength(2);
      expect(providers["ollama"].baseURL).toBe("http://localhost:11434/v1");
      expect(providers["lmstudio"].baseURL).toBe("http://localhost:1234/v1");
    });

    it("excludes non-custom entries", async () => {
      await AuthStorage.setCustomProvider("mylocal", {
        baseURL: "http://localhost/v1",
      });
      // Also store a regular API key
      await AuthStorage.setApiKey("openai", { type: "api", key: "sk-test" });

      const providers = await AuthStorage.getCustomProviders();
      expect(Object.keys(providers)).toHaveLength(1);
      expect(providers["mylocal"]).toBeDefined();
    });
  });

  describe("removeCustomProvider", () => {
    it("removes an existing custom provider and returns true", async () => {
      await AuthStorage.setCustomProvider("removeme", {
        baseURL: "http://localhost/v1",
      });

      const removed = await AuthStorage.removeCustomProvider("removeme");
      expect(removed).toBe(true);

      const provider = await AuthStorage.getCustomProvider("removeme");
      expect(provider).toBeUndefined();
    });

    it("returns false when provider doesn't exist", async () => {
      // Need at least an empty auth file
      await AuthStorage.setCustomProvider("other", { baseURL: "http://x" });
      const removed = await AuthStorage.removeCustomProvider("nonexistent");
      expect(removed).toBe(false);
    });

    it("does not affect other providers", async () => {
      await AuthStorage.setCustomProvider("keep", { baseURL: "http://keep/v1" });
      await AuthStorage.setCustomProvider("remove", { baseURL: "http://remove/v1" });

      await AuthStorage.removeCustomProvider("remove");

      const kept = await AuthStorage.getCustomProvider("keep");
      expect(kept).toBeDefined();
      expect(kept!.baseURL).toBe("http://keep/v1");
    });
  });
});
